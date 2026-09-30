import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import {
  MappingSchema,
  applyTransforms,
  buildHeaderIndex,
  mapRow,
  parseDateTime,
  parseTyped,
  TransformSchema,
} from '../src/modules/imports/mapping.js';
import { decodeCsvBuffer, parseCsvText } from '../src/modules/imports/csvfile.js';
import { suggestMapping } from '../src/modules/imports/suggest.js';
import { escapeFormula, toCsv } from '../src/lib/csv.js';
import { STANDARD_TEMPLATE_MAPPING } from '../src/modules/channels/routes.js';

describe('date parsing with format tokens and timezone', () => {
  it('parses JST local time into the correct UTC instant', () => {
    const d = parseDateTime('2026/09/30 14:05:00', 'yyyy/MM/dd HH:mm:ss', 'Asia/Tokyo');
    expect(d?.toISOString()).toBe('2026-09-30T05:05:00.000Z');
  });
  it('supports single-digit tokens and Japanese literals', () => {
    expect(parseDateTime('2026/9/3 7:05', 'yyyy/M/d H:mm', 'Asia/Tokyo')?.toISOString()).toBe('2026-09-02T22:05:00.000Z');
    expect(parseDateTime('2026年9月30日 14時05分', 'yyyy年M月d日 H時mm分', 'Asia/Tokyo')?.toISOString()).toBe('2026-09-30T05:05:00.000Z');
  });
  it('handles DST zones', () => {
    // 2026-07-01 12:00 in New York (EDT, UTC-4)
    expect(parseDateTime('2026-07-01 12:00:00', 'yyyy-MM-dd HH:mm:ss', 'America/New_York')?.toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(parseDateTime('2026-01-15 12:00:00', 'yyyy-MM-dd HH:mm:ss', 'America/New_York')?.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });
  it('ISO with and without offset', () => {
    expect(parseDateTime('2026-09-30T14:05:00+09:00', 'ISO', 'UTC')?.toISOString()).toBe('2026-09-30T05:05:00.000Z');
    expect(parseDateTime('2026-09-30 14:05', 'ISO', 'Asia/Tokyo')?.toISOString()).toBe('2026-09-30T05:05:00.000Z');
  });
  it('rejects impossible or mismatched dates', () => {
    expect(parseDateTime('2026/02/30 10:00:00', 'yyyy/MM/dd HH:mm:ss', 'Asia/Tokyo')).toBeNull();
    expect(parseDateTime('30/09/2026', 'yyyy/MM/dd', 'Asia/Tokyo')).toBeNull();
    expect(parseDateTime('2026/13/01', 'yyyy/MM/dd', 'Asia/Tokyo')).toBeNull();
  });
  it('full-width digits are normalized', () => {
    expect(parseDateTime('２０２６/０９/３０', 'yyyy/MM/dd', 'Asia/Tokyo')?.toISOString()).toBe('2026-09-29T15:00:00.000Z');
  });
});

describe('transforms (declarative whitelist)', () => {
  it('applies ops in order', () => {
    expect(applyTransforms('  ＡＢＣ-１２３ ', [{ op: 'nfkc' }, { op: 'trim' }, { op: 'lower' }])).toBe('abc-123');
    expect(applyTransforms('¥1,280円', [{ op: 'removeChars', chars: '¥,円' }])).toBe('1280');
    expect(applyTransforms('a.b.c', [{ op: 'replace', from: '.', to: '-' }])).toBe('a-b-c');
    expect(applyTransforms('', [{ op: 'emptyAs', value: '宅配便' }])).toBe('宅配便');
    expect(applyTransforms('ネコポス', [{ op: 'map', table: { ネコポス: 'nekopos' }, fallback: 'other' }])).toBe('nekopos');
    expect(applyTransforms('不明', [{ op: 'map', table: { ネコポス: 'nekopos' }, fallback: 'other' }])).toBe('other');
    expect(applyTransforms('123-4567', [{ op: 'digitsOnly' }])).toBe('1234567');
  });
  it('replace is literal (regex metacharacters are not interpreted)', () => {
    expect(applyTransforms('a(b)*c', [{ op: 'replace', from: '(b)*', to: 'X' }])).toBe('aXc');
    expect(applyTransforms('aaaa', [{ op: 'replace', from: '.*', to: 'X' }])).toBe('aaaa');
  });
  it('unknown / code-like transforms are rejected by the schema', () => {
    expect(TransformSchema.safeParse({ op: 'eval', code: 'process.exit()' }).success).toBe(false);
    expect(TransformSchema.safeParse({ op: 'regex', pattern: '(a+)+$' }).success).toBe(false);
    expect(TransformSchema.safeParse({ op: 'template', value: '${process.env}' }).success).toBe(false);
  });
  it('mapping schema requires fatal fields and rejects unknown fields', () => {
    const r = MappingSchema.safeParse({ sku: { source: { column: 'SKU' } } });
    expect(r.success).toBe(false);
    expect(MappingSchema.safeParse({ ...STANDARD_TEMPLATE_MAPPING, hacker: { fixed: 'x' } }).success).toBe(false);
    expect(MappingSchema.safeParse(STANDARD_TEMPLATE_MAPPING).success).toBe(true);
  });
});

describe('typed parsing', () => {
  const opts = { dateFormat: 'yyyy-MM-dd HH:mm:ss', timeZone: 'Asia/Tokyo' };
  it('quantity must be a positive integer', () => {
    expect(parseTyped('quantity', '3', opts).value).toBe(3);
    expect(parseTyped('quantity', '１,２００', opts).value).toBe(1200);
    expect(parseTyped('quantity', '0', opts).issue?.severity).toBe('fatal');
    expect(parseTyped('quantity', '2.5', opts).issue?.severity).toBe('fatal');
    expect(parseTyped('quantity', '', opts).issue?.severity).toBe('fatal');
  });
  it('postal code normalized to 7 digits', () => {
    expect(parseTyped('postalCode', '１５００００１', opts).value).toBe('150-0001');
    expect(parseTyped('postalCode', '150-0001', opts).value).toBe('150-0001');
    expect(parseTyped('postalCode', '15000', opts).issue?.severity).toBe('validation');
    expect(parseTyped('postalCode', '', opts).issue?.severity).toBe('validation');
  });
  it('email/phone produce warnings, not failures', () => {
    expect(parseTyped('customerEmail', 'bad@', opts).issue?.severity).toBe('warning');
    expect(parseTyped('recipientPhone', '090-1234-5678', opts).value).toBe('090-1234-5678');
  });
  it('cancel flag words', () => {
    expect(parseTyped('cancelFlag', 'キャンセル', opts).value).toBe(true);
    expect(parseTyped('cancelFlag', '', opts).value).toBe(false);
    expect(parseTyped('cancelFlag', '謎', opts).issue).toBeDefined();
  });
  it('strips control characters from strings', () => {
    expect(parseTyped('notes', 'abc\u0007def', opts).value).toBe('abcdef');
  });
});

describe('CSV decoding / parsing', () => {
  const csv = '注文番号,商品名,数量\r\nA-1,"カンマ,入り",1\r\nA-2,"改行\n入り",2\r\nA-3,"ダブル""クォート",3\r\n';
  it('UTF-8 with BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]);
    const d = decodeCsvBuffer(buf, 'utf-8');
    expect(d.hadBom).toBe(true);
    const p = parseCsvText(d.text, { delimiter: ',', hasHeader: true, skipRows: 0 });
    expect(p.header).toEqual(['注文番号', '商品名', '数量']);
    expect(p.rows).toEqual([
      ['A-1', 'カンマ,入り', '1'],
      ['A-2', '改行\n入り', '2'],
      ['A-3', 'ダブル"クォート', '3'],
    ]);
  });
  it('Shift_JIS (CP932) only when explicitly selected', () => {
    const sj = iconv.encode('注文番号,商品名,数量\r\nA-1,髙橋①～,1\r\n', 'cp932');
    expect(() => decodeCsvBuffer(sj, 'utf-8')).toThrow(/Shift_JIS/);
    const d = decodeCsvBuffer(sj, 'shift_jis');
    const p = parseCsvText(d.text, { delimiter: ',', hasHeader: true, skipRows: 0 });
    expect(p.rows[0]).toEqual(['A-1', '髙橋①～', '1']);
  });
  it('syntax error reports a line', () => {
    expect(() => parseCsvText('a,b\n"unterminated,1\n', { delimiter: ',', hasHeader: true, skipRows: 0 })).toThrow(/構文エラー/);
  });
  it('mapRow with header names and concatenated columns', () => {
    const header = buildHeaderIndex(['id', 'd', 's', 'q', 'a1', 'a2', 'z', 'n'], 8);
    const r = mapRow(
      ['X1', '2026-09-30 10:00:00', 'SKU-1', '2', '東京都渋谷区1-2-3', 'ビル5F', '1500001', '山田'],
      {
        externalOrderId: { source: { column: 'id' }, transforms: [] },
        orderDate: { source: { column: 'd' }, transforms: [] },
        sku: { source: { column: 's' }, transforms: [] },
        quantity: { source: { index: 3 }, transforms: [] },
        address1: { source: { columns: ['a1', 'a2'], separator: ' ' }, transforms: [] },
        postalCode: { source: { column: 'z' }, transforms: [] },
        recipientName: { source: { column: 'n' }, transforms: [] },
        shippingMethod: { fixed: '宅配便', transforms: [] },
      },
      header,
      { dateFormat: 'yyyy-MM-dd HH:mm:ss', timeZone: 'Asia/Tokyo' },
    );
    expect(r.issues).toEqual([]);
    expect(r.values.address1).toBe('東京都渋谷区1-2-3 ビル5F');
    expect(r.values.postalCode).toBe('150-0001');
    expect(r.values.shippingMethod).toBe('宅配便');
    expect(r.values.quantity).toBe(2);
  });
});

describe('mapping suggestion and CSV export safety', () => {
  it('suggests columns from common header names', () => {
    const s = suggestMapping(['注文番号', '注文日時', 'SKU', '数量', 'お届け先氏名', 'お届け先郵便番号', 'お届け先住所1']);
    expect(s.matched.externalOrderId).toBe('注文番号');
    expect(s.matched.orderDate).toBe('注文日時');
    expect(s.matched.recipientName).toBe('お届け先氏名');
    expect(s.matched.postalCode).toBe('お届け先郵便番号');
    expect(s.matched.address1).toBe('お届け先住所1');
  });
  it('R25: CSV formula injection is neutralized', () => {
    expect(escapeFormula('=HYPERLINK("http://evil","x")')).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(escapeFormula('+1+1')).toBe("'+1+1");
    expect(escapeFormula('-2+3')).toBe("'-2+3");
    expect(escapeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeFormula('\tcmd')).toBe("'\tcmd");
    expect(escapeFormula('普通の値')).toBe('普通の値');
    const out = toCsv(['name', 'qty'], [['=cmd|" /C calc"!A0', -3]]);
    expect(out).toContain(`"'=cmd|"" /C calc""!A0"`);
    expect(out).toContain(',-3');
  });
});
