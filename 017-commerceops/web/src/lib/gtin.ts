/** JAN/EAN/UPC のチェックディジット検証 */
function eanCheck(code: string): boolean {
  const digits = Array.from(code, Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** UPC-A（12 桁）と先頭 0 の EAN-13（13 桁）は同じ商品コード（サーバーの gtinVariants と同じ規則） */
export function gtinVariants(code: string): string[] {
  if (/^\d{12}$/.test(code) && eanCheck('0' + code)) return [code, '0' + code];
  if (/^0\d{12}$/.test(code) && eanCheck(code)) return [code, code.slice(1)];
  return [code];
}

export function matchesCode(registered: readonly string[], scanned: string): boolean {
  return gtinVariants(scanned.normalize('NFKC').trim()).some((c) => registered.includes(c));
}
