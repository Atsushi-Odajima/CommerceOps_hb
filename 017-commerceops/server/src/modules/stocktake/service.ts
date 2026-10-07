/**
 * 棚卸（StockPilot #013 から統合。DECISIONS.md ADR-040）
 * - 1セッション = 1ロケーション。開始時の理論在庫（on_hand）を保存する。
 * - 状態: 計数中 → 差異確認 → 確定 / 中止。未計数は NULL（0 は明示入力）。未計数が残ると差異確認に進めない。
 * - 差異 = 実数 − 開始時理論。差異のある行は理由必須。差異0は在庫を動かさない。
 * - CommerceOps はピッキング・出荷が常に動くため、StockPilot のようにロケーションを止めない。
 *   代わりに確定時に現在の在庫が開始時の理論在庫と一致するか確かめ、違えば STOCKTAKE_STALE で停止する（古い理論で調整しない）。
 * - 調整後の在庫が引当済み・調査中の数量を下回る場合は確定できない（STOCKTAKE_BELOW_COMMITTED）。
 */
import type { Tx } from '../../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import { applyMovement, getOrCreateBalance } from '../inventory/service.js';

interface StocktakeRow {
  id: string;
  warehouse_id: string;
  location_id: string;
  status: 'counting' | 'review' | 'confirmed' | 'cancelled';
}

async function lock(tx: Tx, id: string): Promise<StocktakeRow> {
  const st = await tx.maybeOne<StocktakeRow>(
    `SELECT id, warehouse_id, location_id, status FROM stocktakes WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [tx.orgId, id],
  );
  if (!st) throw notFound('棚卸');
  return st;
}

export async function startStocktake(tx: Tx, input: { locationId: string; note?: string | null }) {
  const loc = await tx.maybeOne<{ id: string; warehouse_id: string; active: boolean }>(
    `SELECT id, warehouse_id, active FROM locations WHERE organization_id = $1 AND id = $2 FOR SHARE`,
    [tx.orgId, input.locationId],
  );
  if (!loc) throw notFound('ロケーション');
  const open = await tx.maybeOne(`SELECT id FROM stocktakes WHERE organization_id = $1 AND location_id = $2 AND status IN ('counting','review')`, [
    tx.orgId,
    input.locationId,
  ]);
  if (open) throw conflict('STOCKTAKE_IN_PROGRESS', 'このロケーションはすでに棚卸中です', { stocktakeId: open.id });
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO stocktakes (organization_id, id, warehouse_id, location_id, status, note, started_by) VALUES ($1,$2,$3,$4,'counting',$5,$6)`,
    [tx.orgId, id, loc.warehouse_id, input.locationId, input.note ?? null, tx.actor.userId],
  );
  // 理論在庫のある商品を行にする（在庫0の商品は「商品を追加」で計数する）
  await tx.exec(
    `INSERT INTO stocktake_lines (organization_id, id, stocktake_id, product_id, expected_qty)
     SELECT $1, uuidv7(), $2, ib.product_id, ib.on_hand FROM inventory_balances ib
      WHERE ib.organization_id = $1 AND ib.location_id = $3 AND ib.on_hand > 0`,
    [tx.orgId, id, input.locationId],
  );
  return id;
}

export async function addLine(tx: Tx, id: string, productId: string) {
  const st = await lock(tx, id);
  if (st.status !== 'counting' && st.status !== 'review') throw conflict('INVALID_STATE', '計数中の棚卸のみ商品を追加できます');
  const bal = await getOrCreateBalance(tx, st.location_id, productId);
  const dup = await tx.maybeOne(`SELECT id FROM stocktake_lines WHERE organization_id = $1 AND stocktake_id = $2 AND product_id = $3`, [tx.orgId, id, productId]);
  if (dup) return dup.id as string;
  const lineId = uuidv7();
  await tx.exec(`INSERT INTO stocktake_lines (organization_id, id, stocktake_id, product_id, expected_qty) VALUES ($1,$2,$3,$4,$5)`, [
    tx.orgId,
    lineId,
    id,
    productId,
    bal.on_hand,
  ]);
  if (st.status === 'review') await tx.exec(`UPDATE stocktakes SET status = 'counting' WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
  return lineId;
}

/** 実数・理由の入力（version で競合検出）。差異確認中に変えると計数中へ戻る */
export async function recordCount(
  tx: Tx,
  id: string,
  lineId: string,
  input: { countedQty: number | null; reason?: string | null; version: number },
) {
  const st = await lock(tx, id);
  if (st.status !== 'counting' && st.status !== 'review') throw conflict('INVALID_STATE', '計数中の棚卸のみ入力できます');
  if (input.countedQty !== null && (!Number.isInteger(input.countedQty) || input.countedQty < 0)) {
    throw badRequest('INVALID_QTY', '実数は0以上の整数で入力してください');
  }
  const n = await tx.exec(
    `UPDATE stocktake_lines SET counted_qty = $4, reason = $5, version = version + 1
      WHERE organization_id = $1 AND stocktake_id = $2 AND id = $3 AND version = $6`,
    [tx.orgId, id, lineId, input.countedQty, input.reason ?? null, input.version],
  );
  if (n === 0) {
    const exists = await tx.maybeOne(`SELECT id FROM stocktake_lines WHERE organization_id = $1 AND stocktake_id = $2 AND id = $3`, [tx.orgId, id, lineId]);
    if (!exists) throw notFound('棚卸の行');
    throw conflict('VERSION_CONFLICT', '他の端末で入力されました。最新の内容を表示し直してください');
  }
  if (st.status === 'review') await tx.exec(`UPDATE stocktakes SET status = 'counting' WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
}

export async function toReview(tx: Tx, id: string) {
  const st = await lock(tx, id);
  if (st.status !== 'counting') throw conflict('INVALID_STATE', '計数中の棚卸のみ差異確認に進めます');
  const lines = await tx.many<{ expected_qty: number; counted_qty: number | null; reason: string | null }>(
    `SELECT expected_qty, counted_qty, reason FROM stocktake_lines WHERE organization_id = $1 AND stocktake_id = $2`,
    [tx.orgId, id],
  );
  const uncounted = lines.filter((l) => l.counted_qty === null).length;
  if (uncounted > 0) throw conflict('UNCOUNTED_LINES', `未計数の行が ${uncounted} 件あります（在庫が無い場合は 0 を入力してください）`);
  const noReason = lines.filter((l) => l.counted_qty !== l.expected_qty && !l.reason?.trim()).length;
  if (noReason > 0) throw conflict('REASON_REQUIRED', `差異のある行 ${noReason} 件に理由を入力してください`);
  await tx.exec(`UPDATE stocktakes SET status = 'review' WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
}

/** 確定: 差異を在庫調整として一括反映（1トランザクション）。同じ棚卸の再確定は二重に調整しない */
export async function confirmStocktake(tx: Tx, id: string) {
  const st = await lock(tx, id);
  if (st.status === 'confirmed') return { applied: false, adjustments: 0 };
  if (st.status !== 'review') throw conflict('INVALID_STATE', '差異確認中の棚卸のみ確定できます');
  const lines = await tx.many<{ id: string; product_id: string; expected_qty: number; counted_qty: number; reason: string | null; sku: string }>(
    `SELECT sl.id, sl.product_id, sl.expected_qty, sl.counted_qty, sl.reason, p.sku FROM stocktake_lines sl
       JOIN products p ON p.organization_id = sl.organization_id AND p.id = sl.product_id
      WHERE sl.organization_id = $1 AND sl.stocktake_id = $2 ORDER BY sl.product_id`,
    [tx.orgId, id],
  );
  const balances = new Map<string, { id: string; on_hand: number; allocated: number; held: number }>();
  for (const l of lines) {
    const b = await getOrCreateBalance(tx, st.location_id, l.product_id);
    balances.set(l.product_id, b);
  }
  // ロック順を固定（残高ID順）してから現在値を読み直す
  const locked = await tx.many<{ id: string; product_id: string; on_hand: number; allocated: number; held: number }>(
    `SELECT id, product_id, on_hand, allocated, held FROM inventory_balances WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [tx.orgId, [...balances.values()].map((b) => b.id)],
  );
  const now = new Map(locked.map((b) => [b.product_id, b]));
  const stale = lines.filter((l) => now.get(l.product_id)!.on_hand !== l.expected_qty);
  if (stale.length > 0) {
    throw new AppError(409, 'STOCKTAKE_STALE', '棚卸の開始後にこのロケーションの在庫が動きました。中止して数え直してください', {
      items: stale.map((l) => ({ sku: l.sku, expected: l.expected_qty, current: now.get(l.product_id)!.on_hand })),
    });
  }
  const below = lines.filter((l) => {
    const b = now.get(l.product_id)!;
    return l.counted_qty < b.allocated + b.held;
  });
  if (below.length > 0) {
    throw new AppError(409, 'STOCKTAKE_BELOW_COMMITTED', '実数が引当済み・調査中の数量を下回る商品があります。先に引当の解除や調査中の解消を行ってください', {
      items: below.map((l) => ({ sku: l.sku, counted: l.counted_qty, allocated: now.get(l.product_id)!.allocated, held: now.get(l.product_id)!.held })),
    });
  }
  let adjustments = 0;
  for (const l of lines) {
    const delta = l.counted_qty - l.expected_qty;
    if (delta === 0) continue;
    await applyMovement(tx, {
      balanceId: now.get(l.product_id)!.id,
      type: 'adjust',
      onHandDelta: delta,
      referenceType: 'stocktake',
      referenceId: id,
      idempotencyKey: `stocktake:${id}:${l.id}`,
      reason: `棚卸: ${l.reason ?? ''}`.trim(),
    });
    adjustments++;
  }
  await tx.exec(`UPDATE stocktakes SET status = 'confirmed', confirmed_at = now(), confirmed_by = $3 WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    id,
    tx.actor.userId,
  ]);
  return { applied: true, adjustments };
}

export async function cancelStocktake(tx: Tx, id: string) {
  const st = await lock(tx, id);
  if (st.status === 'cancelled') return;
  if (st.status === 'confirmed') throw conflict('INVALID_STATE', '確定済みの棚卸は中止できません');
  await tx.exec(`UPDATE stocktakes SET status = 'cancelled', cancelled_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
}

export async function loadStocktake(tx: Tx, id: string) {
  const st = await tx.maybeOne(
    `SELECT s.*, l.code AS location_code, w.code AS warehouse_code FROM stocktakes s
       JOIN locations l ON l.organization_id = s.organization_id AND l.id = s.location_id
       JOIN warehouses w ON w.organization_id = s.organization_id AND w.id = s.warehouse_id
      WHERE s.organization_id = $1 AND s.id = $2`,
    [tx.orgId, id],
  );
  if (!st) throw notFound('棚卸');
  const lines = await tx.many(
    `SELECT sl.*, p.sku, p.name FROM stocktake_lines sl JOIN products p ON p.organization_id = sl.organization_id AND p.id = sl.product_id
      WHERE sl.organization_id = $1 AND sl.stocktake_id = $2 ORDER BY p.sku`,
    [tx.orgId, id],
  );
  return {
    id: st.id,
    status: st.status,
    warehouseId: st.warehouse_id,
    warehouseCode: st.warehouse_code,
    locationId: st.location_id,
    locationCode: st.location_code,
    note: st.note,
    createdAt: st.created_at,
    confirmedAt: st.confirmed_at,
    cancelledAt: st.cancelled_at,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.product_id,
      sku: l.sku,
      name: l.name,
      expectedQty: l.expected_qty,
      countedQty: l.counted_qty,
      variance: l.counted_qty === null ? null : l.counted_qty - l.expected_qty,
      reason: l.reason,
      version: l.version,
    })),
  };
}
