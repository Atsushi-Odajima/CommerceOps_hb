/**
 * Import Profile の列マッピングと値変換（宣言的・任意コード実行なし）。
 * - 変換は許可リストの操作のみ（正規表現・式・eval は受け付けない = ReDoS/コード実行の防止）
 * - 型変換はフィールド型で固定
 */
import { z } from 'zod';

// ---------------- target fields ----------------
export type FieldType = 'string' | 'datetime' | 'int' | 'decimal' | 'postal' | 'phone' | 'email' | 'bool';

export interface FieldDef {
  label: string;
  level: 'order' | 'line';
  type: FieldType;
  /** fatal: 欠落で取込不可 / validation: 欠落で「要確認」として取込（プロファイル設定による） */
  required?: 'fatal' | 'validation';
  max?: number;
  min?: number;
}

export const TARGET_FIELDS = {
  externalOrderId: { label: '注文番号', level: 'order', type: 'string', required: 'fatal', max: 100 },
  orderDate: { label: '注文日時', level: 'order', type: 'datetime', required: 'fatal' },
  customerName: { label: '購入者名', level: 'order', type: 'string', max: 100 },
  customerEmail: { label: '購入者メール', level: 'order', type: 'email', max: 254 },
  customerPhone: { label: '購入者電話', level: 'order', type: 'phone', max: 30 },
  channelCustomerId: { label: 'チャネル顧客ID', level: 'order', type: 'string', max: 100 },
  recipientName: { label: '送付先氏名', level: 'order', type: 'string', required: 'validation', max: 100 },
  postalCode: { label: '郵便番号', level: 'order', type: 'postal', required: 'validation' },
  prefecture: { label: '都道府県', level: 'order', type: 'string', max: 20 },
  city: { label: '市区町村', level: 'order', type: 'string', max: 100 },
  address1: { label: '住所1', level: 'order', type: 'string', required: 'validation', max: 200 },
  address2: { label: '住所2（建物名等）', level: 'order', type: 'string', max: 200 },
  recipientPhone: { label: '送付先電話', level: 'order', type: 'phone', max: 30 },
  shippingMethod: { label: '配送方法', level: 'order', type: 'string', max: 50 },
  notes: { label: '備考', level: 'order', type: 'string', max: 1000 },
  priority: { label: '優先度(0-9)', level: 'order', type: 'int', min: 0, max: 9 },
  cancelFlag: { label: 'キャンセルフラグ', level: 'order', type: 'bool' },
  sku: { label: 'SKU', level: 'line', type: 'string', required: 'fatal', max: 64 },
  productName: { label: '商品名', level: 'line', type: 'string', max: 200 },
  quantity: { label: '数量', level: 'line', type: 'int', required: 'fatal', min: 1, max: 100000 },
  unitPrice: { label: '単価', level: 'line', type: 'decimal', min: 0, max: 99999999 },
  variant: { label: 'バリエーション', level: 'line', type: 'string', max: 100 },
  externalLineId: { label: '明細ID', level: 'line', type: 'string', max: 100 },
} as const satisfies Record<string, FieldDef>;

export type TargetField = keyof typeof TARGET_FIELDS;
export const TARGET_FIELD_KEYS = Object.keys(TARGET_FIELDS) as TargetField[];
export const ORDER_LEVEL_FIELDS = TARGET_FIELD_KEYS.filter((k) => TARGET_FIELDS[k].level === 'order');
export const LINE_LEVEL_FIELDS = TARGET_FIELD_KEYS.filter((k) => TARGET_FIELDS[k].level === 'line');

// ---------------- mapping schema ----------------
const safeText = (max: number) => z.string().max(max);

export const TransformSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim') }),
  z.object({ op: z.literal('upper') }),
  z.object({ op: z.literal('lower') }),
  z.object({ op: z.literal('nfkc') }),
  z.object({ op: z.literal('digitsOnly') }),
  z.object({ op: z.literal('removeChars'), chars: safeText(50).min(1) }),
  z.object({ op: z.literal('replace'), from: safeText(100).min(1), to: safeText(100) }),
  z.object({ op: z.literal('emptyAs'), value: safeText(200) }),
  z.object({ op: z.literal('truncate'), length: z.number().int().min(1).max(2000) }),
  z.object({
    op: z.literal('map'),
    table: z.record(safeText(100), safeText(200)).refine((t) => Object.keys(t).length <= 200, '対応表は200件まで'),
    fallback: safeText(200).optional(),
  }),
]);
export type Transform = z.infer<typeof TransformSchema>;

export const SourceSchema = z.union([
  z.object({ column: safeText(200).min(1) }),
  z.object({ index: z.number().int().min(0).max(500) }),
  z.object({ columns: z.array(safeText(200).min(1)).min(1).max(5), separator: safeText(5).default(' ') }),
]);

export const FieldMappingSchema = z
  .object({
    source: SourceSchema.optional(),
    fixed: safeText(200).optional(),
    transforms: z.array(TransformSchema).max(10).default([]),
    /** 日付フィールドのみ: プロファイル既定と異なる書式 */
    dateFormat: safeText(40).optional(),
  })
  .refine((m) => m.source !== undefined || m.fixed !== undefined, { message: 'source か fixed のどちらかを指定してください' });
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const MappingSchema = z
  .record(z.string(), FieldMappingSchema)
  .superRefine((m, ctx) => {
    for (const k of Object.keys(m)) {
      if (!(k in TARGET_FIELDS)) ctx.addIssue({ code: 'custom', message: `不明なフィールド: ${k}`, path: [k] });
    }
    for (const k of TARGET_FIELD_KEYS) {
      const def = TARGET_FIELDS[k] as FieldDef;
      if (def.required === 'fatal' && !m[k]) {
        ctx.addIssue({ code: 'custom', message: `必須フィールド「${def.label}」のマッピングがありません`, path: [k] });
      }
    }
  });
export type Mapping = Partial<Record<TargetField, FieldMapping>>;

// ---------------- date format ----------------
const DATE_TOKENS = ['yyyy', 'MM', 'M', 'dd', 'd', 'HH', 'H', 'mm', 'ss'] as const;
type DateToken = (typeof DATE_TOKENS)[number];
const TOKEN_RE: Record<DateToken, string> = {
  yyyy: '(\\d{4})',
  MM: '(\\d{2})',
  M: '(\\d{1,2})',
  dd: '(\\d{2})',
  d: '(\\d{1,2})',
  HH: '(\\d{2})',
  H: '(\\d{1,2})',
  mm: '(\\d{2})',
  ss: '(\\d{2})',
};

interface CompiledDateFormat {
  re: RegExp;
  tokens: DateToken[];
  hasTime: boolean;
}

const dateFormatCache = new Map<string, CompiledDateFormat>();

export function validateDateFormat(fmt: string): string | null {
  if (fmt === 'ISO') return null;
  if (fmt.length === 0 || fmt.length > 40) return '日付書式は1〜40文字で指定してください';
  if (!fmt.includes('yyyy')) return '日付書式に yyyy（年）が必要です';
  if (!/M/.test(fmt) || !/d/.test(fmt)) return '日付書式に M（月）と d（日）が必要です';
  return null;
}

export function compileDateFormat(fmt: string): CompiledDateFormat {
  const cached = dateFormatCache.get(fmt);
  if (cached) return cached;
  const tokens: DateToken[] = [];
  let pattern = '';
  let i = 0;
  while (i < fmt.length) {
    const tok = DATE_TOKENS.find((t) => fmt.startsWith(t, i));
    if (tok) {
      tokens.push(tok);
      pattern += TOKEN_RE[tok];
      i += tok.length;
    } else {
      pattern += fmt[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  const compiled = {
    re: new RegExp(`^${pattern}$`),
    tokens,
    hasTime: tokens.some((t) => t === 'HH' || t === 'H'),
  };
  if (dateFormatCache.size > 500) dateFormatCache.clear();
  dateFormatCache.set(fmt, compiled);
  return compiled;
}

/** IANA タイムゾーンの、ある瞬間における UTC オフセット（ミリ秒） */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** ローカル日時（timeZone）→ UTC Date */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMs(guess, timeZone);
  let ts = guess - off;
  const off2 = tzOffsetMs(ts, timeZone);
  if (off2 !== off) {
    off = off2;
    ts = guess - off;
  }
  return new Date(ts);
}

export function parseDateTime(value: string, fmt: string, timeZone: string): Date | null {
  const v = value.normalize('NFKC').trim();
  if (fmt === 'ISO') {
    if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) return null;
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(v);
    if (hasZone) {
      const d = new Date(v.replace(' ', 'T'));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v)!;
    return build(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  const cf = compileDateFormat(fmt);
  const m = cf.re.exec(v);
  if (!m) return null;
  const comp: Record<string, number> = { y: 0, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  cf.tokens.forEach((t, idx) => {
    const n = Number(m[idx + 1]);
    if (t === 'yyyy') comp.y = n;
    else if (t === 'MM' || t === 'M') comp.mo = n;
    else if (t === 'dd' || t === 'd') comp.d = n;
    else if (t === 'HH' || t === 'H') comp.h = n;
    else if (t === 'mm') comp.mi = n;
    else if (t === 'ss') comp.s = n;
  });
  return build(comp.y!, comp.mo!, comp.d!, comp.h!, comp.mi!, comp.s!);

  function build(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    // 実在しない日付（2/30 等）を拒否
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1) return null;
    return zonedToUtc(y, mo, d, h, mi, s, timeZone);
  }
}

// ---------------- transforms ----------------
export function applyTransforms(value: string, transforms: Transform[]): string {
  let v = value;
  for (const t of transforms) {
    switch (t.op) {
      case 'trim':
        v = v.trim();
        break;
      case 'upper':
        v = v.toUpperCase();
        break;
      case 'lower':
        v = v.toLowerCase();
        break;
      case 'nfkc':
        v = v.normalize('NFKC');
        break;
      case 'digitsOnly':
        v = v.normalize('NFKC').replace(/[^0-9]/g, '');
        break;
      case 'removeChars': {
        const set = new Set([...t.chars]);
        v = [...v].filter((c) => !set.has(c)).join('');
        break;
      }
      case 'replace':
        v = v.split(t.from).join(t.to);
        break;
      case 'emptyAs':
        if (v.trim() === '') v = t.value;
        break;
      case 'truncate':
        v = [...v].slice(0, t.length).join('');
        break;
      case 'map': {
        const key = v.trim();
        if (Object.prototype.hasOwnProperty.call(t.table, key)) v = t.table[key]!;
        else if (t.fallback !== undefined) v = t.fallback;
        break;
      }
    }
  }
  return v;
}

// ---------------- typed parsing ----------------
export type ParsedValue = string | number | boolean | Date | null;

export interface FieldIssue {
  field: TargetField;
  severity: 'fatal' | 'validation' | 'warning';
  message: string;
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', 'on', 'cancel', 'cancelled', 'canceled', 'キャンセル', '取消', '取り消し', 'はい']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'n', 'off', '', 'いいえ', '有効', 'normal']);

export function parseTyped(
  field: TargetField,
  raw: string | undefined,
  opts: { dateFormat: string; timeZone: string },
): { value: ParsedValue; issue?: FieldIssue } {
  const def = TARGET_FIELDS[field] as FieldDef;
  const v = (raw ?? '').trim();
  if (v === '') {
    if (def.required) {
      return { value: null, issue: { field, severity: def.required, message: `${def.label}が空です` } };
    }
    return { value: def.type === 'bool' ? false : null };
  }
  const fail = (message: string, severity: FieldIssue['severity'] = def.required ?? 'validation') => ({
    value: null,
    issue: { field, severity, message },
  });
  switch (def.type) {
    case 'string': {
      if (def.max && [...v].length > def.max) {
        if (field === 'notes') return { value: [...v].slice(0, def.max).join(''), issue: { field, severity: 'warning', message: `${def.label}を${def.max}文字に切り詰めました` } };
        return fail(`${def.label}が長すぎます（${def.max}文字まで）`, def.required ?? 'validation');
      }
      // 制御文字を除去
      return { value: v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') };
    }
    case 'int': {
      const n = v.normalize('NFKC').replace(/,/g, '');
      if (!/^-?\d+$/.test(n)) return fail(`${def.label}は整数で指定してください（"${v.slice(0, 20)}"）`, def.required ?? 'validation');
      const num = Number(n);
      if (def.min !== undefined && num < def.min) return fail(`${def.label}は${def.min}以上にしてください`, def.required ?? 'validation');
      if (def.max !== undefined && num > def.max) return fail(`${def.label}は${def.max}以下にしてください`, def.required ?? 'validation');
      return { value: num };
    }
    case 'decimal': {
      const n = v.normalize('NFKC').replace(/[,¥￥\\円\s]/g, '');
      if (!/^-?\d+(\.\d{1,2})?$/.test(n)) return fail(`${def.label}は数値で指定してください（小数2桁まで）`, 'warning');
      const num = Number(n);
      if (def.min !== undefined && num < def.min) return fail(`${def.label}が負の値です`, 'warning');
      return { value: num };
    }
    case 'datetime': {
      const d = parseDateTime(v, opts.dateFormat, opts.timeZone);
      if (!d) return fail(`${def.label}「${v.slice(0, 30)}」を書式 ${opts.dateFormat} で解釈できません`, def.required ?? 'validation');
      return { value: d };
    }
    case 'postal': {
      const digits = v.normalize('NFKC').replace(/[^0-9]/g, '');
      if (digits.length !== 7) return fail(`${def.label}は7桁で指定してください（"${v.slice(0, 12)}"）`, 'validation');
      return { value: `${digits.slice(0, 3)}-${digits.slice(3)}` };
    }
    case 'phone': {
      const n = v.normalize('NFKC').replace(/[^0-9+\-]/g, '');
      const digits = n.replace(/[^0-9]/g, '');
      if (digits.length < 9 || digits.length > 15) {
        return { value: n || null, issue: { field, severity: 'warning', message: `${def.label}の桁数が不正です` } };
      }
      return { value: n };
    }
    case 'email': {
      const e = v.normalize('NFKC');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) {
        return { value: e, issue: { field, severity: 'warning', message: `${def.label}の形式が不正です` } };
      }
      return { value: e.toLowerCase() };
    }
    case 'bool': {
      const w = v.normalize('NFKC').toLowerCase();
      if (TRUE_WORDS.has(w)) return { value: true };
      if (FALSE_WORDS.has(w)) return { value: false };
      return fail(`${def.label}の値「${v.slice(0, 20)}」を判定できません（map 変換で true/false に変換してください）`, 'validation');
    }
  }
}

// ---------------- row mapping ----------------
export interface HeaderIndex {
  byName: Map<string, number>;
  count: number;
}

export function buildHeaderIndex(header: string[] | null, columnCount: number): HeaderIndex {
  const byName = new Map<string, number>();
  header?.forEach((h, i) => {
    const key = h.replace(/^﻿/, '').trim();
    if (key && !byName.has(key)) byName.set(key, i);
  });
  return { byName, count: columnCount };
}

/** マッピングで参照される列がヘッダーに存在するか検証 */
export function checkMappingColumns(mapping: Mapping, header: HeaderIndex, hasHeader: boolean): string[] {
  const problems: string[] = [];
  for (const [field, m] of Object.entries(mapping) as [TargetField, FieldMapping][]) {
    if (!m?.source) continue;
    const label = TARGET_FIELDS[field].label;
    if ('column' in m.source) {
      if (!hasHeader) problems.push(`${label}: ヘッダー行なしのプロファイルでは列名でなく列番号を指定してください`);
      else if (!header.byName.has(m.source.column)) problems.push(`${label}: 列「${m.source.column}」がファイルにありません`);
    } else if ('columns' in m.source) {
      for (const c of m.source.columns) {
        if (!header.byName.has(c)) problems.push(`${label}: 列「${c}」がファイルにありません`);
      }
    } else if (m.source.index >= header.count) {
      problems.push(`${label}: 列番号 ${m.source.index} はファイルの列数（${header.count}）を超えています`);
    }
  }
  return problems;
}

export function rawValue(row: string[], m: FieldMapping, header: HeaderIndex): string | undefined {
  if (m.source) {
    if ('column' in m.source) {
      const idx = header.byName.get(m.source.column);
      return idx === undefined ? undefined : (row[idx] ?? '');
    }
    if ('columns' in m.source) {
      const sep = m.source.separator ?? ' ';
      return m.source.columns
        .map((c) => {
          const idx = header.byName.get(c);
          return idx === undefined ? '' : (row[idx] ?? '').trim();
        })
        .filter((s) => s !== '')
        .join(sep);
    }
    return row[m.source.index] ?? '';
  }
  return m.fixed;
}

export interface MappedRow {
  values: Partial<Record<TargetField, ParsedValue>>;
  issues: FieldIssue[];
}

export function mapRow(
  row: string[],
  mapping: Mapping,
  header: HeaderIndex,
  opts: { dateFormat: string; timeZone: string },
): MappedRow {
  const values: MappedRow['values'] = {};
  const issues: FieldIssue[] = [];
  for (const field of TARGET_FIELD_KEYS) {
    const m = mapping[field];
    let raw: string | undefined;
    if (m) {
      raw = rawValue(row, m, header);
      if (raw !== undefined) raw = applyTransforms(raw, m.transforms ?? []);
    }
    const { value, issue } = parseTyped(field, raw, {
      dateFormat: m?.dateFormat ?? opts.dateFormat,
      timeZone: opts.timeZone,
    });
    values[field] = value;
    if (issue) issues.push(issue);
  }
  return { values, issues };
}
