import { parse as parseCsvSync } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { badRequest } from '../../lib/errors.js';

export const CSV_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 200,
  maxFieldChars: 10_000,
};

export interface DecodeResult {
  text: string;
  hadBom: boolean;
  encoding: 'utf-8' | 'shift_jis';
}

export function looksLikeUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文字コード: UTF-8（BOM 有無）必須対応。Shift_JIS は明示指定時のみ CP932 としてデコード（自動推測で確定しない）。
 */
export function decodeCsvBuffer(buf: Buffer, encoding: 'utf-8' | 'shift_jis'): DecodeResult {
  if (buf.length > CSV_LIMITS.maxBytes) {
    throw badRequest('FILE_TOO_LARGE', `ファイルが大きすぎます（上限 ${CSV_LIMITS.maxBytes / 1024 / 1024}MB）`);
  }
  const hadBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (encoding === 'utf-8') {
    const body = hadBom ? buf.subarray(3) : buf;
    if (!looksLikeUtf8(body)) {
      throw badRequest(
        'ENCODING_MISMATCH',
        'ファイルを UTF-8 として読み込めません。Shift_JIS（CP932）の可能性があります。Import Profile の文字コードを「Shift_JIS」に変更してください。',
      );
    }
    return { text: body.toString('utf8'), hadBom, encoding };
  }
  if (hadBom) {
    throw badRequest('ENCODING_MISMATCH', 'UTF-8 の BOM が付いたファイルです。Import Profile の文字コードを「UTF-8」にしてください。');
  }
  const text = iconv.decode(buf, 'cp932');
  if (text.includes('�')) {
    throw badRequest('ENCODING_MISMATCH', 'Shift_JIS として読み込めない文字があります。文字コードを確認してください。');
  }
  return { text, hadBom, encoding };
}

export interface ParsedCsv {
  header: string[] | null;
  rows: string[][];
  /** rows[i] の元ファイル上の行番号（1 始まり、ヘッダー含む） */
  lineNumbers: number[];
  columnCount: number;
}

export function parseCsvText(
  text: string,
  opts: { delimiter: ',' | '\t'; hasHeader: boolean; skipRows: number },
): ParsedCsv {
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parseCsvSync(text, {
      delimiter: opts.delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      from_line: opts.skipRows + 1,
      info: true,
      bom: true,
      max_record_size: CSV_LIMITS.maxFieldChars * 10,
      trim: false,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch (e) {
    const err = e as { message: string; lines?: number };
    throw badRequest('CSV_SYNTAX', `CSV の構文エラー${err.lines ? `（${err.lines}行目付近）` : ''}: ${err.message.slice(0, 200)}`);
  }
  if (records.length === 0) throw badRequest('CSV_EMPTY', 'CSV にデータがありません');
  const header = opts.hasHeader ? records[0]!.record.map((h) => h.replace(/^﻿/, '').trim()) : null;
  const dataRecords = opts.hasHeader ? records.slice(1) : records;
  if (dataRecords.length > CSV_LIMITS.maxRows) {
    throw badRequest('CSV_TOO_MANY_ROWS', `行数が多すぎます（上限 ${CSV_LIMITS.maxRows.toLocaleString()} 行）。ファイルを分割してください`);
  }
  let columnCount = header?.length ?? 0;
  const rows: string[][] = [];
  const lineNumbers: number[] = [];
  for (const r of dataRecords) {
    if (r.record.length > CSV_LIMITS.maxColumns) {
      throw badRequest('CSV_TOO_MANY_COLUMNS', `列数が多すぎます（${r.info.lines}行目、上限 ${CSV_LIMITS.maxColumns} 列）`);
    }
    if (r.record.some((c) => c.length > CSV_LIMITS.maxFieldChars)) {
      throw badRequest('CSV_FIELD_TOO_LONG', `${r.info.lines}行目に長すぎるセルがあります`);
    }
    columnCount = Math.max(columnCount, r.record.length);
    rows.push(r.record);
    lineNumbers.push(r.info.lines);
  }
  return { header, rows, lineNumbers, columnCount };
}
