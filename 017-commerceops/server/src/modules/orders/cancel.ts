/**
 * キャンセル（docs/FULFILLMENT_RULES.md §3）
 * - 未出荷 Allocation は解放
 * - Pick/Pack 中は confirm 必須。ピック済み商品は「キャンセル棚戻し」例外で棚に戻す
 * - 出荷済み（一部含む）の注文全体は取消不可（未出荷分は明細取消、出荷済みは返品）
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { autoResolveException, createException } from '../exceptions/service.js';
import { deallocate, refreshAllocationStatus } from '../allocation/engine.js';
import { recomputeOrderStatus } from './status.js';

const IN_PROGRESS = ['waved', 'picking', 'picked', 'packing', 'packed'];

/** Fulfillment を作業途中で止める（Pick 行・梱包セッション・下書き出荷・Wave 所属） */
export async function stopFulfillmentWork(tx: Tx, fulfillmentId: string, reason: string) {
  await tx.exec(
    `UPDATE pick_task_lines SET status = 'cancelled', updated_at = now() WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'open'`,
    [tx.orgId, fulfillmentId],
  );
  await tx.exec(
    `UPDATE pack_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3 WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'active'`,
    [tx.orgId, fulfillmentId, reason],
  );
  await tx.exec(
    `UPDATE shipments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
      WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'draft'`,
    [tx.orgId, fulfillmentId, reason],
  );
  await tx.exec(
    `UPDATE wave_fulfillments SET removed_at = now(), removed_reason = $3 WHERE organization_id = $1 AND fulfillment_id = $2 AND removed_at IS NULL`,
    [tx.orgId, fulfillmentId, reason],
  );
  // 残作業がなくなった Pick タスクを閉じる
  await tx.exec(
    `UPDATE pick_tasks t SET status = CASE WHEN EXISTS (SELECT 1 FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id AND l.picked_qty > 0) THEN 'completed' ELSE 'cancelled' END,
            completed_at = COALESCE(completed_at, now()), assignee_user_id = NULL, claim_expires_at = NULL, updated_at = now()
      WHERE t.organization_id = $1 AND t.status IN ('open', 'in_progress')
        AND t.id IN (SELECT pick_task_id FROM pick_task_lines WHERE organization_id = $1 AND fulfillment_id = $2)
        AND NOT EXISTS (SELECT 1 FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id AND l.status = 'open')`,
    [tx.orgId, fulfillmentId],
  );
}

export async function cancelOrder(tx: Tx, deps: Pick<AppDeps, 'numberingPool'>, orderId: string, opts: { reason: string; confirm?: boolean }) {
  const o = await tx.maybeOne(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  if (!o) throw notFound('注文');
  if (o.cancelled_at) return { alreadyCancelled: true, status: 'cancelled' };
  const shipped = await tx.one(`SELECT COALESCE(SUM(shipped_qty), 0)::int AS n FROM order_items WHERE organization_id = $1 AND order_id = $2`, [tx.orgId, orderId]);
  if (shipped.n > 0) {
    throw conflict('PARTIALLY_SHIPPED', '出荷済みの荷物があるため注文全体は取消できません。未出荷分は明細取消、出荷済み分は返品で処理してください');
  }
  const ffs = await tx.many(
    `SELECT * FROM fulfillments WHERE organization_id = $1 AND order_id = $2 AND status NOT IN ('shipped', 'cancelled') FOR UPDATE`,
    [tx.orgId, orderId],
  );
  const inProgress = ffs.filter((f) => IN_PROGRESS.includes(f.status));
  if (inProgress.length && !opts.confirm) {
    throw new AppError(409, 'CONFIRM_REQUIRED', 'ピッキング・梱包中の作業があります。取消するとピック済み商品の棚戻しが必要になります。確認のうえ再実行してください', {
      fulfillments: inProgress.map((f) => ({ number: f.fulfillment_number, status: f.status })),
    });
  }
  const putback: { sku: string; qty: number; location: string; fulfillment: string }[] = [];
  for (const f of ffs) {
    if (IN_PROGRESS.includes(f.status)) {
      const picked = await tx.many(
        `SELECT l.picked_qty, p.sku, loc.code AS location FROM pick_task_lines l
           JOIN products p ON p.organization_id = l.organization_id AND p.id = l.product_id
           JOIN locations loc ON loc.organization_id = l.organization_id AND loc.id = l.location_id
          WHERE l.organization_id = $1 AND l.fulfillment_id = $2 AND l.picked_qty > 0`,
        [tx.orgId, f.id],
      );
      for (const p of picked) putback.push({ sku: p.sku, qty: p.picked_qty, location: p.location, fulfillment: f.fulfillment_number });
      await stopFulfillmentWork(tx, f.id, `注文キャンセル: ${opts.reason}`.slice(0, 200));
    }
  }
  await tx.exec(
    `UPDATE fulfillments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
      WHERE organization_id = $1 AND order_id = $2 AND status NOT IN ('shipped', 'cancelled')`,
    [tx.orgId, orderId, `注文キャンセル: ${opts.reason}`.slice(0, 200)],
  );
  // 未出荷の引当をすべて解放（Fulfillment は取消済みのため明細数量は履歴として残す）
  const allocs = await tx.many(
    `SELECT * FROM allocations WHERE organization_id = $1 AND order_id = $2 AND status = 'active' ORDER BY balance_id FOR UPDATE`,
    [tx.orgId, orderId],
  );
  let releasedUnits = 0;
  for (const a of allocs) {
    const open = a.quantity - a.shipped_qty - a.released_qty;
    if (open <= 0) continue;
    const ok = await tx.maybeOne(
      `UPDATE inventory_balances SET allocated = allocated - $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND allocated >= $3 RETURNING id`,
      [tx.orgId, a.balance_id, open],
    );
    if (!ok) throw new AppError(500, 'INVENTORY_INCONSISTENT', '在庫の引当数が不整合です');
    await tx.exec(
      `UPDATE allocations SET released_qty = released_qty + $3, status = 'released', released_at = now(), released_by = $4, release_reason = $5
        WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, a.id, open, tx.actor.userId, `注文キャンセル`],
    );
    releasedUnits += open;
  }
  await tx.exec(`UPDATE order_items SET allocated_qty = 0, updated_at = now() WHERE organization_id = $1 AND order_id = $2`, [tx.orgId, orderId]);
  await tx.exec(
    `UPDATE orders SET cancelled_at = now(), cancelled_by = $3, cancel_reason = $4, updated_at = now(), version = version + 1 WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, orderId, tx.actor.userId, opts.reason.slice(0, 300)],
  );
  if (putback.length) {
    await createException(tx, deps, {
      type: 'cancel_putback',
      title: `キャンセル棚戻し: ${o.order_number}（${putback.reduce((s, p) => s + p.qty, 0)} 個）`,
      severity: 'medium',
      dedupeKey: `cancel_putback:${orderId}`,
      orderId,
      detail: { items: putback },
    });
  }
  await autoResolveException(tx, `shortage:${orderId}`, '自動解消: 注文キャンセル');
  await refreshAllocationStatus(tx, orderId);
  const st = await recomputeOrderStatus(tx, orderId, `キャンセル: ${opts.reason}`);
  await audit(tx, {
    action: 'order.cancel',
    entityType: 'order',
    entityId: orderId,
    summary: `${o.order_number} をキャンセル（引当解放 ${releasedUnits} 個${putback.length ? `・棚戻し ${putback.length} 件` : ''}）`,
    metadata: { releasedUnits, putback: putback.length, inProgress: inProgress.length },
  });
  return { alreadyCancelled: false, status: st.to, releasedUnits, putback };
}

/** 明細単位の取消（人間の明示操作のみ）。作業中（Wave 投入後）の数量は取消できない */
export async function cancelOrderLines(tx: Tx, orderId: string, lines: { itemId: string; qty: number }[], reason: string) {
  const o = await tx.maybeOne(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  if (!o) throw notFound('注文');
  if (o.cancelled_at) throw conflict('ORDER_CANCELLED', 'キャンセル済みの注文です');
  const qtyByItem = new Map<string, number>();
  for (const l of lines) {
    const it = await tx.maybeOne(`SELECT * FROM order_items WHERE organization_id = $1 AND id = $2 AND order_id = $3 FOR UPDATE`, [tx.orgId, l.itemId, orderId]);
    if (!it) throw notFound('明細');
    const cancellable = it.quantity - it.cancelled_qty - it.shipped_qty;
    if (!Number.isInteger(l.qty) || l.qty <= 0 || l.qty > cancellable) throw conflict('INVALID_QTY', `${it.sku}: 取消できる数量は ${cancellable} までです`);
    const inProgress = await tx.one(
      `SELECT COALESCE(SUM(fi.required_qty - fi.shipped_qty), 0)::int AS n FROM fulfillment_items fi
         JOIN fulfillments f ON f.organization_id = fi.organization_id AND f.id = fi.fulfillment_id
        WHERE fi.organization_id = $1 AND fi.order_item_id = $2 AND f.status IN ('waved', 'picking', 'picked', 'packing', 'packed')`,
      [tx.orgId, it.id],
    );
    const unallocated = cancellable - it.allocated_qty;
    const releasable = it.allocated_qty - inProgress.n;
    if (l.qty > unallocated + releasable) {
      throw conflict('IN_PROGRESS', `${it.sku}: ピッキング・梱包中の数量は取消できません（先に作業を戻すか、出荷後に返品で処理してください）`);
    }
    const toRelease = Math.max(0, l.qty - unallocated);
    if (toRelease > 0) qtyByItem.set(it.id, toRelease);
  }
  if (qtyByItem.size) await deallocate(tx, orderId, { reason: `明細取消: ${reason}`, qtyByItem });
  for (const l of lines) {
    await tx.exec(`UPDATE order_items SET cancelled_qty = cancelled_qty + $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, l.itemId, l.qty]);
  }
  await tx.exec(
    `UPDATE orders SET total_qty = (SELECT COALESCE(SUM(quantity - cancelled_qty), 0) FROM order_items WHERE organization_id = $1 AND order_id = $2), updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, orderId],
  );
  await refreshAllocationStatus(tx, orderId);
  // 残りがすべて引当済みなら欠品例外は解消
  const remaining = await tx.one(
    `SELECT COALESCE(SUM(quantity - cancelled_qty - shipped_qty - allocated_qty), 0)::int AS n FROM order_items WHERE organization_id = $1 AND order_id = $2`,
    [tx.orgId, orderId],
  );
  if (remaining.n === 0) await autoResolveException(tx, `shortage:${orderId}`, '自動解消: 明細取消で不足なし');
  const st = await recomputeOrderStatus(tx, orderId, `明細取消: ${reason}`);
  await audit(tx, {
    action: 'order.cancel_lines',
    entityType: 'order',
    entityId: orderId,
    summary: `${o.order_number} の明細を取消（${lines.reduce((s, l) => s + l.qty, 0)} 個）`,
    metadata: { lines: lines.length, reasonLength: reason.length },
  });
  return { status: st.to };
}
