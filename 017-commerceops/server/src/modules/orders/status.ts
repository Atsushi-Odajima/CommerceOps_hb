/**
 * 注文状態: 事実から導出 → 許可遷移で検証 → 保存・履歴（docs/FULFILLMENT_RULES.md）
 */
import type { Tx } from '../../db/tx.js';
import { AppError } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';

export const ORDER_STATUSES = [
  'imported',
  'validation_required',
  'ready_for_allocation',
  'partially_allocated',
  'allocated',
  'on_hold',
  'picking',
  'picked',
  'packing',
  'packed',
  'partially_shipped',
  'shipped',
  'cancelled',
  'return_in_progress',
  'closed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 進行段階の順位（前進は常に許可、出荷前段階どうしの後退は差戻しとして許可） */
const RANK: Partial<Record<OrderStatus, number>> = {
  ready_for_allocation: 1,
  partially_allocated: 2,
  allocated: 3,
  picking: 4,
  picked: 5,
  packing: 6,
  packed: 7,
  partially_shipped: 8,
  shipped: 9,
};

export function isAllowedTransition(from: OrderStatus | null, to: OrderStatus): boolean {
  if (from === to) return true;
  if (from === null) return to === 'imported';
  if (from === 'cancelled') return false;
  switch (to) {
    case 'imported':
      return false;
    case 'cancelled':
      // 出荷済み（一部含む）・返品中・クローズからは取消しない（返品で扱う）
      return !['partially_shipped', 'shipped', 'return_in_progress', 'closed'].includes(from);
    case 'on_hold':
      return !['closed'].includes(from);
    case 'validation_required':
      return from === 'imported' || from === 'ready_for_allocation' || from === 'on_hold';
    case 'return_in_progress':
      return ['partially_shipped', 'shipped', 'closed', 'on_hold'].includes(from);
    case 'closed':
      return ['shipped', 'return_in_progress'].includes(from);
    default:
      break;
  }
  // 進行段階への遷移
  const toRank = RANK[to]!;
  if (from === 'imported' || from === 'validation_required' || from === 'on_hold') return toRank <= 9;
  if (from === 'return_in_progress') return to === 'shipped' || to === 'partially_shipped';
  if (from === 'closed') return false;
  const fromRank = RANK[from]!;
  if (toRank > fromRank) return true;
  // 後退: 出荷が始まった後（一部出荷・出荷済）は出荷前段階に戻らない
  return fromRank <= 7;
}

export interface OrderFacts {
  status: OrderStatus;
  cancelledAt: Date | null;
  closedAt: Date | null;
  validationErrorCount: number;
  onHold: boolean;
  openReturn: boolean;
  effectiveQty: number;
  shippedQty: number;
  allocatedQty: number;
  unreleasedQty: number;
  fulfillmentStatuses: string[];
}

const FF_STAGE: Record<string, OrderStatus> = {
  ready: 'allocated',
  waved: 'picking',
  picking: 'picking',
  picked: 'picked',
  packing: 'packing',
  packed: 'packed',
};

export function deriveOrderStatus(f: OrderFacts): OrderStatus {
  if (f.cancelledAt) return 'cancelled';
  if (f.closedAt) return 'closed';
  if (f.onHold) return 'on_hold';
  if (f.openReturn) return 'return_in_progress';
  if (f.effectiveQty <= 0) return 'cancelled';
  if (f.validationErrorCount > 0 && f.shippedQty === 0 && f.allocatedQty === 0) return 'validation_required';
  if (f.shippedQty >= f.effectiveQty) return 'shipped';
  if (f.shippedQty > 0) return 'partially_shipped';
  const remaining = f.effectiveQty - f.shippedQty;
  if (f.allocatedQty < remaining) return f.allocatedQty > 0 ? 'partially_allocated' : 'ready_for_allocation';
  const stages: OrderStatus[] = f.fulfillmentStatuses.map((s) => FF_STAGE[s]).filter((s): s is OrderStatus => !!s);
  if (f.unreleasedQty > 0) stages.push('allocated');
  if (!stages.length) return 'allocated';
  return stages.reduce((min, s) => (RANK[s]! < RANK[min]! ? s : min));
}

export async function loadOrderFacts(tx: Tx, orderId: string, lock = true): Promise<OrderFacts> {
  const o = await tx.maybeOne(
    `SELECT status, cancelled_at, closed_at, jsonb_array_length(validation_errors) AS verr
       FROM orders WHERE organization_id = $1 AND id = $2 ${lock ? 'FOR NO KEY UPDATE' : ''}`, // 子行 INSERT の KEY SHARE と衝突させない（fulfillment/status.ts 参照）
    [tx.orgId, orderId],
  );
  if (!o) throw new AppError(404, 'NOT_FOUND', '注文が見つかりません');
  const r = await tx.one(
    `SELECT
       EXISTS (SELECT 1 FROM holds h WHERE h.organization_id = $1 AND h.order_id = $2 AND h.released_at IS NULL) AS on_hold,
       EXISTS (SELECT 1 FROM returns r WHERE r.organization_id = $1 AND r.order_id = $2
                 AND r.status IN ('requested', 'authorized', 'in_transit', 'received', 'inspecting')) AS open_return,
       (SELECT COALESCE(SUM(quantity - cancelled_qty), 0)::int FROM order_items WHERE organization_id = $1 AND order_id = $2) AS effective_qty,
       (SELECT COALESCE(SUM(shipped_qty), 0)::int FROM order_items WHERE organization_id = $1 AND order_id = $2) AS shipped_qty,
       (SELECT COALESCE(SUM(allocated_qty), 0)::int FROM order_items WHERE organization_id = $1 AND order_id = $2) AS allocated_qty,
       (SELECT COALESCE(SUM(quantity - shipped_qty - released_qty), 0)::int FROM allocations
         WHERE organization_id = $1 AND order_id = $2 AND status = 'active' AND fulfillment_item_id IS NULL) AS unreleased_qty,
       (SELECT COALESCE(array_agg(DISTINCT status), '{}') FROM fulfillments
         WHERE organization_id = $1 AND order_id = $2 AND status NOT IN ('cancelled', 'shipped')) AS ff_statuses`,
    [tx.orgId, orderId],
  );
  return {
    status: o.status,
    cancelledAt: o.cancelled_at,
    closedAt: o.closed_at,
    validationErrorCount: Number(o.verr),
    onHold: r.on_hold,
    openReturn: r.open_return,
    effectiveQty: r.effective_qty,
    shippedQty: r.shipped_qty,
    allocatedQty: r.allocated_qty,
    unreleasedQty: r.unreleased_qty,
    fulfillmentStatuses: r.ff_statuses ?? [],
  };
}

export async function insertStatusHistory(
  tx: Tx,
  orderId: string,
  from: OrderStatus | null,
  to: OrderStatus,
  reason: string | null,
) {
  await tx.exec(
    `INSERT INTO order_status_history (organization_id, id, order_id, from_status, to_status, reason, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tx.orgId, uuidv7(), orderId, from, to, reason?.slice(0, 300) ?? null, tx.actor.userId],
  );
}

/** 事実から状態を再計算し、変わった場合は検証して保存・履歴記録する */
export async function recomputeOrderStatus(
  tx: Tx,
  orderId: string,
  reason: string,
): Promise<{ from: OrderStatus; to: OrderStatus; changed: boolean }> {
  const facts = await loadOrderFacts(tx, orderId);
  const to = deriveOrderStatus(facts);
  const from = facts.status;
  if (to === from) return { from, to, changed: false };
  if (!isAllowedTransition(from, to)) {
    throw new AppError(409, 'INVALID_TRANSITION', `注文状態を ${from} から ${to} に変更できません`, { from, to, reason });
  }
  await tx.exec(
    `UPDATE orders SET status = $3, status_changed_at = now(), updated_at = now(), version = version + 1
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, orderId, to],
  );
  await insertStatusHistory(tx, orderId, from, to, reason);
  return { from, to, changed: true };
}
