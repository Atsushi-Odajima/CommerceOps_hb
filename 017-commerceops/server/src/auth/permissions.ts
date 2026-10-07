/**
 * 権限定義の唯一の正（docs/RBAC.md はこの写し）。
 * UI の表示制御にも /api/auth/me で permissions を返して使うが、判定は必ずサーバー側で行う。
 */
export const PERMISSIONS = [
  'org.manage',
  'users.manage',
  'warehouses.manage',
  'channels.manage',
  'backup.manage',
  'products.read',
  'products.manage',
  'customers.manage',
  'orders.read',
  'orders.read_pii',
  'orders.read_ship_to',
  'orders.import',
  'orders.edit',
  'orders.hold',
  'orders.cancel',
  'inventory.read',
  'inventory.adjust',
  'purchasing.read',
  'purchasing.manage',
  'stocktake.count',
  'stocktake.confirm',
  'allocation.manage',
  'fulfillment.manage',
  'waves.read',
  'waves.manage',
  'pick.execute',
  'pack.execute',
  'pack.force_complete',
  'shipments.read',
  'shipments.manage',
  'returns.read',
  'returns.request',
  'returns.receive',
  'returns.inspect',
  'exchanges.create',
  'exceptions.read',
  'exceptions.report',
  'exceptions.manage',
  'kpi.read',
  'audit.read',
  'export.csv',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'ops_manager', 'picker', 'packer', 'support'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner（オーナー）',
  ops_manager: 'Operations Manager（運用管理）',
  picker: 'Picker（ピッキング）',
  packer: 'Packer（梱包）',
  support: 'Customer Support（顧客対応）',
};

const OWNER_ONLY: Permission[] = ['org.manage', 'users.manage', 'warehouses.manage', 'channels.manage', 'backup.manage'];

const OPS_MANAGER: Permission[] = PERMISSIONS.filter((p) => !OWNER_ONLY.includes(p));

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  ops_manager: new Set(OPS_MANAGER),
  picker: new Set<Permission>(['products.read', 'waves.read', 'pick.execute', 'exceptions.report', 'stocktake.count']),
  packer: new Set<Permission>([
    'products.read',
    'pack.execute',
    'orders.read_ship_to',
    'shipments.read',
    'returns.receive',
    'exceptions.report',
  ]),
  support: new Set<Permission>([
    'products.read',
    'customers.manage',
    'orders.read',
    'orders.read_pii',
    'orders.read_ship_to',
    'orders.edit',
    'orders.hold',
    'inventory.read',
    'shipments.read',
    'returns.read',
    'returns.request',
    'exchanges.create',
    'exceptions.read',
    'exceptions.report',
  ]),
};

export function permissionsFor(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
