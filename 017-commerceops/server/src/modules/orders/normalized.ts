import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../../lib/hash.js';

export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const NormalizedLineSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  productName: optText(200),
  quantity: z.number().int().min(1).max(100000),
  unitPrice: z.number().min(0).max(99999999).optional().nullable(),
  variant: optText(100),
  externalLineId: optText(100),
});

export const AddressSchema = z.object({
  name: optText(100),
  postalCode: optText(10),
  prefecture: optText(20),
  city: optText(100),
  address1: optText(200),
  address2: optText(200),
  phone: optText(30),
});

export const NormalizedOrderSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(100),
  orderDate: z.string(),
  customer: z.object({
    name: optText(100),
    email: optText(254),
    phone: optText(30),
    channelCustomerId: optText(100),
  }),
  shipTo: AddressSchema,
  shippingMethod: optText(50),
  notes: optText(1000),
  priority: z.number().int().min(0).max(9).default(0),
  cancelFlag: z.boolean().default(false),
  lines: z.array(NormalizedLineSchema).min(1).max(500),
});

export type NormalizedOrder = z.infer<typeof NormalizedOrderSchema>;
export type NormalizedLine = z.infer<typeof NormalizedLineSchema>;
export type Address = z.infer<typeof AddressSchema>;

/** 住所1の先頭に都道府県名がある場合に分離する（都道府県が未指定のときのみ） */
export function splitPrefecture(addr: Address): Address {
  if (addr.prefecture || !addr.address1) return addr;
  const pref = PREFECTURES.find((p) => addr.address1!.startsWith(p));
  if (!pref) return addr;
  const rest = addr.address1.slice(pref.length).trim();
  return { ...addr, prefecture: pref, address1: rest || addr.address1 };
}

/** 内容比較用ハッシュ（取消フラグは別判定のため含めない） */
export function orderContentHash(o: NormalizedOrder): string {
  const { cancelFlag: _c, ...rest } = o;
  void _c;
  return sha256Hex(canonicalJson(rest));
}

export interface ValidationIssue {
  code: string;
  message: string;
  line?: number;
}

/** 取込可能だが「要確認」にすべき問題（住所不備・未登録 SKU） */
export function validateForFulfillment(o: NormalizedOrder, knownSkus: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!o.shipTo.name) issues.push({ code: 'SHIP_TO_NAME_MISSING', message: '送付先氏名がありません' });
  if (!o.shipTo.postalCode) issues.push({ code: 'POSTAL_MISSING', message: '郵便番号がありません' });
  else if (!/^\d{3}-\d{4}$/.test(o.shipTo.postalCode)) issues.push({ code: 'POSTAL_INVALID', message: '郵便番号の形式が不正です' });
  if (!o.shipTo.address1) issues.push({ code: 'ADDRESS_MISSING', message: '住所がありません' });
  o.lines.forEach((l, i) => {
    if (!knownSkus.has(l.sku)) issues.push({ code: 'UNKNOWN_SKU', message: `未登録の SKU: ${l.sku}`, line: i + 1 });
  });
  return issues;
}

export function formatAddress(a: { postal_code?: string | null; prefecture?: string | null; city?: string | null; address1?: string | null; address2?: string | null }) {
  return [a.postal_code ? `〒${a.postal_code}` : '', `${a.prefecture ?? ''}${a.city ?? ''}${a.address1 ?? ''}`, a.address2 ?? '']
    .filter(Boolean)
    .join(' ');
}
