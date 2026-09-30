import iconv from 'iconv-lite';

/**
 * CSV/Formula Injection 対策: 表計算ソフトで数式として解釈されうる先頭文字（= + - @ TAB CR）で始まるセルに ' を付ける。
 * OWASP "CSV Injection" の推奨に従う。
 */
export function escapeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else if (typeof v === 'boolean') s = v ? '1' : '0';
  else s = String(v);
  // 数値型はそのまま（負数の "-" はデータとして正しい）、文字列のみ数式対策
  return quote(typeof v === 'number' ? s : escapeFormula(s));
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map((h) => quote(escapeFormula(h))).join(',')];
  for (const r of rows) lines.push(r.map(toCsvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

export type CsvEncoding = 'utf-8' | 'shift_jis';

/** UTF-8 は Excel で文字化けしないよう BOM 付き。Shift_JIS は CP932（Windows 拡張文字を含む） */
export function encodeCsv(text: string, encoding: CsvEncoding = 'utf-8'): Buffer {
  if (encoding === 'shift_jis') return iconv.encode(text, 'cp932');
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
