import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, get, patch, post } from '../../api/client';
import { Badge, EmptyState, ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { useChannels } from './ChannelsPage';

export default function ImportProfilesPage() {
  const [sp] = useSearchParams();
  const channelId = sp.get('channelId') ?? '';
  const profiles = useQuery({
    queryKey: ['import-profiles', channelId],
    queryFn: () => get<{ items: any[] }>(`/import-profiles${channelId ? `?channelId=${channelId}` : ''}`),
  });
  return (
    <div className="card">
      <div className="card-header">
        <h2>Import Profile（CSV 列マッピング）</h2>
        <div className="actions">
          <Link className="btn btn-primary btn-sm" to={`/settings/import-profiles/new${channelId ? `?channelId=${channelId}` : ''}`}>
            新規作成
          </Link>
        </div>
      </div>
      <ErrorBox error={profiles.error} />
      {profiles.isLoading ? (
        <Loading />
      ) : profiles.data?.items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>チャネル</th>
                <th>文字コード</th>
                <th>日付書式</th>
                <th>版</th>
                <th>更新</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name} {!p.active && <Badge>無効</Badge>}
                  </td>
                  <td>{p.channelName}</td>
                  <td>{p.encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'}</td>
                  <td className="mono small">{p.dateFormat}</td>
                  <td>v{p.version}</td>
                  <td className="small">{fmtDateTime(p.updatedAt)}</td>
                  <td>
                    <Link className="btn btn-sm" to={`/settings/import-profiles/${p.id}`}>
                      編集
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Import Profile がありません">
          チャネルごとに CSV の列と CommerceOps の項目を対応付けます。サンプル CSV をアップロードすると列名から候補を提案します。
        </EmptyState>
      )}
    </div>
  );
}

type Transform = { op: string; [k: string]: any };
type FieldMap = { source?: { column?: string; index?: number; columns?: string[]; separator?: string }; fixed?: string; transforms: Transform[]; dateFormat?: string };

interface Meta {
  fields: { key: string; label: string; level: string; type: string; required?: 'fatal' | 'validation' }[];
  transforms: { op: string; label: string; params?: string[] }[];
  dateFormats: string[];
  standardTemplate: Record<string, FieldMap>;
}

export function ImportProfileEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useChannels();
  const meta = useQuery({ queryKey: ['import-meta'], queryFn: () => get<Meta>('/import-profiles/meta') });
  const existing = useQuery({ queryKey: ['import-profile', id], queryFn: () => get(`/import-profiles/${id}`), enabled: !isNew });
  const [p, setP] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<any>(null);
  const [test, setTest] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (!isNew && existing.data) setP(structuredClone(existing.data));
    if (isNew && !p && meta.data)
      setP({
        channelId: sp.get('channelId') ?? '',
        name: '',
        encoding: 'utf-8',
        delimiter: ',',
        hasHeader: true,
        skipRows: 0,
        dateFormat: 'yyyy-MM-dd HH:mm:ss',
        timezone: 'Asia/Tokyo',
        invalidPolicy: 'import_as_validation_required',
        active: true,
        mapping: {},
      });
  }, [isNew, existing.data, meta.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const headers: string[] = useMemo(() => inspect?.headers ?? [], [inspect]);
  if (!meta.data || !p) return <Loading />;

  const setMap = (key: string, m: FieldMap | undefined) => {
    const mapping = { ...p.mapping };
    if (m) mapping[key] = m;
    else delete mapping[key];
    setP({ ...p, mapping });
  };

  const profileBody = () => ({
    channelId: p.channelId,
    name: p.name,
    encoding: p.encoding,
    delimiter: p.delimiter,
    hasHeader: p.hasHeader,
    skipRows: Number(p.skipRows),
    dateFormat: p.dateFormat,
    timezone: p.timezone,
    mapping: p.mapping,
    invalidPolicy: p.invalidPolicy,
    active: p.active,
  });

  const runInspect = async (f: File) => {
    setErr(null);
    const fd = new FormData();
    fd.append('encoding', p.encoding);
    fd.append('delimiter', p.delimiter === '\t' ? 'tab' : ',');
    fd.append('hasHeader', String(p.hasHeader));
    fd.append('skipRows', String(p.skipRows));
    fd.append('file', f);
    try {
      setInspect(await api('/import-profiles/inspect', { method: 'POST', body: fd }));
    } catch (e) {
      setErr(e);
      setInspect(null);
    }
  };

  const runTest = async () => {
    if (!file) return;
    setErr(null);
    const fd = new FormData();
    fd.append('profile', JSON.stringify(profileBody()));
    fd.append('file', file);
    try {
      setTest(await api('/import-profiles/test', { method: 'POST', body: fd }));
    } catch (e) {
      setErr(e);
      setTest(null);
    }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/settings/import-profiles">← 一覧へ</Link>
      </div>
      <ErrorBox error={err ?? existing.error} />
      <div className="card">
        <h2>{isNew ? 'Import Profile を作成' : `Import Profile を編集（v${p.version}）`}</h2>
        <div className="inline-fields">
          <Field label="販売チャネル" htmlFor="pf-ch">
            <select id="pf-ch" value={p.channelId} onChange={(e) => setP({ ...p, channelId: e.target.value })}>
              <option value="">選択してください</option>
              {channels.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="プロファイル名" htmlFor="pf-name">
            <input id="pf-name" type="text" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} maxLength={100} />
          </Field>
        </div>
        <div className="inline-fields">
          <Field label="文字コード" htmlFor="pf-enc" hint="Shift_JIS は Windows の拡張文字（CP932）を含みます">
            <select id="pf-enc" value={p.encoding} onChange={(e) => setP({ ...p, encoding: e.target.value })}>
              <option value="utf-8">UTF-8（BOM 有無どちらも可）</option>
              <option value="shift_jis">Shift_JIS（CP932）</option>
            </select>
          </Field>
          <Field label="区切り文字" htmlFor="pf-delim">
            <select id="pf-delim" value={p.delimiter} onChange={(e) => setP({ ...p, delimiter: e.target.value })}>
              <option value=",">カンマ（CSV）</option>
              <option value={'\t'}>タブ（TSV）</option>
            </select>
          </Field>
          <Field label="先頭の読み飛ばし行数" htmlFor="pf-skip">
            <input id="pf-skip" type="number" min={0} max={20} value={p.skipRows} onChange={(e) => setP({ ...p, skipRows: e.target.value })} />
          </Field>
          <Field label="ヘッダー行" htmlFor="pf-header">
            <select id="pf-header" value={String(p.hasHeader)} onChange={(e) => setP({ ...p, hasHeader: e.target.value === 'true' })}>
              <option value="true">あり（列名で指定）</option>
              <option value="false">なし（列番号で指定）</option>
            </select>
          </Field>
        </div>
        <div className="inline-fields">
          <Field label="日付書式" htmlFor="pf-date" hint="yyyy 年 / MM・M 月 / dd・d 日 / HH・H 時 / mm 分 / ss 秒。ISO 8601 は「ISO」">
            <input id="pf-date" type="text" list="date-formats" value={p.dateFormat} onChange={(e) => setP({ ...p, dateFormat: e.target.value })} />
            <datalist id="date-formats">
              {meta.data.dateFormats.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
          <Field label="日時のタイムゾーン" htmlFor="pf-tz">
            <input id="pf-tz" type="text" value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })} />
          </Field>
          <Field label="検証エラーのある注文" htmlFor="pf-policy">
            <select id="pf-policy" value={p.invalidPolicy} onChange={(e) => setP({ ...p, invalidPolicy: e.target.value })}>
              <option value="import_as_validation_required">「要確認」として取り込む（住所不備・未登録SKU等）</option>
              <option value="skip">取り込まない</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>サンプル CSV で確認</h2>
        </div>
        <div className="row">
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            aria-label="サンプルCSV"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setTest(null);
              if (f) void runInspect(f);
            }}
          />
          {inspect && (
            <button
              className="btn btn-sm"
              onClick={() => {
                const mapping = { ...inspect.suggestedMapping, ...p.mapping };
                setP({ ...p, mapping });
                toast.info(`${Object.keys(inspect.matched).length}項目の候補を反映しました（既存の設定は保持）`);
              }}
            >
              列名から候補を反映
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() => {
              setP({ ...p, mapping: structuredClone(meta.data!.standardTemplate) });
              toast.info('標準テンプレート（注文CSVテンプレート）の対応を反映しました');
            }}
          >
            標準テンプレートを適用
          </button>
          <button className="btn btn-sm btn-primary" disabled={!file} onClick={() => void runTest()}>
            変換結果を確認
          </button>
        </div>
        {inspect && (
          <div style={{ marginTop: 12 }}>
            <p className="small">
              {inspect.filename}: {inspect.rowCount}行 / {inspect.headers.length}列 / BOM {inspect.encodingInfo.hadBom ? 'あり' : 'なし'}
              {!inspect.encodingInfo.utf8Valid && p.encoding === 'utf-8' && <Badge tone="danger">UTF-8 ではありません（Shift_JIS を選択）</Badge>}
            </p>
            <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    {inspect.headers.map((h: string, i: number) => (
                      <th key={i}>
                        {h}
                        <div className="muted small">#{i}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inspect.sampleRows.map((r: string[], i: number) => (
                    <tr key={i}>
                      {inspect.headers.map((_: string, j: number) => (
                        <td key={j} className="small">
                          {r[j]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {test && <TestResult test={test} fields={meta.data.fields} />}
      </div>

      <div className="card">
        <h2>列マッピング</h2>
        <p className="muted small">
          変換は安全な操作のみ（前後空白除去・全角→半角・文字除去・文字列置換・対応表など）。正規表現やプログラムは使えません。
          <Badge tone="danger">必須</Badge> は欠けると取込不可、<Badge tone="warning">要確認</Badge> は欠けると「要確認」になります。
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 180 }}>項目</th>
                <th style={{ width: 150 }}>取得方法</th>
                <th>列 / 値</th>
                <th>変換</th>
              </tr>
            </thead>
            <tbody>
              {meta.data.fields.map((f) => (
                <MappingRow key={f.key} field={f} value={p.mapping[f.key]} headers={headers} hasHeader={p.hasHeader} transforms={meta.data!.transforms} onChange={(m) => setMap(f.key, m)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row">
        <button
          className="btn btn-primary"
          onClick={async () => {
            setErr(null);
            try {
              if (isNew) {
                const r = await post('/import-profiles', profileBody());
                toast.success('作成しました');
                nav(`/settings/import-profiles/${r.id}`, { replace: true });
              } else {
                await patch(`/import-profiles/${id}`, profileBody());
                toast.success('保存しました（版が上がりました）');
                await qc.invalidateQueries({ queryKey: ['import-profile', id] });
              }
              await qc.invalidateQueries({ queryKey: ['import-profiles'] });
            } catch (e) {
              setErr(e);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }}
        >
          保存
        </button>
        <label className="check">
          <input type="checkbox" checked={p.active} onChange={(e) => setP({ ...p, active: e.target.checked })} /> 有効
        </label>
      </div>
    </>
  );
}

function MappingRow({
  field,
  value,
  headers,
  hasHeader,
  transforms,
  onChange,
}: {
  field: Meta['fields'][number];
  value: FieldMap | undefined;
  headers: string[];
  hasHeader: boolean;
  transforms: Meta['transforms'];
  onChange: (m: FieldMap | undefined) => void;
}) {
  const mode = !value ? 'none' : value.fixed !== undefined && !value.source ? 'fixed' : value.source?.columns ? 'concat' : value.source?.index !== undefined ? 'index' : 'column';
  const tfs = value?.transforms ?? [];
  const setMode = (m: string) => {
    if (m === 'none') return onChange(undefined);
    if (m === 'fixed') return onChange({ fixed: '', transforms: tfs });
    if (m === 'index') return onChange({ source: { index: 0 }, transforms: tfs });
    if (m === 'concat') return onChange({ source: { columns: [headers[0] ?? ''], separator: ' ' }, transforms: tfs });
    return onChange({ source: { column: headers[0] ?? '' }, transforms: tfs });
  };
  return (
    <tr>
      <td>
        <strong>{field.label}</strong>
        <div>
          {field.required === 'fatal' && <Badge tone="danger">必須</Badge>}
          {field.required === 'validation' && <Badge tone="warning">要確認</Badge>}
          <span className="muted small"> {field.level === 'line' ? '明細' : '注文'}</span>
        </div>
      </td>
      <td>
        <select aria-label={`${field.label} の取得方法`} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="none">使わない</option>
          {hasHeader && <option value="column">列名</option>}
          <option value="index">列番号</option>
          {hasHeader && <option value="concat">複数列を連結</option>}
          <option value="fixed">固定値</option>
        </select>
      </td>
      <td>
        {mode === 'column' && (
          <input
            type="text"
            list="csv-headers"
            aria-label={`${field.label} の列名`}
            value={value?.source?.column ?? ''}
            onChange={(e) => onChange({ ...value!, source: { column: e.target.value } })}
          />
        )}
        {mode === 'index' && (
          <input
            type="number"
            min={0}
            aria-label={`${field.label} の列番号`}
            value={value?.source?.index ?? 0}
            onChange={(e) => onChange({ ...value!, source: { index: Number(e.target.value) } })}
          />
        )}
        {mode === 'concat' && (
          <div className="row">
            <input
              type="text"
              aria-label={`${field.label} の列名（カンマ区切り）`}
              value={(value?.source?.columns ?? []).join(',')}
              onChange={(e) => onChange({ ...value!, source: { columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5), separator: value?.source?.separator ?? ' ' } })}
              placeholder="住所1,住所2"
            />
            <input
              type="text"
              aria-label="区切り"
              style={{ width: 70 }}
              value={value?.source?.separator ?? ' '}
              onChange={(e) => onChange({ ...value!, source: { ...value!.source, separator: e.target.value } })}
            />
          </div>
        )}
        {mode === 'fixed' && (
          <input type="text" aria-label={`${field.label} の固定値`} value={value?.fixed ?? ''} onChange={(e) => onChange({ ...value!, fixed: e.target.value })} />
        )}
        <datalist id="csv-headers">
          {headers.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
      </td>
      <td>
        {value && (
          <TransformEditor
            value={tfs}
            transforms={transforms}
            onChange={(t) => onChange({ ...value, transforms: t })}
          />
        )}
      </td>
    </tr>
  );
}

function TransformEditor({ value, transforms, onChange }: { value: Transform[]; transforms: Meta['transforms']; onChange: (t: Transform[]) => void }) {
  const label = (op: string) => transforms.find((t) => t.op === op)?.label ?? op;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {value.map((t, i) => (
        <div key={i} className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <Badge tone="info">{label(t.op)}</Badge>
          {t.op === 'removeChars' && <input type="text" aria-label="除去する文字" value={t.chars ?? ''} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, chars: e.target.value } : x)))} style={{ width: 90 }} />}
          {t.op === 'replace' && (
            <>
              <input type="text" aria-label="置換前" value={t.from ?? ''} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} style={{ width: 80 }} />→
              <input type="text" aria-label="置換後" value={t.to ?? ''} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} style={{ width: 80 }} />
            </>
          )}
          {t.op === 'emptyAs' && <input type="text" aria-label="空欄時の値" value={t.value ?? ''} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ width: 110 }} />}
          {t.op === 'truncate' && <input type="number" aria-label="文字数" value={t.length ?? 100} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, length: Number(e.target.value) } : x)))} style={{ width: 80 }} />}
          {t.op === 'map' && (
            <input
              type="text"
              aria-label="対応表（元=先 をカンマ区切り）"
              placeholder="ネコポス=nekopos, 宅急便=yamato"
              defaultValue={Object.entries(t.table ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}
              onBlur={(e) => {
                const table: Record<string, string> = {};
                e.target.value.split(',').forEach((pair) => {
                  const [k, ...rest] = pair.split('=');
                  if (k?.trim()) table[k.trim()] = rest.join('=').trim();
                });
                onChange(value.map((x, j) => (j === i ? { ...x, table } : x)));
              }}
              style={{ width: 200 }}
            />
          )}
          <button className="btn btn-ghost btn-sm" aria-label="変換を削除" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <select
        aria-label="変換を追加"
        value=""
        onChange={(e) => {
          const op = e.target.value;
          if (!op) return;
          const init: Transform = { op };
          if (op === 'removeChars') init.chars = ',';
          if (op === 'replace') Object.assign(init, { from: '', to: '' });
          if (op === 'emptyAs') init.value = '';
          if (op === 'truncate') init.length = 100;
          if (op === 'map') init.table = {};
          onChange([...value, init]);
        }}
        style={{ maxWidth: 200 }}
      >
        <option value="">＋ 変換を追加</option>
        {transforms.map((t) => (
          <option key={t.op} value={t.op}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TestResult({ test, fields }: { test: any; fields: Meta['fields'] }) {
  const shown = fields.filter((f) => test.rows.some((r: any) => r.values[f.key] !== null && r.values[f.key] !== undefined && r.values[f.key] !== false));
  return (
    <div style={{ marginTop: 12 }}>
      {test.columnProblems.length > 0 && (
        <div className="alert danger">
          {test.columnProblems.map((p: string) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      <p className="small">先頭 {test.rows.length} 行の変換結果（全 {test.rowCount} 行）</p>
      <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>行</th>
              {shown.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th>問題</th>
            </tr>
          </thead>
          <tbody>
            {test.rows.map((r: any) => (
              <tr key={r.line}>
                <td>{r.line}</td>
                {shown.map((f) => (
                  <td key={f.key} className="small">
                    {r.values[f.key] === null || r.values[f.key] === undefined ? '' : f.type === 'datetime' ? fmtDateTime(r.values[f.key]) : String(r.values[f.key])}
                  </td>
                ))}
                <td className="small">
                  {r.issues.map((i: any, k: number) => (
                    <div key={k}>
                      <Badge tone={i.severity === 'fatal' ? 'danger' : i.severity === 'validation' ? 'warning' : ''}>{i.severity === 'fatal' ? '取込不可' : i.severity === 'validation' ? '要確認' : '注意'}</Badge> {i.message}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
