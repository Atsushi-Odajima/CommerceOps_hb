/**
 * 返品・交換（docs/RETURN_RULES.md）
 * - Return は Order / Shipment を上書きしない別エンティティ
 * - 受付・到着だけでは在庫を増やさない（R14）。検品の Disposition 確定で初めて在庫を動かし、Restock だけ販売可能在庫へ（R15, R16）
 * - 検品は client_request_id で冪等、return_item 行ロック + inspected_qty <= received_qty、movement の冪等キーで二重 Restock なし（R17）
 * - 交換は Replacement Order を作り、通常の Allocation → Fulfillment → Wave → Pick → Pack → Ship を通す（R18）
 * - ロック順序: Return →（Return 明細）→ 在庫行
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import { createException } from '../exceptions/service.js';
import { applyMovement, getOrCreateBalance, specialLocation, type MovementType } from '../inventory/service.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { createOrders } from '../orders/service.js';
import { allocateOrderInTx } from '../allocation/engine.js';

export const RETURN_REASONS = ['changed_mind', 'defective', 'wrong_item', 'damaged_in_transit', 'size_issue', 'other'] as const;
export const DISPOSITIONS = ['restock', 'damaged', 'quarantine', 'discard'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

const OPEN_STATUSES = ['requested', 'authorized', 'in_transit', 'received', 'inspecting'];

async function lockReturn(tx: Tx, returnId: string) {
  const r = await tx.maybeOne(`SELECT * FROM returns WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, returnId]);
  if (!r) throw notFound('返品');
  return r;
}

/** 注文明細ごとの返品可能数（出荷済 − 既存の返品申請。却下・取消を除く） */
export async function returnableItems(tx: Tx, orderId: string) {
  return tx.many(
    `SELECT oi.id, oi.line_no, oi.sku, oi.product_name, oi.variant, oi.product_id, oi.quantity, oi.shipped_qty,
            -- 返品済みとして数える数量: 進行中の返品は申請数、完了した返品は実際に届いた数（届かなかった分は、後から届いた場合に新しい返品で受け付けられる）
            COALESCE((SELECT SUM(CASE WHEN r.status = 'completed' THEN ri.received_qty ELSE ri.requested_qty END)
                        FROM return_items ri JOIN returns r ON r.organization_id = ri.organization_id AND r.id = ri.return_id
                       WHERE ri.organization_id = oi.organization_id AND ri.order_item_id = oi.id AND r.status NOT IN ('rejected', 'cancelled')), 0)::int AS returned_qty
       FROM order_items oi WHERE oi.organization_id = $1 AND oi.order_id = $2 ORDER BY oi.line_no`,
    [tx.orgId, orderId],
  );
}

export interface NewReturnInput {
  orderId: string;
  shipmentId?: string | null;
  reasonCode: (typeof RETURN_REASONS)[number];
  customerNote?: string | null;
  internalNote?: string | null;
  items: { orderItemId: string; qty: number; reasonCode?: (typeof RETURN_REASONS)[number] }[];
}

export async function createReturn(tx: Tx, deps: Pick<AppDeps, 'numberingPool'>, input: NewReturnInput, warehouseIds: string[] | null) {
  // 注文行ロックで同じ注文への同時返品申請を直列化（返品可能数の検証を正しくする）
  const o = await tx.maybeOne(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, input.orderId]);
  if (!o) throw notFound('注文');
  if (o.cancelled_at) throw conflict('ORDER_CANCELLED', 'キャンセルされた注文は返品できません');
  if (input.reasonCode === 'other' && !input.customerNote?.trim() && !input.internalNote?.trim()) {
    throw badRequest('NOTE_REQUIRED', '理由が「その他」の場合はメモを入力してください');
  }
  const lines = await returnableItems(tx, o.id);
  const seen = new Set<string>();
  for (const it of input.items) {
    const l = lines.find((x) => x.id === it.orderItemId);
    if (!l) throw notFound('注文明細');
    if (seen.has(it.orderItemId)) throw badRequest('DUPLICATE_ITEM', `${l.sku} が重複しています`);
    seen.add(it.orderItemId);
    const returnable = l.shipped_qty - l.returned_qty;
    if (l.shipped_qty <= 0) throw conflict('NOT_SHIPPED', `${l.sku} は出荷されていないため返品できません（未出荷分はキャンセルで処理してください）`);
    if (it.qty > returnable) throw conflict('EXCEEDS_RETURNABLE', `${l.sku}: 返品できる数量は ${returnable} までです（出荷 ${l.shipped_qty} / 返品申請済み ${l.returned_qty}）`);
  }
  let warehouseId: string | null = null;
  if (input.shipmentId) {
    const sh = await tx.maybeOne(`SELECT id, warehouse_id, status FROM shipments WHERE organization_id = $1 AND id = $2 AND order_id = $3`, [tx.orgId, input.shipmentId, o.id]);
    if (!sh) throw notFound('この注文の荷物');
    if (sh.status !== 'shipped') throw conflict('NOT_SHIPPED', '出荷済みの荷物を指定してください');
    warehouseId = sh.warehouse_id;
  } else {
    const sh = await tx.maybeOne(
      `SELECT warehouse_id FROM shipments WHERE organization_id = $1 AND order_id = $2 AND status = 'shipped' ORDER BY shipped_at DESC LIMIT 1`,
      [tx.orgId, o.id],
    );
    warehouseId = sh?.warehouse_id ?? null;
  }
  if (warehouseId && warehouseIds && !warehouseIds.includes(warehouseId)) {
    // 返品先倉庫の既定は出荷元。担当外なら倉庫未定で作成（到着時に倉庫を決める）
    warehouseId = null;
  }
  const [number] = await nextNumbers(deps.numberingPool, tx.orgId, 'return', 1);
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO returns (organization_id, id, return_number, order_id, shipment_id, warehouse_id, status, reason_code, customer_note, internal_note, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9, $10)`,
    [tx.orgId, id, number, o.id, input.shipmentId ?? null, warehouseId, input.reasonCode, input.customerNote?.trim() || null, input.internalNote?.trim() || null, tx.actor.userId],
  );
  for (const it of input.items) {
    const l = lines.find((x) => x.id === it.orderItemId)!;
    await tx.exec(
      `INSERT INTO return_items (organization_id, id, return_id, order_item_id, product_id, requested_qty, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tx.orgId, uuidv7(), id, l.id, l.product_id, it.qty, it.reasonCode ?? input.reasonCode],
    );
  }
  await recomputeOrderStatus(tx, o.id, `返品受付 ${number}`);
  await audit(tx, {
    action: 'return.create',
    entityType: 'return',
    entityId: id,
    summary: `${number}（${o.order_number}）返品を受付（${input.items.reduce((s, i) => s + i.qty, 0)} 個）`,
    metadata: { reasonCode: input.reasonCode, items: input.items.length },
  });
  return { id, returnNumber: number };
}

type Transition = 'authorize' | 'reject' | 'cancel' | 'in_transit';

const ALLOWED_FROM: Record<Transition, string[]> = {
  authorize: ['requested'],
  reject: ['requested', 'authorized'],
  cancel: ['requested', 'authorized', 'in_transit'],
  in_transit: ['authorized'],
};

export async function transitionReturn(tx: Tx, returnId: string, action: Transition, input: { reason?: string; carrier?: string; trackingNumber?: string }) {
  const r = await lockReturn(tx, returnId);
  if (!ALLOWED_FROM[action].includes(r.status)) {
    if ((action === 'authorize' && r.status === 'authorized') || (action === 'in_transit' && r.status === 'in_transit')) return { status: r.status, unchanged: true };
    throw conflict('INVALID_TRANSITION', `この状態（${r.status}）からは実行できません`);
  }
  const reason = input.reason?.trim();
  if ((action === 'reject' || action === 'cancel') && !reason) throw badRequest('REASON_REQUIRED', '理由を入力してください');
  let next = r.status;
  if (action === 'authorize') {
    next = 'authorized';
    await tx.exec(`UPDATE returns SET status = 'authorized', authorized_by = $3, authorized_at = now(), updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, r.id, tx.actor.userId]);
  } else if (action === 'reject') {
    next = 'rejected';
    await tx.exec(`UPDATE returns SET status = 'rejected', rejected_by = $3, rejected_at = now(), reject_reason = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
      tx.orgId,
      r.id,
      tx.actor.userId,
      reason!.slice(0, 300),
    ]);
  } else if (action === 'cancel') {
    next = 'cancelled';
    await tx.exec(`UPDATE returns SET status = 'cancelled', cancelled_by = $3, cancelled_at = now(), cancel_reason = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
      tx.orgId,
      r.id,
      tx.actor.userId,
      reason!.slice(0, 300),
    ]);
  } else {
    next = 'in_transit';
    await tx.exec(
      `UPDATE returns SET status = 'in_transit', in_transit_at = now(), return_carrier = $3, return_tracking_number = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, r.id, input.carrier?.trim().slice(0, 40) || null, input.trackingNumber?.normalize('NFKC').replace(/[\s-]/g, '').slice(0, 40) || null],
    );
  }
  await recomputeOrderStatus(tx, r.order_id, `返品 ${r.return_number}: ${action}`);
  await audit(tx, { action: `return.${action}`, entityType: 'return', entityId: r.id, summary: `${r.return_number} を${{ authorize: '承認', reject: '却下', cancel: '取消', in_transit: '返送中に' }[action]}`, metadata: { reasonLength: reason?.length ?? 0 } });
  return { status: next, unchanged: false };
}

/** 到着登録（数量確認）。在庫は動かさない（R14）。申請と差があれば例外 return_discrepancy */
export async function receiveReturn(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  returnId: string,
  input: { warehouseId: string; items: { returnItemId: string; receivedQty: number }[]; unexpected?: string | null; note?: string | null },
) {
  const r = await lockReturn(tx, returnId);
  if (['received', 'inspecting', 'completed'].includes(r.status)) return { alreadyReceived: true, status: r.status };
  if (!['requested', 'authorized', 'in_transit'].includes(r.status)) throw conflict('INVALID_TRANSITION', `この状態（${r.status}）の返品は到着登録できません`);
  const wh = await tx.maybeOne(`SELECT id FROM warehouses WHERE organization_id = $1 AND id = $2 AND active`, [tx.orgId, input.warehouseId]);
  if (!wh) throw notFound('倉庫');
  const items = await tx.many(
    `SELECT ri.*, oi.sku FROM return_items ri JOIN order_items oi ON oi.organization_id = ri.organization_id AND oi.id = ri.order_item_id
      WHERE ri.organization_id = $1 AND ri.return_id = $2 FOR UPDATE OF ri`,
    [tx.orgId, r.id],
  );
  const byId = new Map(input.items.map((i) => [i.returnItemId, i.receivedQty]));
  for (const k of byId.keys()) if (!items.some((i) => i.id === k)) throw notFound('返品明細');
  const diffs: { sku: string; requested: number; received: number }[] = [];
  for (const it of items) {
    const q = byId.get(it.id) ?? 0;
    if (!Number.isInteger(q) || q < 0 || q > it.requested_qty) throw badRequest('INVALID_QTY', `${it.sku}: 到着数量は 0〜${it.requested_qty} で入力してください（申請より多い場合は差異メモに記入）`);
    await tx.exec(`UPDATE return_items SET received_qty = $3 WHERE organization_id = $1 AND id = $2`, [tx.orgId, it.id, q]);
    if (q !== it.requested_qty) diffs.push({ sku: it.sku, requested: it.requested_qty, received: q });
  }
  const total = [...byId.values()].reduce((s, q) => s + q, 0);
  const unexpected = input.unexpected?.trim() || null;
  if (total === 0 && !unexpected) throw badRequest('NOTHING_RECEIVED', '到着数量が 0 です。届いていない場合は到着登録しないでください');
  const note = input.note?.trim() || null;
  await tx.exec(
    `UPDATE returns SET status = 'received', warehouse_id = $3, received_by = $4, received_at = now(),
            internal_note = CASE WHEN $5::text IS NULL THEN internal_note ELSE concat_ws(E'\\n', internal_note, $5::text) END, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, r.id, input.warehouseId, tx.actor.userId, note ? `到着メモ: ${note.slice(0, 300)}` : null],
  );
  if (diffs.length || unexpected) {
    await createException(tx, deps, {
      type: 'return_discrepancy',
      title: `返品差異: ${r.return_number}${diffs.length ? `（数量差 ${diffs.length} 件）` : ''}${unexpected ? '（想定外の品物あり）' : ''}`,
      severity: 'medium',
      dedupeKey: `return_discrepancy:${r.id}`,
      orderId: r.order_id,
      returnId: r.id,
      warehouseId: input.warehouseId,
      detail: { items: diffs, unexpected: unexpected?.slice(0, 300) ?? undefined },
    });
  }
  await recomputeOrderStatus(tx, r.order_id, `返品到着 ${r.return_number}`);
  await audit(tx, {
    action: 'return.receive',
    entityType: 'return',
    entityId: r.id,
    summary: `${r.return_number} 到着（${total} 個${diffs.length || unexpected ? '・差異あり' : ''}）`,
    metadata: { received: total, discrepancies: diffs.length, unexpected: !!unexpected },
  });
  return { alreadyReceived: false, status: 'received', discrepancies: diffs, unexpected: !!unexpected };
}

const MOVEMENT_FOR: Record<Disposition, MovementType> = {
  restock: 'restock',
  damaged: 'return_damaged',
  quarantine: 'return_quarantine',
  discard: 'discard',
};

export interface InspectionLine {
  returnItemId: string;
  disposition: Disposition;
  qty: number;
  locationId?: string | null;
  reason?: string | null;
  note?: string | null;
}

/** 検品・Disposition 確定（冪等）。Restock だけが販売可能在庫を増やす */
export async function inspectReturn(
  tx: Tx,
  returnId: string,
  input: { clientRequestId: string; lines: InspectionLine[]; attachmentIds?: string[] },
) {
  const r = await lockReturn(tx, returnId);
  // R17: 同じ client_request_id の再送は前回の結果を返す（行ロック後に確認するため同時再送でも 1 回）
  const prev = await tx.many(`SELECT id, disposition, qty FROM return_inspections WHERE organization_id = $1 AND client_request_id = $2 ORDER BY line_index`, [
    tx.orgId,
    input.clientRequestId,
  ]);
  if (prev.length) {
    return { duplicate: true, status: r.status, inspections: prev.map((p) => ({ id: p.id, disposition: p.disposition, qty: p.qty })) };
  }
  if (!['received', 'inspecting'].includes(r.status)) throw conflict('NOT_RECEIVED', r.status === 'completed' ? 'この返品は検品済みです' : '到着登録された返品のみ検品できます');
  if (!r.warehouse_id) throw conflict('WAREHOUSE_MISSING', '返品の倉庫が未設定です');
  if (!input.lines.length) throw badRequest('NO_LINES', '検品結果を入力してください');
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (attachmentIds.length) {
    const n = await tx.one(`SELECT count(*)::int AS n FROM attachments WHERE organization_id = $1 AND id = ANY($2) AND entity_type = 'return' AND entity_id = $3`, [
      tx.orgId,
      attachmentIds,
      r.id,
    ]);
    if (n.n !== attachmentIds.length) throw badRequest('INVALID_ATTACHMENT', '写真が見つかりません（この返品にアップロードした写真を指定してください）');
  }
  const results: { id: string; disposition: Disposition; qty: number; locationCode: string | null }[] = [];
  const summary: Record<string, number> = {};
  for (const [idx, line] of input.lines.entries()) {
    const it = await tx.maybeOne(
      `SELECT ri.*, oi.sku FROM return_items ri JOIN order_items oi ON oi.organization_id = ri.organization_id AND oi.id = ri.order_item_id
        WHERE ri.organization_id = $1 AND ri.id = $2 AND ri.return_id = $3 FOR UPDATE OF ri`,
      [tx.orgId, line.returnItemId, r.id],
    );
    if (!it) throw notFound('返品明細');
    if (!it.product_id) throw conflict('PRODUCT_MISSING', `${it.sku} は商品マスターに対応付けられていないため在庫処理できません`);
    if (it.inspected_qty + line.qty > it.received_qty) {
      throw conflict('EXCEEDS_RECEIVED', `${it.sku}: 検品数量が到着数量を超えます（到着 ${it.received_qty} / 検品済み ${it.inspected_qty}）`);
    }
    if (line.disposition !== 'restock' && !line.reason?.trim()) throw badRequest('REASON_REQUIRED', `${it.sku}: 再販不可（${line.disposition}）の理由を入力してください`);
    // 戻し先ロケーション
    let locationId: string;
    if (line.disposition === 'restock') {
      if (line.locationId) {
        const loc = await tx.maybeOne(`SELECT id FROM locations WHERE organization_id = $1 AND id = $2 AND warehouse_id = $3 AND kind = 'pick' AND active`, [
          tx.orgId,
          line.locationId,
          r.warehouse_id,
        ]);
        if (!loc) throw badRequest('INVALID_LOCATION', '再販の戻し先は返品倉庫の販売可能ロケーションを指定してください');
        locationId = loc.id;
      } else {
        const cur = await tx.maybeOne(
          `SELECT ib.location_id FROM inventory_balances ib JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
            WHERE ib.organization_id = $1 AND ib.warehouse_id = $2 AND ib.product_id = $3 AND l.kind = 'pick' AND l.active
            ORDER BY ib.on_hand DESC, l.pick_sequence LIMIT 1`,
          [tx.orgId, r.warehouse_id, it.product_id],
        );
        locationId = cur?.location_id ?? (await specialLocation(tx, r.warehouse_id, 'pick'));
      }
    } else {
      locationId = await specialLocation(tx, r.warehouse_id, line.disposition === 'quarantine' ? 'quarantine' : 'damaged');
    }
    const inspectionId = uuidv7();
    await tx.exec(
      `INSERT INTO return_inspections (organization_id, id, return_id, return_item_id, product_id, client_request_id, line_index, disposition, qty,
                                       warehouse_id, location_id, inspector_user_id, reason, note, attachment_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        tx.orgId,
        inspectionId,
        r.id,
        it.id,
        it.product_id,
        input.clientRequestId,
        idx,
        line.disposition,
        line.qty,
        r.warehouse_id,
        line.disposition === 'discard' ? null : locationId,
        tx.actor.userId,
        line.reason?.trim().slice(0, 300) || null,
        line.note?.trim().slice(0, 500) || null,
        attachmentIds,
      ],
    );
    const bal = await getOrCreateBalance(tx, locationId, it.product_id);
    const mv = await applyMovement(tx, {
      balanceId: bal.id,
      type: MOVEMENT_FOR[line.disposition],
      onHandDelta: line.disposition === 'discard' ? 0 : line.qty,
      referenceType: 'return_inspection',
      referenceId: inspectionId,
      idempotencyKey: `return_inspection:${inspectionId}`,
      reason: `返品 ${r.return_number} ${it.sku} ${line.disposition}${line.disposition === 'discard' ? ` ${line.qty} 個（廃棄・在庫変動なし）` : ''}`,
    });
    if (!mv.applied) throw new AppError(409, 'CONCURRENT_UPDATE', 'この検品は既に処理されています');
    await tx.exec(`UPDATE return_items SET inspected_qty = inspected_qty + $3 WHERE organization_id = $1 AND id = $2`, [tx.orgId, it.id, line.qty]);
    const loc = await tx.one(`SELECT code FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, locationId]);
    results.push({ id: inspectionId, disposition: line.disposition, qty: line.qty, locationCode: line.disposition === 'discard' ? null : loc.code });
    summary[line.disposition] = (summary[line.disposition] ?? 0) + line.qty;
  }
  const agg = await tx.one(
    `SELECT COALESCE(SUM(received_qty), 0)::int AS received, COALESCE(SUM(inspected_qty), 0)::int AS inspected FROM return_items WHERE organization_id = $1 AND return_id = $2`,
    [tx.orgId, r.id],
  );
  const completed = agg.received > 0 && agg.inspected >= agg.received;
  await tx.exec(
    `UPDATE returns SET status = $3, inspection_started_at = COALESCE(inspection_started_at, now()),
            completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, r.id, completed ? 'completed' : 'inspecting'],
  );
  if (attachmentIds.length) {
    await tx.exec(`UPDATE attachments SET entity_type = 'return', entity_id = $3 WHERE organization_id = $1 AND id = ANY($2)`, [tx.orgId, attachmentIds, r.id]);
  }
  await recomputeOrderStatus(tx, r.order_id, completed ? `返品完了 ${r.return_number}` : `返品検品 ${r.return_number}`);
  await audit(tx, {
    action: 'return.inspect',
    entityType: 'return',
    entityId: r.id,
    summary: `${r.return_number} 検品（${Object.entries(summary).map(([k, v]) => `${k} ${v}`).join(' / ')}）${completed ? '・完了' : ''}`,
    metadata: { ...summary, completed, photos: attachmentIds.length },
  });
  return { duplicate: false, status: completed ? 'completed' : 'inspecting', inspections: results };
}

/** 交換: Replacement Order を作成し、通常の引当から出荷までの流れに載せる */
export async function createExchange(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  returnId: string,
  input: { items: { sku: string; quantity: number; originalOrderItemId?: string | null }[]; note?: string | null; allocateNow: boolean },
  allocationOpts: { allowPartial: boolean; autoRelease: boolean },
) {
  const r = await lockReturn(tx, returnId);
  if (!['authorized', 'in_transit', 'received', 'inspecting', 'completed'].includes(r.status)) {
    throw conflict('INVALID_TRANSITION', '交換は返品を承認した後に作成できます');
  }
  const existing = await tx.maybeOne(`SELECT exchange_number FROM exchanges WHERE organization_id = $1 AND return_id = $2 AND status <> 'cancelled'`, [tx.orgId, r.id]);
  if (existing) throw conflict('EXCHANGE_EXISTS', `この返品には交換 ${existing.exchange_number} が作成済みです`);
  const o = await tx.one(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, r.order_id]);
  const products = await tx.many(`SELECT id, sku, name, variant, active FROM products WHERE organization_id = $1 AND sku = ANY($2)`, [tx.orgId, input.items.map((i) => i.sku)]);
  for (const it of input.items) {
    const p = products.find((x) => x.sku === it.sku);
    if (!p) throw notFound(`商品 ${it.sku}`);
    if (!p.active) throw conflict('PRODUCT_INACTIVE', `商品 ${it.sku} は無効です`);
    if (it.originalOrderItemId) {
      const oi = await tx.maybeOne(`SELECT id FROM order_items WHERE organization_id = $1 AND id = $2 AND order_id = $3`, [tx.orgId, it.originalOrderItemId, o.id]);
      if (!oi) throw notFound('元注文の明細');
    }
  }
  const [exNumber] = await nextNumbers(deps.numberingPool, tx.orgId, 'exchange', 1);
  const exchangeId = uuidv7();
  await tx.exec(
    `INSERT INTO exchanges (organization_id, id, exchange_number, return_id, original_order_id, status, note, created_by) VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)`,
    [tx.orgId, exchangeId, exNumber, r.id, o.id, input.note?.trim().slice(0, 500) || null, tx.actor.userId],
  );
  for (const it of input.items) {
    await tx.exec(`INSERT INTO exchange_items (organization_id, id, exchange_id, product_id, quantity, original_order_item_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
      tx.orgId,
      uuidv7(),
      exchangeId,
      products.find((x) => x.sku === it.sku)!.id,
      it.quantity,
      it.originalOrderItemId ?? null,
    ]);
  }
  // 交換品の注文（単価 0・元注文の送付先スナップショットをコピー）。通常の注文作成・検証を通す
  const [created] = await createOrders(tx, deps, [
    {
      channelId: o.channel_id,
      orderType: 'replacement',
      sourceOrderId: o.id,
      exchangeId,
      normalized: {
        externalOrderId: `${o.external_order_id}-${exNumber}`.slice(0, 100),
        orderDate: new Date().toISOString(),
        customer: { name: o.customer_name ?? null, email: o.customer_email ?? null, phone: o.customer_phone ?? null, channelCustomerId: null },
        shipTo: {
          name: o.recipient_name ?? null,
          postalCode: o.postal_code ?? null,
          prefecture: o.prefecture ?? null,
          city: o.city ?? null,
          address1: o.address1 ?? null,
          address2: o.address2 ?? null,
          phone: o.recipient_phone ?? null,
        },
        shippingMethod: o.shipping_method ?? null,
        notes: `交換品（${r.return_number} / ${exNumber}）`,
        priority: Math.max(o.priority ?? 0, 1),
        cancelFlag: false,
        lines: input.items.map((i) => {
          const p = products.find((x) => x.sku === i.sku)!;
          return { sku: p.sku, productName: p.name, variant: p.variant ?? null, quantity: i.quantity, unitPrice: 0, externalLineId: null };
        }),
      },
    },
  ]);
  await tx.exec(`UPDATE exchanges SET replacement_order_id = $3 WHERE organization_id = $1 AND id = $2`, [tx.orgId, exchangeId, created!.id]);
  let allocation: { outcome: string } | null = null;
  if (input.allocateNow && created!.status === 'ready_for_allocation') {
    allocation = await allocateOrderInTx(tx, deps, created!.id, { allowPartial: allocationOpts.allowPartial, autoRelease: allocationOpts.autoRelease });
  }
  await audit(tx, {
    action: 'exchange.create',
    entityType: 'exchange',
    entityId: exchangeId,
    summary: `${exNumber}（${r.return_number}）交換品注文 ${created!.orderNumber} を作成`,
    metadata: { items: input.items.length, units: input.items.reduce((s, i) => s + i.quantity, 0), allocation: allocation?.outcome ?? null },
  });
  return { exchangeId, exchangeNumber: exNumber, replacementOrderId: created!.id, replacementOrderNumber: created!.orderNumber, allocation: allocation?.outcome ?? null };
}

export { OPEN_STATUSES };
