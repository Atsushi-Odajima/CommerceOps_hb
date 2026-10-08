/**
 * CommerceOps 商品画像チェック — 画面から使う補助処理（DOM を使わない純粋な処理）
 * 列の自動仮選択・選択ファイルの振り分け・URL からのファイル名・商品マスタの行化・絞り込み・結果 CSV の行。
 */
import type { CsvTable } from './csv';
import { baseName, isSupportedImageName, STATUS, type ImageFileRef, type MatchItem, type MatchRow, type Status } from './matcher';

/** 列番号 → A, B, …, Z, AA … */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function columnLabel(headers: string[], index: number): string {
  const h = headers[index];
  return `${columnLetter(index)}列：${h ? h : '（列名なし）'}`;
}

/** 画像列の仮選択: 列名 → 値の多くが画像ファイル名に見える列。見つからなければ -1 */
export function guessImageColumn(headers: string[], rows: { fields: string[] }[]): number {
  const nameRe = /画像|image|img|写真|picture|photo|ファイル名|file/i;
  for (let i = 0; i < headers.length; i++) {
    if (nameRe.test(headers[i]!)) return i;
  }
  const sample = rows.slice(0, 50);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < headers.length; i++) {
    let score = 0;
    for (const r of sample) {
      const v = (r.fields[i] ?? '').trim();
      if (v && isSupportedImageName(baseName(imageNameFromValue(v)))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore > 0 ? best : -1;
}

/** 識別列の仮選択（商品コード・SKU 等）。見つからなければ -1 */
export function guessIdColumn(headers: string[], imageIndex: number): number {
  const res = [/商品コード|品番|商品番号|管理番号|sku/i, /コード|code|^id$|商品id/i];
  for (const re of res) {
    for (let i = 0; i < headers.length; i++) {
      if (i !== imageIndex && re.test(headers[i]!)) return i;
    }
  }
  return -1;
}

/**
 * CSV の値・商品の image_url から、照合に使う名前（パスを含む）を取り出す。
 * http(s) の URL はパス部分だけを使う（? 以降・# 以降を除き、%xx を戻す）。それ以外の値はそのまま。
 * パス部分を返すので、フォルダ名の扱いは「CSV内のパスを無視」設定に従う。
 */
export function imageNameFromValue(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!/^https?:\/\//i.test(v)) return value ?? '';
  try {
    const p = new URL(v).pathname;
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  } catch {
    return v.replace(/[?#].*$/, '');
  }
}

export interface FileLike {
  name: string;
  /** フォルダ選択時の相対パス（File.webkitRelativePath） */
  webkitRelativePath?: string;
}

/** 選択されたファイルを「照合する画像」「対応形式でないファイル」「macOS の管理用ファイル」に分ける */
export function classifySelectedFiles(files: FileLike[]): { images: ImageFileRef[]; excluded: string[]; systemFiles: string[] } {
  const images: ImageFileRef[] = [];
  const excluded: string[] = [];
  const systemFiles: string[] = [];
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    if (/^\._/.test(f.name) || /(^|\/)__MACOSX\//.test(path)) systemFiles.push(path);
    else if (isSupportedImageName(f.name)) images.push({ name: f.name, path });
    else excluded.push(path);
  }
  return { images, excluded, systemFiles };
}

/** CSV の表 → 照合する行（画像列・識別列は列番号。識別列 -1 は指定なし） */
export function tableToRows(table: CsvTable, imageCol: number, idCol: number): MatchRow[] {
  return table.rows.map((r) => {
    const raw = r.fields[imageCol] ?? '';
    return { rowNumber: r.rowNumber, id: idCol >= 0 ? (r.fields[idCol] ?? '').trim() : '', image: imageNameFromValue(raw), display: raw };
  });
}

export interface ProductLike {
  sku: string;
  imageUrl?: string | null;
}

/**
 * 商品マスタ → 照合する行。行番号は SKU 順の通し番号（1 から）。
 * 画像は image_url のファイル名（URL のパス部分の最後）で管理されているものとして照合する（ADR-041）。
 */
export function productsToRows(products: ProductLike[]): MatchRow[] {
  return products.map((p, i) => ({ rowNumber: i + 1, id: p.sku, image: imageNameFromValue(p.imageUrl ?? ''), display: p.imageUrl ?? '' }));
}

/** 検索用の正規化（全角・半角、大文字小文字を区別しない） */
export function normalizeForSearch(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase();
}

/** 判定（'all' はすべて）と検索語（識別値・画像名に含む）で絞り込む */
export function filterItems(items: MatchItem[], filter: Status | 'all', search: string): MatchItem[] {
  const q = normalizeForSearch(search.trim());
  return items.filter((it) => {
    if (filter !== 'all' && it.status !== filter) return false;
    if (q && !normalizeForSearch(it.id).includes(q) && !normalizeForSearch(it.image).includes(q)) return false;
    return true;
  });
}

/** 結果 CSV の行（見出し + 結果）。problemsOnly は「正常」以外だけ */
export function resultCsvRows(
  items: MatchItem[],
  problemsOnly: boolean,
  header: string[] = ['CSV行番号', '識別値', '画像ファイル名', '判定', '詳細'],
): string[][] {
  const rows: string[][] = [header];
  for (const it of items) {
    if (problemsOnly && it.status === STATUS.OK) continue;
    rows.push([it.rowNumber == null ? '' : String(it.rowNumber), it.id, it.image, it.status, it.detail]);
  }
  return rows;
}

/** YYYY-MM-DD（端末のローカル日付） */
export function todayString(d: Date = new Date()): string {
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
