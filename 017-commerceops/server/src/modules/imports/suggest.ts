import type { Mapping, TargetField } from './mapping.js';

/**
 * ヘッダー名からマッピング候補を提案する（ユーザーが確認・修正して保存する前提の補助機能）。
 * 特定 EC の CSV 仕様を決め打ちするものではなく、一般的な列名の同義語辞書による推定。
 */
const SYNONYMS: Record<TargetField, string[]> = {
  externalOrderId: ['注文番号', '受注番号', '注文id', '注文no', 'オーダー番号', 'order id', 'order_id', 'orderid', 'order number', 'order_number', 'order no', 'name'],
  orderDate: ['注文日時', '注文日', '受注日時', '受注日', '購入日時', '購入日', 'order date', 'order_date', 'created at', 'created_at', 'purchase date', 'purchase-date', 'date'],
  customerName: ['購入者名', '注文者名', '注文者氏名', '購入者氏名', '顧客名', 'お客様名', 'customer name', 'customer_name', 'buyer name', 'buyer-name', 'billing name'],
  customerEmail: ['購入者メール', '注文者メールアドレス', 'メールアドレス', 'メール', 'email', 'e-mail', 'customer email', 'buyer-email', 'buyer email'],
  customerPhone: ['購入者電話番号', '注文者電話番号', '購入者電話', 'customer phone', 'buyer phone', 'buyer-phone-number', 'billing phone'],
  channelCustomerId: ['顧客id', '会員id', '会員番号', 'customer id', 'customer_id'],
  recipientName: ['送付先氏名', '送付先名', 'お届け先氏名', 'お届け先名', '配送先氏名', '配送先名', '届け先名', 'recipient name', 'recipient-name', 'shipping name', 'ship name'],
  postalCode: ['送付先郵便番号', 'お届け先郵便番号', '配送先郵便番号', '郵便番号', '〒', 'postal code', 'postal_code', 'zip', 'ship-postal-code', 'shipping zip'],
  prefecture: ['送付先都道府県', 'お届け先都道府県', '配送先都道府県', '都道府県', 'prefecture', 'ship-state', 'shipping province', 'state'],
  city: ['送付先市区町村', 'お届け先市区町村', '市区町村', 'city', 'ship-city', 'shipping city'],
  address1: ['送付先住所1', 'お届け先住所1', '配送先住所1', '送付先住所', 'お届け先住所', '配送先住所', '住所1', '住所', 'address1', 'address 1', 'ship-address-1', 'shipping address1', 'shipping street'],
  address2: ['送付先住所2', 'お届け先住所2', '配送先住所2', '住所2', '建物名', 'address2', 'address 2', 'ship-address-2', 'shipping address2'],
  recipientPhone: ['送付先電話番号', 'お届け先電話番号', '配送先電話番号', '電話番号', 'phone', 'ship-phone-number', 'shipping phone'],
  shippingMethod: ['配送方法', '配送方法名', '発送方法', 'shipping method', 'ship-service-level', 'shipping_method'],
  notes: ['備考', '注文備考', 'メモ', 'コメント', 'notes', 'note', 'comment'],
  priority: ['優先度', 'priority'],
  cancelFlag: ['キャンセル', 'キャンセルフラグ', '取消', 'ステータス', 'cancelled', 'canceled', 'cancel', 'status'],
  sku: ['sku', '商品コード', '品番', '商品番号', 'sku code', 'item sku', 'lineitem sku', 'seller-sku'],
  productName: ['商品名', '品名', 'item name', 'product name', 'lineitem name', 'product-name', 'title'],
  quantity: ['数量', '個数', '注文数', 'quantity', 'qty', 'lineitem quantity', 'quantity-purchased'],
  unitPrice: ['単価', '価格', '販売価格', 'unit price', 'price', 'lineitem price', 'item-price'],
  variant: ['バリエーション', 'サイズ・カラー', '項目選択肢', 'variant', 'option', 'variation'],
  externalLineId: ['明細id', '明細番号', 'line id', 'line_id', 'order-item-id', 'lineitem id'],
};

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_\-・()（）]/g, '');

export function suggestMapping(headers: string[]): { mapping: Mapping; matched: Record<string, string> } {
  const mapping: Mapping = {};
  const matched: Record<string, string> = {};
  const used = new Set<string>();
  const normHeaders = headers.map((h) => ({ raw: h, n: norm(h) }));
  for (const [field, words] of Object.entries(SYNONYMS) as [TargetField, string[]][]) {
    // 完全一致を優先、次に部分一致（送付先系を先に拾うため辞書順を保持）
    let hit = normHeaders.find((h) => !used.has(h.raw) && words.some((w) => norm(w) === h.n));
    if (!hit) hit = normHeaders.find((h) => !used.has(h.raw) && h.n.length >= 2 && words.some((w) => norm(w).length >= 3 && h.n.includes(norm(w))));
    if (hit) {
      used.add(hit.raw);
      mapping[field] = { source: { column: hit.raw }, transforms: [] };
      matched[field] = hit.raw;
    }
  }
  return { mapping, matched };
}
