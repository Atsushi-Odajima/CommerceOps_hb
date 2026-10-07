/**
 * 組織単位バックアップの形式（docs/DECISIONS.md ADR-012）
 * gzip 圧縮した NDJSON:
 *   1 行目   {"type":"header", format, formatVersion, schemaVersion, appVersion, createdAt, organization}
 *   次に     {"type":"user", d} / {"type":"membership", d}
 *   本体     {"type":"row", t: テーブル名, d: 行（organization_id を除く）}  ※テーブルは FK 依存順（親 → 子）
 *   添付     {"type":"file", id, sha256, data: base64}
 *   最終行   {"type":"trailer", counts, tableSha256, users, memberships, files, sha256}
 * sha256 は trailer より前の各行（行末 \n を含む）の SHA-256。tableSha256 はテーブルごとの行の SHA-256。
 * ZIP は扱わない（Zip Slip / パストラバーサルを構造的に排除）。
 */
export const BACKUP_FORMAT = 'commerceops-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** バックアップ対象（FK 依存順）。組織に属するすべての業務テーブル */
export const BACKUP_TABLES = [
  'warehouses',
  'locations',
  'suppliers',
  'products',
  'product_replenishment',
  'product_barcodes',
  'sales_channels',
  'import_profiles',
  'customers',
  'import_batches',
  'orders',
  'order_items',
  'import_batch_orders',
  'order_status_history',
  'order_address_history',
  'holds',
  'inventory_balances',
  'purchase_orders',
  'purchase_order_lines',
  'stocktakes',
  'stocktake_lines',
  'allocation_runs',
  'waves',
  'fulfillments',
  'fulfillment_items',
  'allocations',
  'wave_fulfillments',
  'pick_tasks',
  'pick_task_lines',
  'pick_events',
  'pack_sessions',
  'pack_events',
  'shipments',
  'shipment_items',
  'returns',
  'return_items',
  'return_inspections',
  'exchanges',
  'exchange_items',
  'inventory_movements',
  'exception_cases',
  'exception_events',
  'attachments',
  'audit_logs',
  'counters',
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];

/** organization_id を持つが対象外のテーブル（認証・一時データ・キュー・バックアップ履歴） */
export const EXCLUDED_TENANT_TABLES = ['memberships', 'invitations', 'sessions', 'jobs', 'backup_runs'] as const;

/** 各テーブルの主キー（organization_id を除く）。キーセットページングに使用 */
export const PRIMARY_KEYS: Record<BackupTable, string[]> = Object.fromEntries(BACKUP_TABLES.map((t) => [t, ['id']])) as Record<BackupTable, string[]>;
PRIMARY_KEYS.counters = ['name'];
PRIMARY_KEYS.wave_fulfillments = ['wave_id', 'fulfillment_id'];

/** ユーザー ID を持つ列（別環境への復元でメールアドレスによりユーザーを対応付けた場合に付け替える） */
export const USER_COLUMNS: Partial<Record<BackupTable, string[]>> = {
  allocation_runs: ['started_by'],
  allocations: ['created_by', 'released_by'],
  attachments: ['created_by'],
  audit_logs: ['actor_user_id'],
  exception_cases: ['assignee_user_id', 'created_by', 'resolved_by'],
  exception_events: ['actor_user_id'],
  exchanges: ['created_by'],
  fulfillments: ['created_by'],
  holds: ['placed_by', 'released_by'],
  import_batches: ['committed_by', 'created_by'],
  import_profiles: ['updated_by'],
  inventory_movements: ['actor_user_id'],
  order_address_history: ['changed_by'],
  order_status_history: ['actor_user_id'],
  orders: ['cancelled_by', 'created_by'],
  pack_events: ['packer_user_id'],
  pack_sessions: ['forced_by', 'packer_user_id'],
  pick_events: ['picker_user_id'],
  pick_tasks: ['assignee_user_id'],
  purchase_orders: ['created_by'],
  stocktakes: ['started_by', 'confirmed_by'],
  return_inspections: ['inspector_user_id'],
  returns: ['authorized_by', 'cancelled_by', 'received_by', 'rejected_by', 'requested_by'],
  shipments: ['confirmed_by'],
  waves: ['cancelled_by', 'created_by'],
};

export interface BackupHeader {
  type: 'header';
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  organization: { id: string; name: string; timezone: string; isSample: boolean; settings: unknown };
}

export interface BackupTrailer {
  type: 'trailer';
  counts: Record<string, number>;
  tableSha256: Record<string, string>;
  users: number;
  memberships: number;
  files: number;
  sha256: string;
}
