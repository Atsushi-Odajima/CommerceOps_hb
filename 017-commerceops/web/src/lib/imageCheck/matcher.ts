/**
 * CommerceOps 商品画像チェック — 照合処理（DOM を使わない純粋な処理）
 *
 * 「商品CSV × 商品画像 照合ツール」（#006）の matcher.js を TypeScript へ移植したもの（DECISIONS.md ADR-041）。
 * 最重要原則: 比較条件上「1件だけ確実に対応する」ときだけ「正常」。曖昧なもの（複数候補など）は正常扱いしない。
 * 自動修正・あいまい一致はしない。判定・文言・優先順位は元ツールと同じ。
 */

/** 照合に使う画像の拡張子 */
export const SUPPORTED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'] as const;
/** 「拡張子を無視」ON 時に取り除く拡張子（これ以外の . 以降はファイル名の一部として残す） */
const STRIPPABLE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'jfif']);

export const STATUS = {
  OK: '正常',
  MISSING: '画像不足',
  UNUSED: '未使用画像',
  DUPLICATE: 'CSV内重複',
  MULTIPLE: '複数候補',
  EMPTY: '画像指定なし',
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

/** 画面・CSV で並べる順番 */
export const STATUS_ORDER: Status[] = [STATUS.OK, STATUS.MISSING, STATUS.UNUSED, STATUS.DUPLICATE, STATUS.MULTIPLE, STATUS.EMPTY];

export interface MatchOptions {
  /** 'ignore'（大文字小文字を無視・初期値） | 'exact'（完全一致） */
  caseMode: 'ignore' | 'exact';
  /** 拡張子を無視して照合 */
  ignoreExtension: boolean;
  /** CSV 内のパス（フォルダ部分）を無視 */
  ignorePath: boolean;
}

export const DEFAULT_OPTIONS: Readonly<MatchOptions> = Object.freeze({ caseMode: 'ignore', ignoreExtension: false, ignorePath: true });

export interface MatchRow {
  /** 行番号（CSV はヘッダー=1 の行番号。商品マスタは一覧の通し番号） */
  rowNumber: number;
  /** 識別値（商品コード・SKU 等） */
  id?: string | null;
  /** 照合に使う画像名（パスを含んでよい） */
  image?: string | null;
  /** 結果表に表示する値（省略時は image。URL から取り出した名前で照合し、元の URL を表示する場合に使う） */
  display?: string | null;
}

export interface ImageFileRef {
  name: string;
  /** フォルダ選択時の相対パス（表示用）。省略時は name */
  path?: string;
}

export interface MatchItem {
  rowNumber: number | null;
  id: string;
  image: string;
  status: Status;
  detail: string;
}

export interface MatchSummary {
  csvRows: number;
  specified: number;
  images: number;
  counts: Record<Status, number>;
}

export interface MatchResult {
  items: MatchItem[];
  summary: MatchSummary;
  options: MatchOptions;
}

export interface MatchFormat {
  /** 「CSV内重複」の詳細に出す行の書き方（既定: 「2行目」） */
  rowLabel?: (rowNumber: number) => string;
  /** 「CSV内重複」の詳細で使う単位（既定: 「行」） */
  rowUnit?: string;
  /** 未使用画像の詳細（既定: 「CSVのどの行でも使われていない画像です。」） */
  unusedDetail?: string;
}

/** 拡張子（小文字、ドットなし）。拡張子がなければ '' */
export function getExtension(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  const ext = name.slice(i + 1);
  if (/[\\/]/.test(ext)) return '';
  return ext.toLowerCase();
}

/** パス区切り（/ と \ の両方）の最後の要素 */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function isSupportedImageName(name: string): boolean {
  return (SUPPORTED_IMAGE_EXTS as readonly string[]).includes(getExtension(name));
}

/**
 * 比較用キーを作ります。
 * 1. Unicode NFC 正規化（見た目が同じ濁点などの表現ゆれのみ統一）
 * 2. 前後の空白を除去
 * 3. （CSV 側・パス無視 ON）最後の / または \ より後ろだけを取り出す
 * 4. （拡張子無視 ON）末尾の画像拡張子を除去
 * 5. （大文字小文字無視）小文字に統一
 */
export function makeKey(raw: unknown, opts: MatchOptions, isCsvValue: boolean): string {
  let s = String(raw == null ? '' : raw);
  s = s.normalize('NFC');
  s = s.trim();
  if (isCsvValue && opts.ignorePath) s = baseName(s).trim();
  if (opts.ignoreExtension) {
    const ext = getExtension(s);
    if (ext && STRIPPABLE_EXTS.has(ext)) s = s.slice(0, s.length - ext.length - 1);
  }
  if (opts.caseMode === 'ignore') s = s.toLowerCase();
  return s;
}

function pushToMap<V>(map: Map<string, V[]>, key: string, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function formatRowList(rowNumbers: number[], label: (n: number) => string, unit: string): string {
  const max = 10;
  const shown = rowNumbers.slice(0, max).map(label).join('、');
  return rowNumbers.length > max ? `${shown} ほか${rowNumbers.length - max}${unit}` : shown;
}

function formatFileList(files: { path: string }[]): string {
  const max = 5;
  const shown = files
    .slice(0, max)
    .map((f) => f.path)
    .join('、');
  return files.length > max ? `${shown} ほか${files.length - max}件` : shown;
}

/**
 * 照合を実行します。
 * 判定の優先順位（1 行に複数の事情がある場合）: 画像指定なし ＞ 複数候補 ＞ 画像不足 ＞ CSV内重複 ＞ 正常
 */
export function runMatch(csvRows: MatchRow[], imageFiles: ImageFileRef[], options?: Partial<MatchOptions>, format: MatchFormat = {}): MatchResult {
  const opts: MatchOptions = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  const rowLabel = format.rowLabel ?? ((n: number) => `${n}行目`);
  const rowUnit = format.rowUnit ?? '行';

  // 参考表示用: 大文字小文字だけ／拡張子だけ違う画像を探すための別条件
  const hintCaseOpts: MatchOptions = { ...opts, caseMode: 'ignore' };
  const hintExtOpts: MatchOptions = { ...opts, ignoreExtension: true };
  const wantCaseHint = opts.caseMode === 'exact';
  const wantExtHint = !opts.ignoreExtension;

  // 1) 画像: 比較キー → ファイル一覧
  type F = { name: string; path: string };
  const imageMap = new Map<string, F[]>();
  const caseHintMap = new Map<string, F[]>();
  const extHintMap = new Map<string, F[]>();
  const files: F[] = imageFiles.map((f) => ({ name: f.name, path: f.path || f.name }));
  for (const f of files) {
    pushToMap(imageMap, makeKey(f.name, opts, false), f);
    if (wantCaseHint) pushToMap(caseHintMap, makeKey(f.name, hintCaseOpts, false), f);
    if (wantExtHint) pushToMap(extHintMap, makeKey(f.name, hintExtOpts, false), f);
  }

  // 2) CSV: 比較キー → 行番号一覧
  const rows = csvRows.map((r) => {
    const raw = r.image == null ? '' : String(r.image);
    const specified = raw.trim() !== '';
    return {
      rowNumber: r.rowNumber,
      id: r.id == null ? '' : String(r.id),
      image: raw,
      display: r.display == null ? raw : String(r.display),
      specified,
      key: specified ? makeKey(raw, opts, true) : '',
    };
  });
  const csvKeyMap = new Map<string, number[]>();
  for (const r of rows) {
    if (r.specified && r.key !== '') pushToMap(csvKeyMap, r.key, r.rowNumber);
  }

  // 3) 各行の判定
  const items: MatchItem[] = [];
  for (const r of rows) {
    const item: MatchItem = { rowNumber: r.rowNumber, id: r.id, image: r.display.trim(), status: STATUS.OK, detail: '' };

    if (!r.specified) {
      item.status = STATUS.EMPTY;
      item.detail = '画像列が空欄です。';
      items.push(item);
      continue;
    }
    if (r.key === '') {
      item.status = STATUS.MISSING;
      item.detail = 'パス（フォルダ名）だけでファイル名がありません。';
      items.push(item);
      continue;
    }

    const candidates = imageMap.get(r.key) ?? [];
    const sameRows = csvKeyMap.get(r.key) ?? [];
    const dupNote = sameRows.length > 1 ? `同じ画像名が${sameRows.length}${rowUnit}で指定されています（${formatRowList(sameRows, rowLabel, rowUnit)}）。` : '';

    if (candidates.length >= 2) {
      item.status = STATUS.MULTIPLE;
      item.detail =
        `比較条件上、対応する画像が${candidates.length}件あります：${formatFileList(candidates)}。どれを使うか確認してください。` +
        (dupNote ? ' ' + dupNote : '');
    } else if (candidates.length === 0) {
      item.status = STATUS.MISSING;
      const notes = ['比較条件に一致する画像が選択されていません。'];
      if (!opts.ignorePath && /[\\/]/.test(r.image)) {
        notes.push('値にフォルダ名（パス）が含まれています。「CSV内のパスを無視」をONにすると一致する場合があります。');
      }
      if (wantCaseHint) {
        const alt = caseHintMap.get(makeKey(r.image, hintCaseOpts, true));
        if (alt) notes.push(`参考：大文字小文字だけ異なる画像があります（${formatFileList(alt)}）。自動では一致扱いしません。`);
      }
      if (wantExtHint) {
        const alt = extHintMap.get(makeKey(r.image, hintExtOpts, true));
        if (alt) notes.push(`参考：拡張子だけ異なる、または拡張子のない指定です（候補：${formatFileList(alt)}）。自動では一致扱いしません。`);
      }
      if (dupNote) notes.push(dupNote);
      item.detail = notes.join(' ');
    } else if (sameRows.length > 1) {
      item.status = STATUS.DUPLICATE;
      item.detail = `${dupNote} 対応画像：${candidates[0]!.path}。意図的な共有であれば問題ありません。`;
    } else {
      item.status = STATUS.OK;
      item.detail = `対応画像：${candidates[0]!.path}`;
    }
    items.push(item);
  }

  // 4) 未使用画像（どの行の比較キーにも該当しない画像）
  const unused: F[] = [];
  imageMap.forEach((list, key) => {
    if (!csvKeyMap.has(key)) unused.push(...list);
  });
  unused.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of unused) {
    items.push({ rowNumber: null, id: '', image: f.path, status: STATUS.UNUSED, detail: format.unusedDetail ?? 'CSVのどの行でも使われていない画像です。' });
  }

  // 5) サマリー
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
  for (const it of items) counts[it.status] += 1;
  return {
    items,
    summary: { csvRows: rows.length, specified: rows.filter((r) => r.specified).length, images: files.length, counts },
    options: opts,
  };
}
