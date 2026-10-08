import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { get } from '../../api/client';
import { Badge, ErrorBox, Field } from '../../components/ui';
import { fmtNum } from '../../lib/format';
import {
  buildTable,
  classifySelectedFiles,
  columnLabel,
  CsvError,
  decodeCsvBytes,
  filterItems,
  getExtension,
  guessIdColumn,
  guessImageColumn,
  isSupportedImageName,
  productsToRows,
  resultCsvRows,
  runMatch,
  sanitizeFileName,
  STATUS,
  STATUS_ORDER,
  tableToRows,
  toCsvText,
  todayString,
  type CsvEncodingMode,
  type CsvTable,
  type ImageFileRef,
  type MatchFormat,
  type MatchOptions,
  type MatchResult,
  type MatchRow,
  type Status,
} from '../../lib/imageCheck';

/**
 * CommerceOps 商品画像チェック（ADR-041。#006「商品CSV × 商品画像 照合ツール」の統合）
 * 商品 CSV の画像列、または登録済み商品の画像 URL のファイル名と、選択した画像ファイルの名前を照合する。
 * CSV・画像はブラウザの中だけで読み、サーバーへ送信しない（画像は名前だけを使い中身は読まない）。データは変更しない。
 */

const MAX_DISPLAY_ROWS = 2000;
const MAX_CSV_BYTES = 30 * 1024 * 1024;
const RECOMMENDED_ROWS = 1000;
const RECOMMENDED_IMAGES = 500;
const PAGE = 200;

const TONE: Record<Status, 'success' | 'danger' | 'info' | 'warning' | 'primary' | ''> = {
  [STATUS.OK]: 'success',
  [STATUS.MISSING]: 'danger',
  [STATUS.UNUSED]: 'info',
  [STATUS.DUPLICATE]: 'warning',
  [STATUS.MULTIPLE]: 'primary',
  [STATUS.EMPTY]: '',
};

type Msg = { tone: 'info' | 'success' | 'warning' | 'danger'; text: string };
type Source = 'csv' | 'master';

interface CsvState {
  file: File;
  table: CsvTable;
  encodingLabel: string;
  imageCol: number;
  idCol: number;
}

interface MasterState {
  rows: MatchRow[];
  total: number;
  withImage: number;
  activeFilter: string;
}

interface ImageState {
  images: ImageFileRef[];
  excluded: string[];
  systemFiles: string[];
  sourceLabel: string;
}

function Messages({ items }: { items: Msg[] }) {
  return (
    <>
      {items.map((m, i) => (
        <div key={i} className={`alert ${m.tone}`} role={m.tone === 'danger' ? 'alert' : undefined}>
          {m.text}
        </div>
      ))}
    </>
  );
}

function downloadCsv(fileName: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export default function ProductImageCheckPage() {
  const [source, setSource] = useState<Source>('csv');
  // CSV
  const [csvState, setCsvState] = useState<CsvState | null>(null);
  const [encoding, setEncoding] = useState<CsvEncodingMode>('auto');
  const [csvMsgs, setCsvMsgs] = useState<Msg[]>([]);
  // 商品マスタ
  const [master, setMaster] = useState<MasterState | null>(null);
  const [masterActive, setMasterActive] = useState('true');
  const [masterLoading, setMasterLoading] = useState(false);
  const [masterErr, setMasterErr] = useState<unknown>(null);
  // 画像
  const [images, setImages] = useState<ImageState | null>(null);
  const [imageMsgs, setImageMsgs] = useState<Msg[]>([]);
  const [inputKey, setInputKey] = useState(0);
  // 比較設定・結果
  const [opts, setOpts] = useState<MatchOptions>({ caseMode: 'ignore', ignoreExtension: false, ignorePath: true });
  const [result, setResult] = useState<{ res: MatchResult; source: Source } | null>(null);
  const [checkMsgs, setCheckMsgs] = useState<Msg[]>([]);
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [search, setSearch] = useState('');
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null);

  const invalidate = () => {
    setResult(null);
    setSaveMsg(null);
  };

  /* ---------- 照合対象: CSV ---------- */
  const loadCsv = async (file: File, mode: CsvEncodingMode) => {
    const msgs: Msg[] = [];
    invalidate();
    setCheckMsgs([]);
    if (file.size > MAX_CSV_BYTES) {
      setCsvState(null);
      setCsvMsgs([{ tone: 'danger', text: 'CSVファイルが大きすぎます（30MBまで）。' }]);
      return;
    }
    try {
      const decoded = decodeCsvBytes(await file.arrayBuffer(), mode);
      const table = buildTable(decoded.text);
      if (!/\.(csv|txt)$/i.test(file.name))
        msgs.push({ tone: 'warning', text: '拡張子が .csv ではないファイルです。内容がCSV形式であることを確認してください。' });
      if (decoded.usedFallback)
        msgs.push({ tone: 'warning', text: 'UTF-8として読めなかったため、Shift_JISとして読み込みました。列名や値が文字化けしていないか確認してください。' });
      if (table.headers.length === 1 && /[;\t]/.test(table.headers[0]!))
        msgs.push({
          tone: 'warning',
          text: '列が1つしか見つかりません。区切り文字がカンマ（,）ではない可能性があります（タブ区切り・セミコロン区切りは未対応です）。',
        });
      if (table.headers.some((h) => isSupportedImageName(h)))
        msgs.push({ tone: 'warning', text: '1行目に画像ファイル名のような値があります。1行目はヘッダー（列名）として扱われ、照合されません。' });
      if (table.longRows > 0) msgs.push({ tone: 'warning', text: `ヘッダーより列の多い行が${fmtNum(table.longRows)}行あります。はみ出した列は使用しません。` });
      if (table.rows.length > RECOMMENDED_ROWS)
        msgs.push({ tone: 'warning', text: `データ行が${fmtNum(RECOMMENDED_ROWS)}行を超えています。照合はできますが、表示に時間がかかる場合があります。` });
      const imageCol = guessImageColumn(table.headers, table.rows);
      const idCol = guessIdColumn(table.headers, imageCol);
      msgs.push(
        imageCol >= 0
          ? { tone: 'info', text: `列名や内容から「${columnLabel(table.headers, imageCol)}」を画像列として仮選択しました。正しいか確認してください。` }
          : { tone: 'warning', text: '画像ファイル名の列を選択してください。' },
      );
      setCsvState({ file, table, encodingLabel: decoded.encodingLabel, imageCol, idCol });
      setCsvMsgs(msgs);
    } catch (e) {
      setCsvState(null);
      setCsvMsgs([{ tone: 'danger', text: e instanceof CsvError ? e.userMessage : 'CSVを読み込めませんでした。ファイルを確認してください。' }]);
    }
  };

  /* ---------- 照合対象: 商品マスタ ---------- */
  const loadMaster = async () => {
    setMasterErr(null);
    setMasterLoading(true);
    invalidate();
    try {
      const all: { sku: string; imageUrl: string | null }[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await get<{ items: { sku: string; imageUrl: string | null }[]; total: number }>(
          `/products?limit=${PAGE}&offset=${offset}&active=${masterActive}`,
        );
        all.push(...page.items);
        if (page.items.length < PAGE || all.length >= page.total) break;
      }
      setMaster({
        rows: productsToRows(all),
        total: all.length,
        withImage: all.filter((p) => (p.imageUrl ?? '').trim() !== '').length,
        activeFilter: masterActive,
      });
    } catch (e) {
      setMaster(null);
      setMasterErr(e);
    } finally {
      setMasterLoading(false);
    }
  };

  /* ---------- 画像 ---------- */
  const onImagesSelected = (list: FileList | null, sourceLabel: string) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return; // キャンセル時は前回の選択を維持
    const c = classifySelectedFiles(files);
    const msgs: Msg[] = [];
    if (c.images.length === 0) {
      msgs.push({ tone: 'danger', text: '選択されたファイルの中に、対応形式の画像（JPG / JPEG / PNG / WEBP）がありません。画像ファイルを選択してください。' });
    } else {
      if (c.excluded.length > 0)
        msgs.push({
          tone: 'warning',
          text: `対応形式ではないファイルが${fmtNum(c.excluded.length)}件あったため、照合から除外しました（例：${c.excluded.slice(0, 5).join('、')}${c.excluded.length > 5 ? ' ほか' : ''}）。`,
        });
      if (c.systemFiles.length > 0)
        msgs.push({
          tone: 'warning',
          text: `macOSの管理用ファイル（._ で始まるファイル、__MACOSX フォルダ内）${fmtNum(c.systemFiles.length)}件は画像ではないため除外しました。`,
        });
      if (c.images.length > RECOMMENDED_IMAGES)
        msgs.push({ tone: 'warning', text: `画像が${fmtNum(RECOMMENDED_IMAGES)}件を超えています。照合はできますが、表示に時間がかかる場合があります。` });
    }
    setImages({ ...c, sourceLabel });
    setImageMsgs(msgs);
    invalidate();
  };

  const clearImages = () => {
    setImages(null);
    setImageMsgs([]);
    setInputKey((k) => k + 1);
    invalidate();
  };

  const imageBreakdown = useMemo(() => {
    if (!images) return '';
    const count: Record<string, number> = {};
    for (const f of images.images) {
      const ext = getExtension(f.name);
      count[ext] = (count[ext] ?? 0) + 1;
    }
    return Object.keys(count)
      .sort()
      .map((k) => `${k.toUpperCase()} ${fmtNum(count[k])}件`)
      .join(' / ');
  }, [images]);

  /* ---------- チェック ---------- */
  const runCheck = (o: MatchOptions, silent = false) => {
    const errors: string[] = [];
    if (source === 'csv') {
      if (!csvState) errors.push('CSVが選択されていません。商品CSVを選択してください。');
      else if (csvState.imageCol < 0) errors.push('画像ファイル名の列が選択されていません。画像列を選択してください。');
    } else if (!master) {
      errors.push('商品マスタが読み込まれていません。「商品マスタを読み込む」を押してください。');
    }
    if (!images || images.images.length === 0) errors.push('商品画像が選択されていません。画像ファイルまたはフォルダを選択してください。');
    if (errors.length > 0) {
      setResult(null);
      setCheckMsgs(errors.map((text) => ({ tone: 'danger', text })));
      return;
    }
    try {
      let res: MatchResult;
      if (source === 'csv') {
        res = runMatch(tableToRows(csvState!.table, csvState!.imageCol, csvState!.idCol), images!.images, o);
      } else {
        const skuOf = new Map(master!.rows.map((r) => [r.rowNumber, String(r.id ?? '')]));
        const format: MatchFormat = {
          rowLabel: (n) => `SKU ${skuOf.get(n) ?? n}`,
          rowUnit: '商品',
          unusedDetail: '商品マスタのどの商品でも使われていない画像です。',
        };
        res = runMatch(master!.rows, images!.images, o, format);
      }
      setResult({ res, source });
      setSaveMsg(null);
      if (!silent) setFilter('all');
      setCheckMsgs([
        { tone: 'success', text: silent ? '比較設定が変わったため、結果を更新しました。' : 'チェックが完了しました。下の結果を確認してください。' },
      ]);
    } catch {
      setResult(null);
      setCheckMsgs([{ tone: 'danger', text: '照合中に問題が発生しました。CSVと画像を選び直してもう一度お試しください。' }]);
    }
  };

  const changeOpts = (o: MatchOptions) => {
    setOpts(o);
    if (result) runCheck(o, true); // 設定を変えると結果を自動で更新（元ツールと同じ）
  };

  const filtered = useMemo(() => (result ? filterItems(result.res.items, filter, search) : []), [result, filter, search]);

  const save = (problemsOnly: boolean) => {
    if (!result) {
      setSaveMsg({ tone: 'danger', text: '保存する結果がありません。先に「チェックする」を押してください。' });
      return;
    }
    const header = result.source === 'csv' ? ['CSV行番号', '識別値', '画像ファイル名', '判定', '詳細'] : ['No.', 'SKU', '画像（image_url）', '判定', '詳細'];
    const rows = resultCsvRows(result.res.items, problemsOnly, header);
    const base = (result.source === 'csv' ? 'image_check_csv_' : 'image_check_master_') + (problemsOnly ? 'problems_' : '');
    const fileName = sanitizeFileName(`${base}${todayString()}.csv`);
    downloadCsv(fileName, toCsvText(rows));
    setSaveMsg({
      tone: 'success',
      text:
        problemsOnly && rows.length === 1
          ? `正常以外の結果はありませんでした。見出し行だけの「${fileName}」をダウンロードしました。`
          : `「${fileName}」（${fmtNum(rows.length - 1)}件）をダウンロードしました。`,
    });
  };

  const isCsv = result?.source === 'csv';

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <h2>CommerceOps 商品画像チェック</h2>
          <div className="actions">
            <Link className="btn btn-sm" to="/inventory/products">
              商品一覧へ戻る
            </Link>
          </div>
        </div>
        <p className="small">
          商品CSVの画像ファイル名（または登録済み商品の画像URLのファイル名）と、手元の画像ファイルの名前を照合し、
          正常／画像不足／未使用画像／CSV内重複／複数候補／画像指定なし に分けて表示します。商品CSVを取り込む前の確認にお使いください。
        </p>
        <div className="alert info">
          CSV・画像ファイルはサーバーへ送信しません。照合はこのブラウザの中だけで行い、画像はファイル名だけを使います（中身は読み込みません）。
          CSV・画像・商品データを変更することはありません。
        </div>
      </div>

      <section className="card" aria-labelledby="ic-step1">
        <h3 id="ic-step1">1. 照合対象</h3>
        <div className="row" role="radiogroup" aria-label="照合対象" style={{ marginBottom: 12 }}>
          <label className="check">
            <input
              type="radio"
              name="ic-source"
              checked={source === 'csv'}
              onChange={() => {
                setSource('csv');
                invalidate();
                setCheckMsgs([]);
              }}
            />{' '}
            商品CSV（取込前の確認）
          </label>
          <label className="check">
            <input
              type="radio"
              name="ic-source"
              checked={source === 'master'}
              onChange={() => {
                setSource('master');
                invalidate();
                setCheckMsgs([]);
              }}
            />{' '}
            登録済みの商品マスタ
          </label>
        </div>
        {source === 'csv' ? (
          <>
            <div className="inline-fields">
              <Field label="商品CSV" htmlFor="ic-csv" hint="1行目は列名（ヘッダー）。商品CSV取込のテンプレート（image_url 列）以外の形式も使えます">
                <input
                  id="ic-csv"
                  type="file"
                  accept=".csv,.txt,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void loadCsv(f, encoding);
                  }}
                />
              </Field>
              <Field label="文字コード" htmlFor="ic-enc">
                <select
                  id="ic-enc"
                  value={encoding}
                  onChange={(e) => {
                    const m = e.target.value as CsvEncodingMode;
                    setEncoding(m);
                    if (csvState) void loadCsv(csvState.file, m);
                  }}
                >
                  <option value="auto">UTF-8（読めない場合はShift_JIS）</option>
                  <option value="utf-8">UTF-8</option>
                  <option value="shift_jis">Shift_JIS</option>
                </select>
              </Field>
            </div>
            <Messages items={csvMsgs} />
            {csvState && (
              <>
                <ul className="small" data-testid="ic-csv-info">
                  <li>ファイル：{csvState.file.name}</li>
                  <li>文字コード：{csvState.encodingLabel}</li>
                  <li>データ行数：{fmtNum(csvState.table.rows.length)}行（ヘッダー行を除く）</li>
                  {csvState.table.blankRows > 0 && <li>空行：{fmtNum(csvState.table.blankRows)}行（照合対象外。行番号は数えています）</li>}
                </ul>
                <div className="inline-fields">
                  <Field label="画像列（必須）" htmlFor="ic-image-col">
                    <select
                      id="ic-image-col"
                      value={String(csvState.imageCol)}
                      onChange={(e) => {
                        setCsvState({ ...csvState, imageCol: Number(e.target.value) });
                        invalidate();
                      }}
                    >
                      <option value="-1">（選択してください）</option>
                      {csvState.table.headers.map((_, i) => (
                        <option key={i} value={i}>
                          {columnLabel(csvState.table.headers, i)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="識別列（任意）" htmlFor="ic-id-col" hint="SKU・商品コードなど、結果でどの商品かを見分ける列">
                    <select
                      id="ic-id-col"
                      value={String(csvState.idCol)}
                      onChange={(e) => {
                        setCsvState({ ...csvState, idCol: Number(e.target.value) });
                        invalidate();
                      }}
                    >
                      <option value="-1">（指定しない）</option>
                      {csvState.table.headers.map((_, i) => (
                        <option key={i} value={i}>
                          {columnLabel(csvState.table.headers, i)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="small muted">画像列の値が https:// で始まるURLの場合は、URLのパス部分（? 以降を除く）のファイル名で照合します。</p>
              </>
            )}
          </>
        ) : (
          <>
            <p className="small">
              登録済み商品の「画像URL」の最後のファイル名（例: <code>https://cdn.example.com/p/A001.jpg?v=2</code> → <code>A001.jpg</code>
              ）を、選択した画像ファイルと照合します。 画像URLが空欄の商品は「画像指定なし」になります。
            </p>
            <div className="filters">
              <Field label="対象の商品" htmlFor="ic-master-active">
                <select id="ic-master-active" value={masterActive} onChange={(e) => setMasterActive(e.target.value)}>
                  <option value="true">有効な商品</option>
                  <option value="all">すべて（無効を含む）</option>
                </select>
              </Field>
              <button className="btn" disabled={masterLoading} onClick={() => void loadMaster()}>
                {masterLoading ? '読み込み中…' : '商品マスタを読み込む'}
              </button>
            </div>
            <ErrorBox error={masterErr} />
            {master && (
              <p className="small" data-testid="ic-master-info">
                商品 {fmtNum(master.total)}件（{master.activeFilter === 'true' ? '有効な商品' : '無効を含む'}）を読み込みました。うち画像URLあり{' '}
                {fmtNum(master.withImage)}件。
              </p>
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="ic-step2">
        <h3 id="ic-step2">2. 商品画像（JPG / JPEG / PNG / WEBP）</h3>
        <div className="inline-fields" key={inputKey}>
          <Field label="画像ファイルを選択（複数可）" htmlFor="ic-images">
            <input
              id="ic-images"
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              onChange={(e) => onImagesSelected(e.target.files, 'ファイルを選択')}
            />
          </Field>
          <Field label="フォルダごと選択" htmlFor="ic-folder" hint="サブフォルダの画像も対象になります">
            <input
              id="ic-folder"
              type="file"
              multiple
              ref={(el) => el?.setAttribute('webkitdirectory', '')}
              onChange={(e) => onImagesSelected(e.target.files, 'フォルダごと選択')}
            />
          </Field>
        </div>
        <p className="small muted">
          フォルダ選択時にブラウザが「アップロードしますか？」と表示することがありますが、ブラウザ共通の確認です。実際に送信はしません。
        </p>
        <Messages items={imageMsgs} />
        {images && (
          <div className="row small">
            <span data-testid="ic-image-info">
              照合する画像：{fmtNum(images.images.length)}件{imageBreakdown ? `（${imageBreakdown}）` : ''}／選択方法：{images.sourceLabel}
              {images.excluded.length + images.systemFiles.length > 0 && `／除外したファイル：${fmtNum(images.excluded.length + images.systemFiles.length)}件`}
            </span>
            <button className="btn btn-sm" onClick={clearImages}>
              選択を解除
            </button>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="ic-step3">
        <h3 id="ic-step3">3. 比較設定とチェック</h3>
        <p className="small muted">名前の前後の空白は自動で取り除きます。あいまいな場合（条件に合う画像が2件以上）は「正常」にしません。</p>
        <div className="row" role="radiogroup" aria-label="大文字小文字">
          <label className="check">
            <input type="radio" name="ic-case" checked={opts.caseMode === 'ignore'} onChange={() => changeOpts({ ...opts, caseMode: 'ignore' })} />{' '}
            大文字小文字を無視
          </label>
          <label className="check">
            <input type="radio" name="ic-case" checked={opts.caseMode === 'exact'} onChange={() => changeOpts({ ...opts, caseMode: 'exact' })} /> 完全一致
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={opts.ignoreExtension} onChange={(e) => changeOpts({ ...opts, ignoreExtension: e.target.checked })} />{' '}
          拡張子を無視して照合（
          <code>A001</code> と <code>A001.jpg</code> を同じとみなす）
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.ignorePath} onChange={(e) => changeOpts({ ...opts, ignorePath: e.target.checked })} /> CSV内のパスを無視（
          <code>images/A001.jpg</code> → <code>A001.jpg</code>）
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => runCheck(opts)}>
            チェックする
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <Messages items={checkMsgs} />
        </div>
      </section>

      {result && (
        <section className="card" aria-labelledby="ic-step4">
          <div className="card-header">
            <h3 id="ic-step4">4. 結果</h3>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => save(false)}>
                全結果をCSV保存
              </button>
              <button className="btn btn-sm" onClick={() => save(true)}>
                問題だけCSV保存
              </button>
            </div>
          </div>
          {saveMsg && <Messages items={[saveMsg]} />}
          <p className="small muted">
            {isCsv ? 'CSV' : '商品'} {fmtNum(result.res.summary.csvRows)}件（画像指定あり {fmtNum(result.res.summary.specified)}件）／ 画像{' '}
            {fmtNum(result.res.summary.images)}件。 「CSV内重複」と「画像指定なし」は必ずしもミスではありません（色違いで同じ画像を使う場合など）。
          </p>
          <div className="tiles" data-testid="ic-summary" style={{ marginBottom: 12 }}>
            {STATUS_ORDER.map((st) => (
              <button
                key={st}
                type="button"
                className="tile"
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setFilter(st)}
                aria-label={`${st} ${result.res.summary.counts[st]}件で絞り込む`}
              >
                <div className="label">{st}</div>
                <div className="value" data-status={st}>
                  {fmtNum(result.res.summary.counts[st])}
                </div>
              </button>
            ))}
          </div>
          <div className="filters">
            <div className="row" role="group" aria-label="判定で絞り込み">
              {(['all', ...STATUS_ORDER] as const).map((k) => (
                <button key={k} type="button" className={`chip ${filter === k ? 'active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {k === 'all' ? `すべて ${fmtNum(result.res.items.length)}` : `${k} ${fmtNum(result.res.summary.counts[k])}`}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="ic-search">検索（識別値・画像名）</label>
              <input id="ic-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <p className="small muted" data-testid="ic-count">
            表示中：{fmtNum(Math.min(filtered.length, MAX_DISPLAY_ROWS))}件 ／ 該当：{fmtNum(filtered.length)}件 ／ 全体：{fmtNum(result.res.items.length)}件
            {filtered.length > MAX_DISPLAY_ROWS && `（画面には先頭${fmtNum(MAX_DISPLAY_ROWS)}件まで表示します。CSV保存には全件含まれます）`}
          </p>
          <div className="table-wrap">
            <table className="table" data-testid="ic-result">
              <thead>
                <tr>
                  <th className="num">{isCsv ? 'CSV行番号' : 'No.'}</th>
                  <th>{isCsv ? '識別値' : 'SKU'}</th>
                  <th>{isCsv ? '画像ファイル名' : '画像（image_url）'}</th>
                  <th>判定</th>
                  <th>詳細</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, MAX_DISPLAY_ROWS).map((it, i) => (
                  <tr key={i}>
                    <td className="num">{it.rowNumber ?? ''}</td>
                    <td className="mono">{it.id}</td>
                    <td className="mono small" style={{ wordBreak: 'break-all' }}>
                      {it.image}
                    </td>
                    <td className="nowrap">
                      <Badge tone={TONE[it.status]}>{it.status}</Badge>
                    </td>
                    <td className="small">{it.detail}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      該当する結果はありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
