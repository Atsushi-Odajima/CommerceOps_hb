type Tone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | '';

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  imported: { label: '取込済', tone: '' },
  validation_required: { label: '要確認', tone: 'danger' },
  ready_for_allocation: { label: '引当待ち', tone: 'warning' },
  partially_allocated: { label: '一部引当', tone: 'warning' },
  allocated: { label: '引当済', tone: 'info' },
  on_hold: { label: '保留', tone: 'danger' },
  picking: { label: 'ピッキング中', tone: 'primary' },
  picked: { label: 'ピック済', tone: 'primary' },
  packing: { label: '梱包中', tone: 'primary' },
  packed: { label: '梱包済', tone: 'info' },
  partially_shipped: { label: '一部出荷', tone: 'success' },
  shipped: { label: '出荷済', tone: 'success' },
  cancelled: { label: 'キャンセル', tone: '' },
  return_in_progress: { label: '返品対応中', tone: 'warning' },
  closed: { label: '完了', tone: '' },
};

export const FULFILLMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  ready: { label: 'Wave待ち', tone: 'info' },
  waved: { label: 'Wave投入済', tone: 'primary' },
  picking: { label: 'ピッキング中', tone: 'primary' },
  picked: { label: 'ピック済', tone: 'primary' },
  packing: { label: '梱包中', tone: 'primary' },
  packed: { label: '梱包済', tone: 'info' },
  shipped: { label: '出荷済', tone: 'success' },
  cancelled: { label: 'キャンセル', tone: '' },
};

export const WAVE_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: '未着手', tone: 'info' },
  picking: { label: 'ピッキング中', tone: 'primary' },
  picked: { label: 'ピック完了', tone: 'success' },
  completed: { label: '完了', tone: 'success' },
  cancelled: { label: '取消', tone: '' },
};

export const PICK_TASK_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: '未着手', tone: 'info' },
  in_progress: { label: '作業中', tone: 'primary' },
  completed: { label: '完了', tone: 'success' },
  cancelled: { label: '取消', tone: '' },
};

export const SHIPMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '出荷待ち', tone: 'warning' },
  shipped: { label: '出荷済', tone: 'success' },
  cancelled: { label: '取消', tone: '' },
};

export const RETURN_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: '受付', tone: 'info' },
  authorized: { label: '承認済', tone: 'info' },
  in_transit: { label: '返送中', tone: 'primary' },
  received: { label: '到着（検品待ち）', tone: 'warning' },
  inspecting: { label: '検品中', tone: 'warning' },
  completed: { label: '完了', tone: 'success' },
  rejected: { label: '却下', tone: 'danger' },
  cancelled: { label: '取消', tone: '' },
};

export const RETURN_REASON: Record<string, string> = {
  changed_mind: 'お客様都合',
  defective: '不良品',
  wrong_item: '誤配送・商品違い',
  damaged_in_transit: '配送中の破損',
  size_issue: 'サイズ違い',
  other: 'その他',
};

export const DISPOSITION: Record<string, { label: string; tone: Tone; help: string }> = {
  restock: { label: '再販可（Restock）', tone: 'success', help: '販売可能在庫に戻します' },
  damaged: { label: '破損（Damaged）', tone: 'danger', help: '破損ロケーションへ。販売可能在庫には戻りません' },
  quarantine: { label: '保留（Quarantine）', tone: 'warning', help: '返品保留ロケーションへ。後で判断します' },
  discard: { label: '廃棄（Discard）', tone: '', help: '在庫に戻しません（記録のみ）' },
};

export const HOLD_REASON: Record<string, string> = {
  address_check: '住所確認',
  stock_shortage: '欠品',
  customer_confirm: '顧客確認',
  payment_check: '支払確認',
  fraud_check: '不正注文確認',
  other: 'その他',
};

export const EXCEPTION_TYPE: Record<string, string> = {
  shortage: '欠品',
  short_pick: 'Short Pick',
  address_invalid: '住所不備',
  forced_pack: '強制梱包',
  inventory_mismatch: '在庫不整合',
  return_discrepancy: '返品差異',
  tracking_duplicate: '追跡番号重複',
  import_conflict: '取込競合',
  cancel_putback: 'キャンセル棚戻し',
  field_report: '現場報告',
  other: 'その他',
};

export const EXCEPTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: '未対応', tone: 'danger' },
  investigating: { label: '調査中', tone: 'warning' },
  resolved: { label: '解決', tone: 'success' },
  ignored: { label: '対応不要', tone: '' },
};

export const RESOLUTION_CODE: Record<string, string> = {
  fixed: '修正済み',
  stock_adjusted: '在庫を調整',
  reallocated: '再引当・再割当',
  address_corrected: '住所を修正',
  customer_contacted: 'お客様に連絡済み',
  duplicate: '重複',
  auto: '自動解決',
  other: 'その他',
};

export const SEVERITY: Record<string, { label: string; tone: Tone }> = {
  high: { label: '高', tone: 'danger' },
  medium: { label: '中', tone: 'warning' },
  low: { label: '低', tone: '' },
};

export const SHORT_REASON: Record<string, string> = {
  not_found: '現物なし',
  damaged: '破損',
  wrong_location: 'Location違い',
  qty_short: '数量不足',
  other: 'その他',
};

export const CHANNEL_TYPE: Record<string, string> = {
  shopify: 'Shopify',
  amazon: 'Amazon',
  rakuten: '楽天',
  base: 'BASE',
  stores: 'STORES',
  own_site: '自社EC',
  wholesale: '卸',
  manual: '手動',
  other: 'その他',
};

export const LOCATION_KIND: Record<string, string> = {
  pick: '販売可能（ピック）',
  quarantine: '返品保留',
  damaged: '破損',
};

export const IMPORT_CLASS: Record<string, { label: string; tone: Tone; help: string }> = {
  new: { label: '新規', tone: 'success', help: '新しい注文として取り込みます' },
  identical: { label: '重複（同一）', tone: '', help: '取込済みと同じ内容のためスキップします' },
  update_candidate: { label: '更新候補', tone: 'warning', help: '内容が変わっています。適用を選んだ場合のみ更新します' },
  conflict: { label: '競合', tone: 'danger', help: '作業が進んでいるため更新しません。例外キューに登録します' },
  cancel_candidate: { label: '取消候補', tone: 'danger', help: '自動キャンセルしません。例外キューで判断します' },
  invalid: { label: 'エラー', tone: 'danger', help: '検証エラーがあります' },
};

export const CARRIERS = [
  { value: 'yamato', label: 'ヤマト運輸' },
  { value: 'sagawa', label: '佐川急便' },
  { value: 'japanpost', label: '日本郵便' },
  { value: 'seino', label: '西濃運輸' },
  { value: 'fukutsu', label: '福山通運' },
  { value: 'other', label: 'その他' },
];

export const carrierLabel = (v: string | null | undefined) => CARRIERS.find((c) => c.value === v)?.label ?? v ?? '—';

export const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner（オーナー）' },
  { value: 'ops_manager', label: 'Operations Manager（運用管理）' },
  { value: 'picker', label: 'Picker（ピッキング）' },
  { value: 'packer', label: 'Packer（梱包）' },
  { value: 'support', label: 'Customer Support（顧客対応）' },
];
