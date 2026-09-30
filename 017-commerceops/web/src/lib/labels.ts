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

/** 監査ログの操作名（未登録の操作はコードをそのまま表示） */
export const AUDIT_ACTION: Record<string, string> = {
  'org.update': '組織設定を変更',
  'warehouse.create': '倉庫を追加',
  'warehouse.update': '倉庫を変更',
  'location.create': 'ロケーションを追加',
  'location.bulk_create': 'ロケーションを一括追加',
  'location.update': 'ロケーションを変更',
  'channel.create': 'チャネルを追加',
  'channel.update': 'チャネルを変更',
  'import_profile.create': 'Import Profile を追加',
  'import_profile.update': 'Import Profile を変更',
  'product.create': '商品を追加',
  'product.update': '商品を変更',
  'product.import': '商品を CSV 取込',
  'product.barcode_add': 'バーコードを追加',
  'product.barcode_remove': 'バーコードを削除',
  'user.invite': 'ユーザーを招待',
  'user.invite_revoke': '招待を取消',
  'user.membership_update': '権限・状態を変更',
  'user.password_reset_issued': 'パスワード再設定リンクを発行',
  'import.preview': '注文 CSV をプレビュー',
  'import.commit': '注文 CSV を確定',
  'import.cancel': '取込を取消',
  'order.create_manual': '注文を手動登録',
  'order.import_update': '再取込で注文を更新',
  'order.update': '注文を変更',
  'order.address_change': '送付先を変更',
  'order.item_remap': '明細の商品を付け替え',
  'order.hold': '保留にした',
  'order.hold_release': '保留を解除',
  'order.cancel': '注文をキャンセル',
  'order.cancel_lines': '明細をキャンセル',
  'customer.update': '顧客情報を変更',
  'inventory.receipt': '入荷を登録',
  'inventory.adjust': '在庫を調整',
  'inventory.transfer': 'ロケーション移動',
  'inventory.import': '在庫を CSV 取込',
  'inventory.held_found': '保留在庫を「発見」で解除',
  'inventory.held_loss': '保留在庫を「紛失」で確定',
  'allocation.allocate': '引当',
  'fulfillment.release': 'Fulfillment を作成',
  'fulfillment.resolve_short': 'Short Pick を処理',
  'wave.create': 'Wave を作成',
  'wave.cancel': 'Wave を取消',
  'wave.assign': 'Wave の担当を割当',
  'pick_task.claim': 'Pick タスクを担当',
  'pick_task.assign': 'Pick タスクを割当',
  'pick_task.release': 'Pick タスクを解放',
  'pick_task.claim_timeout': 'Pick タスクの期限切れ解放',
  'pick.short': 'Short Pick',
  'pick.correct': 'Pick を訂正',
  'pack.start': '梱包を開始',
  'pack.takeover': '梱包を引き継ぎ',
  'pack.complete': '梱包を完了',
  'pack.force_complete': '梱包を強制完了',
  'pack.cancel': '梱包を中止',
  'pack.unpack': '梱包を取消',
  'shipment.update': '配送情報を更新',
  'shipment.tracking_correct': '追跡番号を訂正（出荷後）',
  'shipment.confirm': '出荷確定',
  'shipment.tracking_import': '追跡番号を CSV 取込',
  'return.create': '返品を受付',
  'return.authorize': '返品を承認',
  'return.reject': '返品を却下',
  'return.cancel': '返品を取消',
  'return.in_transit': '返品を返送中に',
  'return.receive': '返品の到着を登録',
  'return.inspect': '返品を検品',
  'return.photo_upload': '検品写真を追加',
  'exchange.create': '交換を作成',
  'exception.assign': '例外の担当を割当',
  'exception.status': '例外の状態を変更',
  'export.orders': '注文 CSV を出力',
  'export.returns': '返品 CSV を出力',
  'export.inventory': '在庫 CSV を出力',
  'export.shipments': '出荷 CSV を出力',
  'export.exceptions': '例外 CSV を出力',
  'export.kpi': 'KPI CSV を出力',
  'export.audit': '監査ログ CSV を出力',
  'backup.export': 'バックアップをダウンロード',
  'backup.restore': 'バックアップから復元',
  'backup.restore_started_here': 'この組織から復元を実行',
};

export const AUDIT_PREFIX: Record<string, string> = {
  org: '組織',
  warehouse: '倉庫',
  location: 'ロケーション',
  channel: 'チャネル',
  import_profile: 'Import Profile',
  product: '商品',
  user: 'ユーザー・権限',
  import: '注文取込',
  order: '注文',
  customer: '顧客',
  inventory: '在庫',
  allocation: '引当',
  fulfillment: 'Fulfillment',
  wave: 'Wave',
  pick_task: 'Pick タスク',
  pick: 'ピッキング',
  pack: '梱包',
  shipment: '出荷',
  return: '返品',
  exchange: '交換',
  exception: '例外',
  export: 'CSV 出力',
  backup: 'バックアップ',
  test: 'テスト',
};

export const AUDIT_ENTITY: Record<string, string> = {
  organization: '組織',
  warehouse: '倉庫',
  location: 'ロケーション',
  product: '商品',
  sales_channel: 'チャネル',
  import_profile: 'Import Profile',
  import_batch: '取込',
  customer: '顧客',
  order: '注文',
  inventory: '在庫',
  inventory_balance: '在庫',
  fulfillment: 'Fulfillment',
  wave: 'Wave',
  pick_task: 'Pick タスク',
  pack_session: '梱包',
  shipment: '出荷',
  return: '返品',
  exchange: '交換',
  exception: '例外',
  user: 'ユーザー',
  invitation: '招待',
  kpi: 'KPI',
  audit_log: '監査ログ',
};

/** 監査ログの対象 → 画面へのリンク */
export function auditEntityLink(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const map: Record<string, string> = {
    order: `/orders/${entityId}`,
    return: `/returns/${entityId}`,
    shipment: `/shipments/${entityId}`,
    wave: `/waves/${entityId}`,
    exception: `/exceptions/${entityId}`,
    import_batch: `/imports/${entityId}`,
    import_profile: `/settings/import-profiles/${entityId}`,
  };
  return map[entityType] ?? null;
}

export const BACKUP_TABLE_LABEL: Record<string, string> = {
  warehouses: '倉庫',
  locations: 'ロケーション',
  products: '商品',
  product_barcodes: 'バーコード',
  sales_channels: '販売チャネル',
  import_profiles: 'Import Profile',
  customers: '顧客',
  import_batches: '取込履歴',
  orders: '注文',
  order_items: '注文明細',
  holds: '保留',
  inventory_balances: '在庫（ロケーション別）',
  inventory_movements: '在庫の動き',
  allocations: '引当',
  fulfillments: 'Fulfillment',
  waves: 'Wave',
  pick_tasks: 'Pick タスク',
  pick_events: 'Pick 記録',
  pack_sessions: '梱包',
  pack_events: '梱包 scan 記録',
  shipments: '出荷（荷物）',
  returns: '返品',
  return_inspections: '返品検品',
  exchanges: '交換',
  exception_cases: '例外',
  attachments: '添付写真',
  audit_logs: '監査ログ',
};
