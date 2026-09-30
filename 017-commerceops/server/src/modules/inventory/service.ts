/**
 * 最小在庫台帳（docs/INVENTORY_RULES.md）
 * on_hand / held の変化はすべて inventory_movements に記録し、冪等キーで二重適用を防ぐ。
 */
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';

export type MovementType =
  | 'receipt'
  | 'adjust'
  | 'ship'
  | 'restock'
  | 'return_damaged'
  | 'return_quarantine'
  | 'discard'
  | 'hold'
  | 'unhold'
  | 'hold_loss'
  | 'transfer_out'
  | 'transfer_in'
  | 'restore';

export interface BalanceRow {
  id: string;
  warehouse_id: string;
  location_id: string;
  product_id: string;
  on_hand: number;
  allocated: number;
  held: number;
}

/** (location, product) の在庫行を取得（なければ作成）。ロケーションが倉庫に属し有効かを検証 */
export async function getOrCreateBalance(tx: Tx, locationId: string, productId: string): Promise<BalanceRow> {
  const loc = await tx.maybeOne(`SELECT id, warehouse_id, kind, active FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, locationId]);
  if (!loc) throw notFound('ロケーション');
  const prod = await tx.maybeOne(`SELECT id FROM products WHERE organization_id = $1 AND id = $2`, [tx.orgId, productId]);
  if (!prod) throw notFound('商品');
  await tx.exec(
    `INSERT INTO inventory_balances (organization_id, id, warehouse_id, location_id, product_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (organization_id, location_id, product_id) DO NOTHING`,
    [tx.orgId, uuidv7(), loc.warehouse_id, locationId, productId],
  );
  return tx.one<BalanceRow>(
    `SELECT id, warehouse_id, location_id, product_id, on_hand, allocated, held FROM inventory_balances
      WHERE organization_id = $1 AND location_id = $2 AND product_id = $3`,
    [tx.orgId, locationId, productId],
  );
}

export interface MovementInput {
  balanceId: string;
  type: MovementType;
  onHandDelta?: number;
  heldDelta?: number;
  referenceType?: string | null;
  referenceId?: string | null;
  /** 同じキーの movement は 1 回しか適用されない */
  idempotencyKey?: string | null;
  reason?: string | null;
}

/**
 * on_hand / held を変更し movement を記録。冪等キーが既存なら何もしない（applied=false）。
 * 変更後に on_hand < allocated + held となる場合は拒否（引当済み在庫を消さない）。
 */
export async function applyMovement(tx: Tx, m: MovementInput): Promise<{ applied: boolean; movementId: string | null; balance: BalanceRow }> {
  const onHandDelta = m.onHandDelta ?? 0;
  const heldDelta = m.heldDelta ?? 0;
  const bal = await tx.maybeOne<BalanceRow>(
    `SELECT id, warehouse_id, location_id, product_id, on_hand, allocated, held FROM inventory_balances WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, m.balanceId],
  );
  if (!bal) throw notFound('在庫');
  const movementId = uuidv7();
  const ins = await tx.maybeOne(
    `INSERT INTO inventory_movements (organization_id, id, balance_id, warehouse_id, location_id, product_id, movement_type,
                                      on_hand_delta, held_delta, reference_type, reference_id, idempotency_key, reason, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      tx.orgId,
      movementId,
      bal.id,
      bal.warehouse_id,
      bal.location_id,
      bal.product_id,
      m.type,
      onHandDelta,
      heldDelta,
      m.referenceType ?? null,
      m.referenceId ?? null,
      m.idempotencyKey ?? null,
      m.reason?.slice(0, 300) ?? null,
      tx.actor.userId,
    ],
  );
  if (!ins) return { applied: false, movementId: null, balance: bal };
  if (onHandDelta === 0 && heldDelta === 0) return { applied: true, movementId, balance: bal };
  const upd = await tx.maybeOne<BalanceRow>(
    `UPDATE inventory_balances
        SET on_hand = on_hand + $3, held = held + $4, updated_at = now()
      WHERE organization_id = $1 AND id = $2
        AND on_hand + $3 >= 0 AND held + $4 >= 0 AND allocated + held + $4 <= on_hand + $3
      RETURNING id, warehouse_id, location_id, product_id, on_hand, allocated, held`,
    [tx.orgId, bal.id, onHandDelta, heldDelta],
  );
  if (!upd) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', '在庫数量が不足しています（引当済み・調査中の数量を下回る変更はできません）', {
      onHand: bal.on_hand,
      allocated: bal.allocated,
      held: bal.held,
      onHandDelta,
      heldDelta,
    });
  }
  return { applied: true, movementId, balance: upd };
}

export async function receiveStock(
  tx: Tx,
  input: { locationId: string; productId: string; qty: number; reason?: string | null; requestId?: string | null; type?: 'receipt' | 'restore' },
) {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new AppError(400, 'INVALID_QTY', '数量は1以上の整数にしてください');
  const bal = await getOrCreateBalance(tx, input.locationId, input.productId);
  return applyMovement(tx, {
    balanceId: bal.id,
    type: input.type ?? 'receipt',
    onHandDelta: input.qty,
    idempotencyKey: input.requestId ? `receipt:${input.requestId}` : null,
    reason: input.reason ?? '入荷',
  });
}

/** 棚卸調整: mode=set は on_hand を指定値に、mode=delta は増減 */
export async function adjustStock(
  tx: Tx,
  input: { locationId: string; productId: string; mode: 'set' | 'delta'; qty: number; reason: string; requestId?: string | null },
) {
  const bal = await getOrCreateBalance(tx, input.locationId, input.productId);
  const locked = await tx.one<BalanceRow>(
    `SELECT id, warehouse_id, location_id, product_id, on_hand, allocated, held FROM inventory_balances WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [tx.orgId, bal.id],
  );
  const delta = input.mode === 'set' ? input.qty - locked.on_hand : input.qty;
  if (input.mode === 'set' && input.qty < 0) throw new AppError(400, 'INVALID_QTY', '数量は0以上にしてください');
  if (delta === 0) return { applied: false, movementId: null, balance: locked };
  return applyMovement(tx, {
    balanceId: bal.id,
    type: 'adjust',
    onHandDelta: delta,
    idempotencyKey: input.requestId ? `adjust:${input.requestId}` : null,
    reason: input.reason,
  });
}

/** ロケーション間移動（同一倉庫内）。移動元は引当可能数量まで */
export async function transferStock(
  tx: Tx,
  input: { fromLocationId: string; toLocationId: string; productId: string; qty: number; reason?: string | null; requestId?: string | null },
) {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new AppError(400, 'INVALID_QTY', '数量は1以上の整数にしてください');
  if (input.fromLocationId === input.toLocationId) throw conflict('SAME_LOCATION', '移動元と移動先が同じです');
  const from = await getOrCreateBalance(tx, input.fromLocationId, input.productId);
  const to = await getOrCreateBalance(tx, input.toLocationId, input.productId);
  if (from.warehouse_id !== to.warehouse_id) throw conflict('CROSS_WAREHOUSE', '倉庫間の移動はできません（出荷・入荷として処理してください）');
  // 販売可能（pick）と返品保留・破損の間の移動は「売れる在庫が増える/減る」判断なので理由を必須にする（返品保留の再確認後に戻す等）
  const kinds = await tx.many<{ id: string; kind: string }>(`SELECT id, kind FROM locations WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [tx.orgId, [input.fromLocationId, input.toLocationId]]);
  const fromKind = kinds.find((k) => k.id === input.fromLocationId)?.kind;
  const toKind = kinds.find((k) => k.id === input.toLocationId)?.kind;
  if (fromKind !== toKind && (fromKind === 'pick' || toKind === 'pick') && !input.reason?.trim()) {
    throw new AppError(400, 'REASON_REQUIRED', toKind === 'pick' ? '販売可能な棚へ戻す理由を入力してください（検品・確認の結果など）' : '販売可能在庫から外す理由を入力してください');
  }
  // ロック順を固定してデッドロックを避ける
  const ids = [from.id, to.id].sort();
  await tx.many(`SELECT id FROM inventory_balances WHERE organization_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE`, [tx.orgId, ids]);
  const fromRow = await tx.one<BalanceRow>(`SELECT * FROM inventory_balances WHERE organization_id = $1 AND id = $2`, [tx.orgId, from.id]);
  if (fromRow.on_hand - fromRow.allocated - fromRow.held < input.qty) {
    throw conflict('INSUFFICIENT_STOCK', `移動元の引当可能数量（${fromRow.on_hand - fromRow.allocated - fromRow.held}）を超えています`);
  }
  const key = input.requestId ?? uuidv7();
  const out = await applyMovement(tx, {
    balanceId: from.id,
    type: 'transfer_out',
    onHandDelta: -input.qty,
    idempotencyKey: `transfer_out:${key}`,
    reason: input.reason ?? 'ロケーション移動',
  });
  if (!out.applied) return { applied: false };
  await applyMovement(tx, {
    balanceId: to.id,
    type: 'transfer_in',
    onHandDelta: input.qty,
    idempotencyKey: `transfer_in:${key}`,
    reason: input.reason ?? 'ロケーション移動',
  });
  return { applied: true, fromKind, toKind };
}

/** 調査中（held）の解消: loss=紛失確定（on_hand も減らす）/ found=発見（held を戻す） */
export async function resolveHeld(
  tx: Tx,
  input: { balanceId: string; qty: number; resolution: 'loss' | 'found'; reason?: string | null; requestId?: string | null },
) {
  const bal = await tx.maybeOne<BalanceRow>(`SELECT * FROM inventory_balances WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, input.balanceId]);
  if (!bal) throw notFound('在庫');
  if (!Number.isInteger(input.qty) || input.qty <= 0 || input.qty > bal.held) {
    throw conflict('INVALID_QTY', `調査中の数量（${bal.held}）以内で指定してください`);
  }
  return applyMovement(tx, {
    balanceId: bal.id,
    type: input.resolution === 'loss' ? 'hold_loss' : 'unhold',
    onHandDelta: input.resolution === 'loss' ? -input.qty : 0,
    heldDelta: -input.qty,
    idempotencyKey: input.requestId ? `held_${input.resolution}:${input.requestId}` : null,
    reason: input.reason ?? (input.resolution === 'loss' ? '紛失確定' : '発見'),
  });
}

/** 倉庫の特殊ロケーション（DEFAULT / QUARANTINE / DAMAGED）を取得 */
export async function specialLocation(tx: Tx, warehouseId: string, kind: 'pick' | 'quarantine' | 'damaged'): Promise<string> {
  const code = kind === 'pick' ? 'DEFAULT' : kind === 'quarantine' ? 'QUARANTINE' : 'DAMAGED';
  const byCode = await tx.maybeOne(`SELECT id FROM locations WHERE organization_id = $1 AND warehouse_id = $2 AND code = $3 AND kind = $4`, [
    tx.orgId,
    warehouseId,
    code,
    kind,
  ]);
  if (byCode) return byCode.id;
  const any = await tx.maybeOne(
    `SELECT id FROM locations WHERE organization_id = $1 AND warehouse_id = $2 AND kind = $3 AND active ORDER BY pick_sequence LIMIT 1`,
    [tx.orgId, warehouseId, kind],
  );
  if (!any) throw conflict('LOCATION_MISSING', `倉庫に ${code} ロケーションがありません`);
  return any.id;
}
