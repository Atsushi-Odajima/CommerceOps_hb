/**
 * 引当エンジン（docs/ALLOCATION_ENGINE.md）
 * - 1 注文 = 1 トランザクション。注文行 FOR UPDATE → 残必要数を再計算 → 条件付き UPDATE で在庫確保
 * - 説明可能なルール: 全量が揃う倉庫を優先 → 揃わなければ最も多く揃う倉庫で一部引当（設定で可否）
 * - 複数倉庫への分割は自動確定しない（候補として提示し、人間が倉庫指定で実行）
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { withTenant, type Actor } from '../../db/tx.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import { autoResolveException, createException } from '../exceptions/service.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { parseOrgSettings } from '../../auth/context.js';

export type AllocationReason = 'FULL_SINGLE_WAREHOUSE' | 'PARTIAL' | 'MANUAL_WAREHOUSE' | 'REALLOCATE';

interface ItemNeed {
  id: string;
  productId: string;
  sku: string;
  need: number;
}

interface Avail {
  balanceId: string;
  warehouseId: string;
  locationId: string;
  productId: string;
  available: number;
  pickSequence: number;
  locationCode: string;
  warehousePriority: number;
  warehouseCode: string;
}

export interface WarehousePlan {
  warehouseId: string;
  warehouseCode: string;
  warehouseName?: string;
  items: { orderItemId: string; sku: string; need: number; available: number }[];
  satisfiableUnits: number;
  needUnits: number;
  canFulfillAll: boolean;
}

export interface OrderAllocationResult {
  orderId: string;
  outcome: 'full' | 'partial' | 'none' | 'skipped' | 'already';
  reason?: string;
  allocatedUnits: number;
  remainingUnits: number;
  warehouseId?: string;
  released?: string[];
  splitCandidates?: { warehouseCode: string; units: number }[];
}

/** 未引当の残数量を持ちうる状態（一部出荷後の残りも対象） */
export const ALLOCATABLE_STATUSES = new Set(['ready_for_allocation', 'partially_allocated', 'partially_shipped']);

async function loadNeeds(tx: Tx, orderId: string): Promise<ItemNeed[]> {
  const items = await tx.many(
    `SELECT id, product_id, sku, quantity - cancelled_qty - shipped_qty - allocated_qty AS need
       FROM order_items WHERE organization_id = $1 AND order_id = $2 ORDER BY line_no`,
    [tx.orgId, orderId],
  );
  return items.filter((i) => i.product_id && i.need > 0).map((i) => ({ id: i.id, productId: i.product_id, sku: i.sku, need: i.need }));
}

async function loadAvailability(tx: Tx, productIds: string[], warehouseId?: string): Promise<Avail[]> {
  if (!productIds.length) return [];
  const rows = await tx.many(
    `SELECT ib.id, ib.warehouse_id, ib.location_id, ib.product_id, ib.on_hand - ib.allocated - ib.held AS available,
            l.pick_sequence, l.code AS location_code, w.priority, w.code AS warehouse_code
       FROM inventory_balances ib
       JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
       JOIN warehouses w ON w.organization_id = ib.organization_id AND w.id = ib.warehouse_id
      WHERE ib.organization_id = $1 AND ib.product_id = ANY($2) AND l.kind = 'pick' AND l.active AND w.active
        AND ib.on_hand - ib.allocated - ib.held > 0 AND ($3::uuid IS NULL OR ib.warehouse_id = $3)`,
    [tx.orgId, productIds, warehouseId ?? null],
  );
  return rows.map((r) => ({
    balanceId: r.id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    productId: r.product_id,
    available: r.available,
    pickSequence: r.pick_sequence,
    locationCode: r.location_code,
    warehousePriority: r.priority,
    warehouseCode: r.warehouse_code,
  }));
}

function planWarehouses(needs: ItemNeed[], avail: Avail[], warehouses: { id: string; code: string; name?: string; priority: number }[]): WarehousePlan[] {
  return warehouses.map((w) => {
    const items = needs.map((n) => {
      const available = avail.filter((a) => a.warehouseId === w.id && a.productId === n.productId).reduce((s, a) => s + a.available, 0);
      return { orderItemId: n.id, sku: n.sku, need: n.need, available };
    });
    const satisfiableUnits = items.reduce((s, i) => s + Math.min(i.need, i.available), 0);
    const needUnits = items.reduce((s, i) => s + i.need, 0);
    return { warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, items, satisfiableUnits, needUnits, canFulfillAll: needUnits > 0 && satisfiableUnits === needUnits };
  });
}

/** 倉庫の優先順: この注文の既存引当/Fulfillment の倉庫 → 倉庫優先度 → コード */
async function orderedWarehouses(tx: Tx, orderId: string) {
  return tx.many<{ id: string; code: string; name: string; priority: number; used: boolean }>(
    `SELECT w.id, w.code, w.name, w.priority,
            EXISTS (SELECT 1 FROM allocations a WHERE a.organization_id = w.organization_id AND a.order_id = $2 AND a.warehouse_id = w.id AND a.status <> 'released') AS used
       FROM warehouses w WHERE w.organization_id = $1 AND w.active
      ORDER BY used DESC, w.priority, w.code`,
    [tx.orgId, orderId],
  );
}

/** 引当計画（説明用。在庫は確保しない） */
export async function explainAllocation(tx: Tx, orderId: string) {
  const needs = await loadNeeds(tx, orderId);
  const whs = await orderedWarehouses(tx, orderId);
  const avail = await loadAvailability(tx, [...new Set(needs.map((n) => n.productId))]);
  const plans = planWarehouses(needs, avail, whs);
  const full = plans.find((p) => p.canFulfillAll);
  const best = [...plans].sort((a, b) => b.satisfiableUnits - a.satisfiableUnits)[0];
  let recommendation: string;
  if (!needs.length) recommendation = '引当が必要な数量はありません';
  else if (full) recommendation = `${full.warehouseCode} で全 ${needs.length} 明細が揃うため ${full.warehouseCode} を優先します`;
  else if (best && best.satisfiableUnits > 0) {
    const others = plans.filter((p) => p.warehouseId !== best.warehouseId && p.satisfiableUnits > 0);
    recommendation = `全量が揃う倉庫がありません。${best.warehouseCode} で ${best.satisfiableUnits}/${best.needUnits} 個を一部引当できます` +
      (others.length ? `（残りの分割候補: ${others.map((o) => `${o.warehouseCode} に ${o.satisfiableUnits} 個`).join('、')}）` : '');
  } else recommendation = 'どの倉庫にも引当可能な在庫がありません（欠品）';
  return { needs, plans, recommendation };
}

/** 1 注文を引当（呼び出し側のトランザクション内で実行） */
export async function allocateOrderInTx(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  orderId: string,
  opts: { allowPartial: boolean; autoRelease: boolean; warehouseId?: string; runId?: string | null; reason?: AllocationReason; manual?: boolean },
): Promise<OrderAllocationResult> {
  const order = await tx.maybeOne(`SELECT id, order_number, status, cancelled_at FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  if (!order) throw notFound('注文');
  if (!ALLOCATABLE_STATUSES.has(order.status)) {
    return { orderId, outcome: 'skipped', reason: `状態 ${order.status} のため引当対象外`, allocatedUnits: 0, remainingUnits: 0 };
  }
  // ロック取得後に残必要数を再計算（再実行・同時実行でも二重引当しない）
  const needs = await loadNeeds(tx, orderId);
  const needTotal = needs.reduce((s, n) => s + n.need, 0);
  if (needTotal === 0) return { orderId, outcome: 'already', allocatedUnits: 0, remainingUnits: 0 };

  const whs = (await orderedWarehouses(tx, orderId)).filter((w) => !opts.warehouseId || w.id === opts.warehouseId);
  if (opts.warehouseId && !whs.length) throw notFound('倉庫');
  const avail = await loadAvailability(tx, [...new Set(needs.map((n) => n.productId))], opts.warehouseId);
  const plans = planWarehouses(needs, avail, whs);

  let chosen: WarehousePlan | undefined;
  let reason: AllocationReason;
  if (opts.warehouseId) {
    chosen = plans[0];
    reason = opts.reason ?? 'MANUAL_WAREHOUSE';
  } else {
    chosen = plans.find((p) => p.canFulfillAll);
    reason = 'FULL_SINGLE_WAREHOUSE';
    if (!chosen && opts.allowPartial) {
      const best = plans.reduce<WarehousePlan | undefined>((b, p) => (p.satisfiableUnits > (b?.satisfiableUnits ?? 0) ? p : b), undefined);
      if (best && best.satisfiableUnits > 0) {
        chosen = best;
        reason = 'PARTIAL';
      }
    }
  }

  let allocatedUnits = 0;
  const perItem = new Map<string, number>();
  if (chosen && chosen.satisfiableUnits > 0) {
    const allocRows: unknown[][] = [];
    let current = avail.filter((a) => a.warehouseId === chosen!.warehouseId);
    // 同時実行で予定のロケーションを先に取られた場合は、在庫を再読込して他のロケーションで再試行（最大 5 回）
    for (let attempt = 0; attempt < 5; attempt++) {
      const pending = needs.map((n) => ({ n, rest: n.need - (perItem.get(n.id) ?? 0) })).filter((x) => x.rest > 0);
      if (!pending.length) break;
      if (attempt > 0) current = await loadAvailability(tx, [...new Set(pending.map((p) => p.n.productId))], chosen.warehouseId);
      // ロケーション選択: 1 ロケーションで足りるなら pick_sequence 最小のそこ、足りなければ pick_sequence 順に取り崩す
      const takes: { item: ItemNeed; a: Avail; qty: number }[] = [];
      for (const { n, rest: need } of pending) {
        const cands = current
          .filter((a) => a.productId === n.productId && a.available > 0)
          .sort((x, y) => x.pickSequence - y.pickSequence || x.locationCode.localeCompare(y.locationCode));
        const single = cands.find((c) => c.available >= need);
        if (single) {
          takes.push({ item: n, a: single, qty: need });
          continue;
        }
        let rest = need;
        for (const c of cands) {
          if (rest <= 0) break;
          const q = Math.min(rest, c.available);
          if (q > 0) takes.push({ item: n, a: c, qty: q });
          rest -= q;
        }
      }
      if (!takes.length) break;
      // デッドロック回避: balance ID 順に確保
      takes.sort((x, y) => x.a.balanceId.localeCompare(y.a.balanceId));
      let progressed = false;
      for (const t of takes) {
        const ok = await tx.maybeOne(
          `UPDATE inventory_balances SET allocated = allocated + $3, updated_at = now()
            WHERE organization_id = $1 AND id = $2 AND on_hand - allocated - held >= $3
            RETURNING id`,
          [tx.orgId, t.a.balanceId, t.qty],
        );
        if (!ok) continue; // 先に確保された → 次の試行で再読込
        progressed = true;
        allocRows.push([uuidv7(), t.item.id, t.a.warehouseId, t.a.locationId, t.item.productId, t.a.balanceId, t.qty]);
        perItem.set(t.item.id, (perItem.get(t.item.id) ?? 0) + t.qty);
        allocatedUnits += t.qty;
      }
      if (!progressed && attempt > 0) break;
    }
    if (allocRows.length) {
      const col = (i: number) => allocRows.map((r) => r[i]);
      await tx.exec(
        `INSERT INTO allocations (organization_id, id, order_id, order_item_id, warehouse_id, location_id, product_id, balance_id, quantity, reason,
                                  allocation_run_id, created_by)
         SELECT $1, u.id, $2, u.item, u.wh, u.loc, u.prod, u.bal, u.qty, $10, $11, $12
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[], $9::int[]) AS u(id, item, wh, loc, prod, bal, qty)`,
        [tx.orgId, orderId, col(0), col(1), col(2), col(3), col(4), col(5), col(6), reason, opts.runId ?? null, tx.actor.userId],
      );
      for (const [itemId, q] of perItem) {
        await tx.exec(`UPDATE order_items SET allocated_qty = allocated_qty + $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, itemId, q]);
      }
    }
  }
  await refreshAllocationStatus(tx, orderId);

  const remainingUnits = needTotal - allocatedUnits;
  const splitCandidates = remainingUnits > 0 && !opts.warehouseId
    ? plans.filter((p) => p.warehouseId !== chosen?.warehouseId && p.satisfiableUnits > 0).map((p) => ({ warehouseCode: p.warehouseCode, units: p.satisfiableUnits }))
    : [];
  if (remainingUnits > 0) {
    const shortItems = needs.map((n) => ({ sku: n.sku, short: n.need - (perItem.get(n.id) ?? 0) })).filter((x) => x.short > 0);
    await createException(tx, deps, {
      type: 'shortage',
      title: `欠品: ${order.order_number}（不足 ${remainingUnits} 個）`,
      severity: 'medium',
      dedupeKey: `shortage:${orderId}`,
      orderId,
      detail: { remainingUnits, items: shortItems, splitCandidates },
    });
  } else {
    await autoResolveException(tx, `shortage:${orderId}`, '自動解消: 全量引当');
  }
  await recomputeOrderStatus(tx, orderId, allocatedUnits > 0 ? `引当（${reason}）${allocatedUnits}個` : '引当: 在庫不足');

  let released: string[] | undefined;
  if (opts.autoRelease && remainingUnits === 0) {
    released = await releaseAllocations(tx, deps, orderId, { mode: 'full' });
  }
  if (allocatedUnits > 0) {
    await audit(tx, {
      action: 'allocation.allocate',
      entityType: 'order',
      entityId: orderId,
      summary: `${order.order_number} を ${chosen?.warehouseCode} で ${allocatedUnits}個引当（${reason}）`,
      metadata: { allocatedUnits, remainingUnits, reason, warehouse: chosen?.warehouseCode, runId: opts.runId ?? null },
    });
  }
  return {
    orderId,
    outcome: allocatedUnits === 0 ? 'none' : remainingUnits === 0 ? 'full' : 'partial',
    allocatedUnits,
    remainingUnits,
    warehouseId: chosen?.warehouseId,
    released,
    splitCandidates,
  };
}

/** order_items.allocation_status を数量から更新 */
export async function refreshAllocationStatus(tx: Tx, orderId: string) {
  await tx.exec(
    `UPDATE order_items SET allocation_status = CASE
        WHEN quantity - cancelled_qty - shipped_qty <= 0 THEN 'not_required'
        WHEN allocated_qty >= quantity - cancelled_qty - shipped_qty THEN 'allocated'
        WHEN allocated_qty > 0 THEN 'partial'
        ELSE 'unallocated' END
      WHERE organization_id = $1 AND order_id = $2`,
    [tx.orgId, orderId],
  );
}

/** 倉庫の締切時刻から出荷期限を算出（営業時間が null の曜日は休業としてスキップ） */
export async function computeDueAt(tx: Tx, warehouseId: string, now = new Date()): Promise<Date> {
  const w = await tx.one(`SELECT timezone, cutoff_time, business_hours FROM warehouses WHERE organization_id = $1 AND id = $2`, [tx.orgId, warehouseId]);
  const r = await tx.one(
    `WITH local AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS lt)
     SELECT (lt::date) AS d, (lt::time < $3::time) AS before_cutoff FROM local`,
    [now, w.timezone, w.cutoff_time],
  );
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const hours = (w.business_hours ?? {}) as Record<string, unknown>;
  let offset = r.before_cutoff ? 0 : 1;
  for (let i = 0; i < 8; i++) {
    const probe = new Date(`${r.d}T00:00:00Z`);
    probe.setUTCDate(probe.getUTCDate() + offset);
    const key = days[probe.getUTCDay()]!;
    if (!(key in hours) || hours[key] !== null) break;
    offset++;
  }
  const due = await tx.one(`SELECT ((($1::date + $2::int) + $3::time) AT TIME ZONE $4) AS due`, [r.d, offset, w.cutoff_time, w.timezone]);
  return due.due;
}

/**
 * 未 release の引当を Fulfillment 化（倉庫ごと）。同じ注文・倉庫の ready Fulfillment があれば追記。
 * mode=partial は「揃った分を先行出荷」（一部引当でも実行）。
 */
export async function releaseAllocations(tx: Tx, deps: Pick<AppDeps, 'numberingPool'>, orderId: string, opts: { mode: 'full' | 'partial' }): Promise<string[]> {
  const order = await tx.maybeOne(
    `SELECT o.*, EXISTS (SELECT 1 FROM holds h WHERE h.organization_id = o.organization_id AND h.order_id = o.id AND h.released_at IS NULL) AS on_hold,
            (SELECT h.reason_code FROM holds h WHERE h.organization_id = o.organization_id AND h.order_id = o.id AND h.released_at IS NULL LIMIT 1) AS hold_reason
       FROM orders o WHERE o.organization_id = $1 AND o.id = $2 FOR UPDATE`,
    [tx.orgId, orderId],
  );
  if (!order) throw notFound('注文');
  if (order.cancelled_at) throw conflict('ORDER_CANCELLED', 'キャンセル済みの注文です');
  if (opts.mode === 'full') {
    const remaining = await tx.one(
      `SELECT COALESCE(SUM(quantity - cancelled_qty - shipped_qty - allocated_qty), 0)::int AS n FROM order_items WHERE organization_id = $1 AND order_id = $2`,
      [tx.orgId, orderId],
    );
    if (remaining.n > 0) return [];
  }
  const allocs = await tx.many(
    `SELECT * FROM allocations WHERE organization_id = $1 AND order_id = $2 AND status = 'active' AND fulfillment_item_id IS NULL
      ORDER BY warehouse_id, created_at FOR UPDATE`,
    [tx.orgId, orderId],
  );
  if (!allocs.length) return [];
  const byWh = new Map<string, any[]>();
  for (const a of allocs) byWh.set(a.warehouse_id, [...(byWh.get(a.warehouse_id) ?? []), a]);
  const touched: string[] = [];
  for (const [warehouseId, list] of byWh) {
    let ff = await tx.maybeOne(
      `SELECT * FROM fulfillments WHERE organization_id = $1 AND order_id = $2 AND warehouse_id = $3 AND status = 'ready' ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [tx.orgId, orderId, warehouseId],
    );
    if (!ff) {
      const [number] = await nextNumbers(deps.numberingPool, tx.orgId, 'fulfillment', 1);
      const id = uuidv7();
      const dueAt = order.due_at ?? (await computeDueAt(tx, warehouseId));
      await tx.exec(
        `INSERT INTO fulfillments (organization_id, id, fulfillment_number, order_id, warehouse_id, fulfillment_type, status, on_hold, hold_reason,
                                   priority, due_at, shipping_method, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8, $9, $10, $11, $12)`,
        [
          tx.orgId,
          id,
          number,
          orderId,
          warehouseId,
          order.order_type === 'replacement' ? 'replacement' : 'standard',
          order.on_hold,
          order.hold_reason,
          order.priority,
          dueAt,
          order.shipping_method,
          tx.actor.userId,
        ],
      );
      ff = { id, fulfillment_number: number };
    }
    const qtyByItem = new Map<string, { qty: number; productId: string }>();
    for (const a of list) {
      const open = a.quantity - a.shipped_qty - a.released_qty;
      const cur = qtyByItem.get(a.order_item_id) ?? { qty: 0, productId: a.product_id };
      cur.qty += open;
      qtyByItem.set(a.order_item_id, cur);
    }
    for (const [orderItemId, { qty, productId }] of qtyByItem) {
      const fi = await tx.one(
        `INSERT INTO fulfillment_items (organization_id, id, fulfillment_id, order_item_id, product_id, required_qty, allocated_qty)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (organization_id, fulfillment_id, order_item_id)
         DO UPDATE SET required_qty = fulfillment_items.required_qty + EXCLUDED.required_qty,
                       allocated_qty = fulfillment_items.allocated_qty + EXCLUDED.allocated_qty, updated_at = now()
         RETURNING id`,
        [tx.orgId, uuidv7(), ff.id, orderItemId, productId, qty],
      );
      await tx.exec(
        `UPDATE allocations SET fulfillment_id = $3, fulfillment_item_id = $4
          WHERE organization_id = $1 AND order_id = $2 AND order_item_id = $5 AND warehouse_id = $6 AND status = 'active' AND fulfillment_item_id IS NULL`,
        [tx.orgId, orderId, ff.id, fi.id, orderItemId, warehouseId],
      );
    }
    touched.push(ff.id);
    await audit(tx, {
      action: 'fulfillment.release',
      entityType: 'fulfillment',
      entityId: ff.id,
      summary: `${order.order_number} → ${ff.fulfillment_number}（${opts.mode === 'partial' ? '先行出荷' : '全量'}）`,
      metadata: { mode: opts.mode, units: [...qtyByItem.values()].reduce((s, v) => s + v.qty, 0) },
    });
  }
  await recomputeOrderStatus(tx, orderId, opts.mode === 'partial' ? '先行出荷（一部 Fulfillment 作成）' : 'Fulfillment 作成');
  return touched;
}

/**
 * 引当解除（Wave 前の引当のみ）。ready の Fulfillment からは明細を外し、空になれば Fulfillment を取消。
 * allocationIds 省略時はこの注文の Wave 前の引当すべて。
 */
export async function deallocate(tx: Tx, orderId: string, opts: { allocationIds?: string[]; reason: string; qtyByItem?: Map<string, number> }): Promise<number> {
  await tx.exec(`SELECT id FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  const allocs = await tx.many(
    `SELECT a.*, f.status AS ff_status FROM allocations a
       LEFT JOIN fulfillments f ON f.organization_id = a.organization_id AND f.id = a.fulfillment_id
      WHERE a.organization_id = $1 AND a.order_id = $2 AND a.status = 'active'
        AND ($3::uuid[] IS NULL OR a.id = ANY($3))
      ORDER BY a.balance_id FOR UPDATE OF a`,
    [tx.orgId, orderId, opts.allocationIds ?? null],
  );
  let released = 0;
  const remainingByItem = opts.qtyByItem ? new Map(opts.qtyByItem) : null;
  for (const a of allocs) {
    if (a.fulfillment_id && a.ff_status !== 'ready') {
      if (opts.allocationIds) throw conflict('ALLOCATION_IN_PROGRESS', 'Wave 投入後の引当は解除できません（Short Pick の再割当を使ってください）');
      continue;
    }
    let open = a.quantity - a.shipped_qty - a.released_qty;
    if (remainingByItem) {
      const want = remainingByItem.get(a.order_item_id) ?? 0;
      if (want <= 0) continue;
      open = Math.min(open, want);
      remainingByItem.set(a.order_item_id, want - open);
    }
    if (open <= 0) continue;
    await releaseAllocationQty(tx, a, open, opts.reason);
    released += open;
  }
  await refreshAllocationStatus(tx, orderId);
  if (released > 0) await recomputeOrderStatus(tx, orderId, `引当解除: ${opts.reason}`);
  return released;
}

/** allocation の一部/全部を解放し、在庫・明細・Fulfillment の数量を戻す（呼び出し側で行ロック済みの前提） */
export async function releaseAllocationQty(tx: Tx, a: any, qty: number, reason: string) {
  const open = a.quantity - a.shipped_qty - a.released_qty;
  if (qty <= 0 || qty > open) throw new AppError(409, 'INVALID_RELEASE', '解放数量が不正です');
  const bal = await tx.maybeOne(
    `UPDATE inventory_balances SET allocated = allocated - $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND allocated >= $3 RETURNING id`,
    [tx.orgId, a.balance_id, qty],
  );
  if (!bal) throw new AppError(500, 'INVENTORY_INCONSISTENT', '在庫の引当数が不整合です');
  const fullyReleased = a.released_qty + qty + a.shipped_qty >= a.quantity;
  await tx.exec(
    `UPDATE allocations SET released_qty = released_qty + $3,
            status = CASE WHEN $4 THEN (CASE WHEN shipped_qty > 0 THEN 'consumed' ELSE 'released' END) ELSE status END,
            released_at = CASE WHEN $4 THEN now() ELSE released_at END, released_by = $5, release_reason = $6
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, a.id, qty, fullyReleased, tx.actor.userId, reason.slice(0, 200)],
  );
  await tx.exec(`UPDATE order_items SET allocated_qty = allocated_qty - $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, a.order_item_id, qty]);
  if (a.fulfillment_item_id) {
    const fi = await tx.one(
      `UPDATE fulfillment_items SET required_qty = required_qty - $3, allocated_qty = allocated_qty - $3, updated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING fulfillment_id, required_qty`,
      [tx.orgId, a.fulfillment_item_id, qty],
    );
    const rest = await tx.one(`SELECT COALESCE(SUM(required_qty), 0)::int AS n FROM fulfillment_items WHERE organization_id = $1 AND fulfillment_id = $2`, [
      tx.orgId,
      fi.fulfillment_id,
    ]);
    if (rest.n === 0) {
      await tx.exec(
        `UPDATE fulfillments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2 AND status IN ('ready', 'waved', 'picking', 'picked')`,
        [tx.orgId, fi.fulfillment_id, `明細なし（${reason}）`.slice(0, 200)],
      );
    }
  }
}

// ---------------- run (job) ----------------
export interface RunSummary {
  runId: string;
  considered: number;
  full: number;
  partial: number;
  none: number;
  skipped: number;
  allocatedUnits: number;
}

/** 対象注文を優先度順に 1 件ずつ（別トランザクションで）引当 */
export async function runAllocation(
  deps: Pick<AppDeps, 'pool' | 'numberingPool'>,
  orgId: string,
  actor: Actor,
  opts: { trigger: 'manual' | 'job' | 'import' | 'order'; orderIds?: string[]; limit?: number },
): Promise<RunSummary> {
  const runId = uuidv7();
  const { settings, candidates } = await withTenant(deps.pool, orgId, actor, async (tx) => {
    const org = await tx.one(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
    await tx.exec(`INSERT INTO allocation_runs (organization_id, id, trigger, status, started_by) VALUES ($1, $2, $3, 'running', $4)`, [
      orgId,
      runId,
      opts.trigger,
      actor.userId,
    ]);
    const rows = await tx.many(
      `SELECT id FROM orders
        WHERE organization_id = $1 AND status IN ('ready_for_allocation', 'partially_allocated', 'partially_shipped')
          AND ($2::uuid[] IS NULL OR id = ANY($2))
        ORDER BY priority DESC, due_at ASC NULLS LAST, order_date ASC, order_number ASC
        LIMIT $3`,
      [orgId, opts.orderIds ?? null, opts.limit ?? 20000],
    );
    return { settings: parseOrgSettings(org.settings), candidates: rows.map((r) => r.id as string) };
  });
  const summary: RunSummary = { runId, considered: candidates.length, full: 0, partial: 0, none: 0, skipped: 0, allocatedUnits: 0 };
  try {
    for (const orderId of candidates) {
      const r = await withTenant(
        deps.pool,
        orgId,
        actor,
        (tx) =>
          allocateOrderInTx(tx, deps, orderId, {
            allowPartial: settings.allocation.allowPartialAllocation,
            autoRelease: settings.allocation.autoReleaseFullyAllocated,
            runId,
          }),
        { retries: 3 },
      );
      summary.allocatedUnits += r.allocatedUnits;
      if (r.outcome === 'full') summary.full++;
      else if (r.outcome === 'partial') summary.partial++;
      else if (r.outcome === 'none') summary.none++;
      else summary.skipped++;
    }
    await withTenant(deps.pool, orgId, actor, (tx) =>
      tx.exec(
        `UPDATE allocation_runs SET status = 'succeeded', finished_at = now(), orders_considered = $3, orders_allocated = $4, orders_partial = $5, orders_unallocated = $6
          WHERE organization_id = $1 AND id = $2`,
        [orgId, runId, summary.considered, summary.full, summary.partial, summary.none],
      ),
    );
  } catch (e) {
    await withTenant(deps.pool, orgId, actor, (tx) =>
      tx.exec(`UPDATE allocation_runs SET status = 'failed', finished_at = now(), error = $3 WHERE organization_id = $1 AND id = $2`, [
        orgId,
        runId,
        (e as Error).message.slice(0, 500),
      ]),
    );
    throw e;
  }
  return summary;
}
