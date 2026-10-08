/**
 * CommerceOps 商品画像チェック — CSV の文字コード判定・解析・結果 CSV 出力（ブラウザ内で完結。DOM を使わない純粋な処理）
 *
 * 「商品CSV × 商品画像 照合ツール」（#006）の csv.js を TypeScript へ移植したもの（DECISIONS.md ADR-041）。
 * サーバーの商品 CSV 取込（csv-parse）とは別に、ファイルを送信せずブラウザ内で読むために使う。
 */

/** 利用者向けメッセージを持つエラー */
export class CsvError extends Error {
  readonly code: string;
  readonly userMessage: string;
  constructor(code: string, userMessage: string) {
    super(userMessage);
    this.name = 'CsvError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export type CsvEncodingMode = 'auto' | 'utf-8' | 'shift_jis';

function startsWithBytes(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

function decodeStrict(label: string, bytes: Uint8Array): string {
  // fatal:true … 不正なバイト列があれば例外（文字化けしたまま読み込まない）
  return new TextDecoder(label, { fatal: true }).decode(bytes);
}

/**
 * CSV のバイト列を文字列へ変換します。
 * auto: UTF-8 として厳密に読めれば UTF-8。読めない場合だけ Shift_JIS として読む（本当の自動判定ではなく「UTF-8 優先・失敗時 Shift_JIS」）
 */
export function decodeCsvBytes(
  buffer: ArrayBuffer | Uint8Array,
  mode: CsvEncodingMode = 'auto',
): { text: string; encodingLabel: string; usedFallback: boolean } {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length === 0) {
    throw new CsvError('EMPTY', 'CSVファイルが空です（0バイト）。内容の入ったCSVを選択してください。');
  }
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new CsvError(
      'NOT_CSV_XLSX',
      'Excelファイル（.xlsx）などCSV以外の形式のようです。Excelで「CSV UTF-8（コンマ区切り）」として保存し直してから選択してください。',
    );
  }
  if (startsWithBytes(bytes, [0xff, 0xfe]) || startsWithBytes(bytes, [0xfe, 0xff])) {
    throw new CsvError('UNSUPPORTED_UTF16', 'UTF-16形式のCSVには対応していません。「CSV UTF-8（コンマ区切り）」で保存し直してください。');
  }

  const hasUtf8Bom = startsWithBytes(bytes, [0xef, 0xbb, 0xbf]);

  if (mode === 'shift_jis') {
    try {
      return { text: decodeStrict('shift_jis', bytes), encodingLabel: 'Shift_JIS（手動指定）', usedFallback: false };
    } catch {
      throw new CsvError('ENCODING_SJIS', 'Shift_JISとして読み込めませんでした。文字コードを「UTF-8」にして読み直すか、CSVをUTF-8で保存し直してください。');
    }
  }

  try {
    // TextDecoder は UTF-8 の BOM を自動で取り除く
    return { text: decodeStrict('utf-8', bytes), encodingLabel: hasUtf8Bom ? 'UTF-8（BOM付き）' : 'UTF-8', usedFallback: false };
  } catch {
    if (mode === 'utf-8') {
      throw new CsvError('ENCODING_UTF8', 'UTF-8として読み込めませんでした。Shift_JISのCSVの場合は、文字コードを「Shift_JIS」にして読み直してください。');
    }
  }

  try {
    return { text: decodeStrict('shift_jis', bytes), encodingLabel: 'Shift_JIS（UTF-8として読めなかったため）', usedFallback: true };
  } catch {
    throw new CsvError(
      'ENCODING_UNKNOWN',
      'このCSVの文字コードを読み取れませんでした（対応：UTF-8 / UTF-8 BOM付き / Shift_JIS）。Excelで「CSV UTF-8（コンマ区切り）」として保存し直してください。',
    );
  }
}

export interface CsvRecord {
  fields: string[];
  /** テキスト上の開始行（エラー表示用） */
  line: number;
}

/**
 * RFC 4180 に沿った CSV パーサ（区切り文字はカンマ固定）
 * - "..." で囲まれたフィールド内のカンマ・改行をそのまま値として扱う / "" は " 1 文字
 * - 改行は CRLF / LF / CR のいずれにも対応 / 空欄・末尾の空欄も 1 フィールド
 * - 引用符なしフィールドの途中にある " は文字として扱う（寛容に読む）
 */
export function parseCsv(text: string): CsvRecord[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: CsvRecord[] = [];
  const n = text.length;
  let row: string[] = [];
  let field = '';
  let fieldStarted = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  let i = 0;

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
        continue;
      }
      if (c === '\r') {
        line += 1;
        if (text[i + 1] === '\n') {
          field += '\r\n';
          i += 2;
          continue;
        }
      } else if (c === '\n') {
        line += 1;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      quoteLine = line;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(field);
      records.push({ fields: row, line: recordLine });
      row = [];
      field = '';
      fieldStarted = false;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    field += c;
    fieldStarted = true;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvError(
      'UNCLOSED_QUOTE',
      `CSVの読み込みに失敗しました：テキスト${quoteLine}行目付近で始まる引用符（"）が閉じられていません。CSVの内容を確認してください。`,
    );
  }
  if (fieldStarted || row.length > 0) {
    row.push(field);
    records.push({ fields: row, line: recordLine });
  }
  return records;
}

/** 全フィールドが空（前後空白のみ含む）のレコードか */
export function isBlankRecord(fields: string[]): boolean {
  return fields.every((f) => f.trim() === '');
}

export interface CsvTable {
  headers: string[];
  rows: { rowNumber: number; fields: string[] }[];
  blankRows: number;
  longRows: number;
}

/**
 * CSV テキストを「ヘッダー + データ行」に分けます。
 * rowNumber はヘッダーを 1 行目とした「レコード番号」＝ Excel で開いた時の行番号。全列が空の行はデータ行にせず番号だけ進める。
 */
export function buildTable(text: string): CsvTable {
  const records = parseCsv(text);
  if (records.length === 0) {
    throw new CsvError('EMPTY', 'CSVにデータがありません。内容の入ったCSVを選択してください。');
  }
  if (isBlankRecord(records[0]!.fields)) {
    throw new CsvError('NO_HEADER', 'CSVの1行目（ヘッダー行）が空です。1行目に「商品コード,商品名,画像」のような列名を入れてください。');
  }

  const headers = records[0]!.fields.map((h) => h.trim());
  const rows: CsvTable['rows'] = [];
  let blankRows = 0;
  let longRows = 0;
  for (let r = 1; r < records.length; r++) {
    const fields = records[r]!.fields;
    if (isBlankRecord(fields)) {
      blankRows += 1;
      continue;
    }
    if (fields.length > headers.length) longRows += 1;
    rows.push({ rowNumber: r + 1, fields });
  }
  if (rows.length === 0) {
    throw new CsvError('NO_DATA_ROWS', 'CSVにデータ行がありません（ヘッダー行だけ、または空行だけです）。2行目以降に商品データを入れてください。');
  }
  return { headers, rows, blankRows, longRows };
}

/* ---------- 結果 CSV の出力 ---------- */

/** Excel で数式として解釈されないよう、先頭が = + - @ タブ CR の値には ' を付ける（CSV インジェクション対策） */
function protectFormula(value: string): string {
  if (value === '') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

export function escapeCsvField(value: unknown): string {
  const s = protectFormula(value == null ? '' : String(value));
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 2 次元配列 → CSV 文字列（UTF-8 BOM 付き、CRLF 改行） */
export function toCsvText(rows: unknown[][]): string {
  const lines = rows.map((cols) => cols.map(escapeCsvField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** ファイル名として危険・不正な文字を _ に置き換える（Windows の禁止文字・制御文字・予約名に対応） */
export function sanitizeFileName(name: unknown): string {
  let s = String(name == null ? '' : name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = '_' + s;
  if (s === '') s = 'result';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}
