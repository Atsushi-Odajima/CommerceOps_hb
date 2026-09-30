/**
 * Shipment（出荷）: docs/FULFILLMENT_RULES.md / docs/INVENTORY_RULES.md
 * - Order / Fulfillment と分離。1 注文 → 複数 Shipment（複数箱・分割発送）
 * - 出荷確定: 梱包数量・荷物数量・注文数量・引当・在庫をサーバー側で検証し、在庫 on_hand 減算 + 引当消化を 1 トランザクションで行う
 * - 再送（R12）: 確定済みなら何もしない。在庫移動は冪等キー ship:{shipmentId}:{allocationId} で二重減算しない
 * - 分割発送（R13）: 荷物数量の合計は梱包数量・注文数量（取消を除く）を超えない（条件付き UPDATE + CHECK 制約）
 * - ロック順序: Fulfillment → Shipment →（状態再計算で）Order
 */
import type { Tx } from '../../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { applyMovement } from '../inventory/service.js';
import { refreshAllocationStatus } from '../allocation/engine.js';
import { refreshFulfillmentStatus, refreshWaveStatus } from '../fulfillment/status.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { shipToSnapshot } from '../packing/service.js';

export const CARRIERS: { code: string; label: string; aliases: string[] }[] = [
  { code: 'yamato', label: 'ヤマト運輸', aliases: ['ヤマト', 'クロネコヤマト', 'クロネコ', '宅急便'] },
  { code: 'sagawa', label: '佐川急便', aliases: ['佐川', '飛脚'] },
  { code: 'japanpost', label: '日本郵便', aliases: ['郵便', 'ゆうパック', 'ゆうパケット', 'ゆうメール', 'jp post'] },
  { code: 'seino', label: '西濃運輸', aliases: ['西濃', 'カンガルー便'] },
  { code: 'fukutsu', label: '福山通運', aliases: ['福山', 'fukuyama'] },
  { code: 'other', label: 'その他', aliases: [] },
];

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** 配送会社コード / 名称 / 別名 → コード */
export function resolveCarrier(input: string): string | null {
  const v = norm(input);
  if (!v) return null;
  for (const c of CARRIERS) {
    if (v === c.code || v === norm(c.label) || c.aliases.some((a) => norm(a) === v)) return c.code;
  }
  for (const c of CARRIERS) if (c.code !== 'other' && (v.includes(norm(c.label)) || c.aliases.some((a) => v.includes(norm(a))))) return c.code;
  return null;
}

export const carrierLabel = (code: string | null | undefined) => CARRIERS.find((c) => c.code === code)?.label ?? code ?? '';

/** 追跡番号の正規化: 全角→半角、空白・ハイフン除去、英大文字。4〜40 文字の英数字のみ */
export function normalizeTracking(input: string): string {
  const v = input.normalize('NFKC').replace(/[\s\-‐－ー―]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{4,40}$/.test(v)) throw badRequest('TRACKING_INVALID', `追跡番号の形式が正しくありません（英数字 4〜40 文字）: ${input.slice(0, 50)}`);
  return v;
}

async function findTrackingOwner(tx: Tx, carrier: string, tracking: string, exceptShipmentId: string) {
  return tx.maybeOne(
    `SELECT s.id, s.shipment_number, o.order_number FROM shipments s JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id
      WHERE s.organization_id = $1 AND s.carrier = $2 AND s.tracking_number = $3 AND s.status <> 'cancelled' AND s.id <> $4`,
    [tx.orgId, carrier, tracking, exceptShipmentId],
  );
}

export class TrackingDuplicateError extends AppError {
  constructor(
    public readonly carrier: string,
    public readonly tracking: string,
    owner: { shipment_number: string; order_number: string },
  ) {
    super(409, 'TRACKING_DUPLICATE', `追跡番号 ${tracking}（${carrierLabel(carrier)}）は ${owner.shipment_number}（${owner.order_number}）で使用済みです`, {
      shipmentNumber: owner.shipment_number,
      orderNumber: owner.order_number,
    });
  }
}

export interface ShipmentPatch {
  carrier?: string | null;
  service?: string | null;
  trackingNumber?: string | null;
  noTracking?: boolean;
  weightG?: number | null;
  packageType?: string | null;
  reason?: string;
}

/** 配送会社・追跡番号などの入力。出荷済みは配送会社・追跡番号の訂正のみ（理由必須・監査） */
export async function updateShipmentInfo(tx: Tx, shipmentId: string, input: ShipmentPatch) {
  const sh = await tx.maybeOne(`SELECT * FROM shipments WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, shipmentId]);
  if (!sh) throw notFound('荷物');
  if (sh.status === 'cancelled') throw conflict('SHIPMENT_CANCELLED', '取消済みの荷物です');
  const shipped = sh.status === 'shipped';
  if (shipped) {
    if (input.service !== undefined || input.weightG !== undefined || input.packageType !== undefined) {
      throw conflict('SHIPPED_LOCKED', '出荷済みの荷物は配送会社・追跡番号の訂正のみできます');
    }
    if (!input.reason?.trim()) throw badRequest('REASON_REQUIRED', '出荷済みの荷物の訂正には理由が必要です');
  }
  let carrier: string | null = sh.carrier;
  if (input.carrier !== undefined) {
    if (input.carrier === null || input.carrier === '') carrier = null;
    else {
      carrier = resolveCarrier(input.carrier);
      if (!carrier) throw badRequest('CARRIER_INVALID', `配送会社「${input.carrier.slice(0, 30)}」を認識できません`);
    }
  }
  let noTracking: boolean = input.noTracking ?? sh.no_tracking;
  let tracking: string | null = sh.tracking_number;
  if (input.trackingNumber !== undefined) {
    tracking = input.trackingNumber === null || input.trackingNumber.trim() === '' ? null : normalizeTracking(input.trackingNumber);
    if (tracking) noTracking = false;
  }
  if (noTracking) tracking = null;
  if (shipped && !carrier) throw conflict('CARRIER_REQUIRED', '配送会社を指定してください');
  if (tracking && carrier) {
    const owner = await findTrackingOwner(tx, carrier, tracking, sh.id);
    if (owner) throw new TrackingDuplicateError(carrier, tracking, owner as { shipment_number: string; order_number: string });
  }
  await tx.exec(
    `UPDATE shipments SET carrier = $3, service = $4, tracking_number = $5, no_tracking = $6, weight_g = $7, package_type = $8, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [
      tx.orgId,
      sh.id,
      carrier,
      input.service !== undefined ? input.service?.trim() || null : sh.service,
      tracking,
      noTracking,
      input.weightG !== undefined ? input.weightG : sh.weight_g,
      input.packageType !== undefined ? input.packageType?.trim() || null : sh.package_type,
    ],
  );
  const changed = (tracking ?? null) !== (sh.tracking_number ?? null) || carrier !== sh.carrier;
  if (shipped || changed) {
    await audit(tx, {
      action: shipped ? 'shipment.tracking_correct' : 'shipment.update',
      entityType: 'shipment',
      entityId: sh.id,
      summary: `${sh.shipment_number} の${shipped ? '追跡番号を訂正' : '配送情報を更新'}`,
      metadata: { carrier, trackingChanged: (tracking ?? null) !== (sh.tracking_number ?? null), noTracking, reasonLength: input.reason?.length ?? 0 },
    });
  }
  return { id: sh.id, carrier, trackingNumber: tracking, noTracking };
}

/** 引当を出荷分だけ消化（allocated と on_hand を減らす）。冪等キーで二重減算しない */
async function consumeAllocation(tx: Tx, a: any, take: number, shipment: any): Promise<void> {
  const key = `ship:${shipment.id}:${a.id}`;
  const done = await tx.maybeOne(`SELECT 1 FROM inventory_movements WHERE organization_id = $1 AND idempotency_key = $2`, [tx.orgId, key]);
  if (done) throw new AppError(409, 'CONCURRENT_UPDATE', 'この荷物の在庫処理は既に行われています');
  const bal = await tx.maybeOne(
    `UPDATE inventory_balances SET allocated = allocated - $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND allocated >= $3 RETURNING id`,
    [tx.orgId, a.balance_id, take],
  );
  if (!bal) throw new AppError(409, 'INVENTORY_INCONSISTENT', '在庫の引当数が不足しています（在庫の整合性を確認してください）');
  const r = await applyMovement(tx, {
    balanceId: a.balance_id,
    type: 'ship',
    onHandDelta: -take,
    referenceType: 'allocation',
    referenceId: a.id,
    idempotencyKey: key,
    reason: `出荷 ${shipment.shipment_number}`,
  });
  if (!r.applied) throw new AppError(409, 'CONCURRENT_UPDATE', 'この荷物の在庫処理は既に行われています');
  await tx.exec(
    `UPDATE allocations SET shipped_qty = shipped_qty + $3,
            status = CASE WHEN shipped_qty + $3 + released_qty >= quantity THEN 'consumed' ELSE status END,
            consumed_at = CASE WHEN shipped_qty + $3 + released_qty >= quantity THEN now() ELSE consumed_at END
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, a.id, take],
  );
}

export interface ConfirmResult {
  shipmentId: string;
  shipmentNumber: string;
  alreadyShipped: boolean;
  orderStatus?: string;
  fulfillmentStatus?: string;
}

/** 出荷確定（冪等）。在庫減算・引当消化・数量検証を 1 トランザクションで行う */
export async function confirmShipment(
  tx: Tx,
  shipmentId: string,
  input: { shippedAt?: string | Date | null },
  opts: { requireTracking: boolean },
): Promise<ConfirmResult> {
  const s0 = await tx.maybeOne(`SELECT fulfillment_id FROM shipments WHERE organization_id = $1 AND id = $2`, [tx.orgId, shipmentId]);
  if (!s0) throw notFound('荷物');
  const f = await tx.one(`SELECT * FROM fulfillments WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, s0.fulfillment_id]);
  const sh = await tx.one(`SELECT * FROM shipments WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, shipmentId]);
  if (sh.status === 'shipped') return { shipmentId: sh.id, shipmentNumber: sh.shipment_number, alreadyShipped: true };
  if (sh.status === 'cancelled') throw conflict('SHIPMENT_CANCELLED', '取消済みの荷物は出荷できません');
  const o = await tx.one(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, sh.order_id]);
  if (o.cancelled_at || f.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'キャンセルされた注文の荷物は出荷できません');
  if (f.on_hold) throw conflict('ON_HOLD', `注文が保留中のため出荷できません（${f.hold_reason ?? ''}）`);
  if (sh.pack_session_id) {
    const ps = await tx.maybeOne(`SELECT status FROM pack_sessions WHERE organization_id = $1 AND id = $2`, [tx.orgId, sh.pack_session_id]);
    if (ps?.status !== 'completed') throw conflict('NOT_PACKED', '梱包が完了していない荷物です');
  }
  if (!sh.carrier) throw conflict('CARRIER_REQUIRED', '配送会社を入力してください');
  if (opts.requireTracking && !sh.tracking_number && !sh.no_tracking) {
    throw conflict('TRACKING_REQUIRED', '追跡番号を入力してください（追跡番号のない配送方法は「追跡番号なし」を選択）');
  }
  const shippedAt = input.shippedAt ? new Date(input.shippedAt) : new Date();
  if (Number.isNaN(shippedAt.getTime())) throw badRequest('INVALID_DATE', '出荷日時が不正です');
  if (shippedAt.getTime() > Date.now() + 24 * 3600_000) throw badRequest('INVALID_DATE', '出荷日時が未来すぎます');
  const items = await tx.many(
    `SELECT si.*, p.sku FROM shipment_items si LEFT JOIN products p ON p.organization_id = si.organization_id AND p.id = si.product_id
      WHERE si.organization_id = $1 AND si.shipment_id = $2 ORDER BY si.id`,
    [tx.orgId, sh.id],
  );
  if (!items.length) throw conflict('EMPTY_SHIPMENT', '中身のない荷物は出荷できません');
  for (const it of items) {
    // R13: 梱包数量・注文数量を超えて出荷しない
    const fi = await tx.maybeOne(
      `UPDATE fulfillment_items SET shipped_qty = shipped_qty + $3, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND shipped_qty + $3 <= packed_qty RETURNING id`,
      [tx.orgId, it.fulfillment_item_id, it.quantity],
    );
    if (!fi) throw conflict('EXCEEDS_PACKED', `${it.sku}: 梱包済み数量を超えて出荷できません`);
    const oi = await tx.maybeOne(
      `UPDATE order_items SET shipped_qty = shipped_qty + $3, allocated_qty = allocated_qty - $3, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND shipped_qty + cancelled_qty + $3 <= quantity AND allocated_qty >= $3 RETURNING id`,
      [tx.orgId, it.order_item_id, it.quantity],
    );
    if (!oi) throw conflict('EXCEEDS_ORDERED', `${it.sku}: 注文数量（取消分を除く）または引当数量を超えて出荷できません`);
    const allocs = await tx.many(
      `SELECT * FROM allocations WHERE organization_id = $1 AND fulfillment_item_id = $2 AND status = 'active' AND quantity - shipped_qty - released_qty > 0
        ORDER BY created_at, id FOR UPDATE`,
      [tx.orgId, it.fulfillment_item_id],
    );
    let remaining = it.quantity;
    for (const a of allocs) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, a.quantity - a.shipped_qty - a.released_qty);
      await consumeAllocation(tx, a, take, sh);
      remaining -= take;
    }
    if (remaining > 0) throw new AppError(409, 'ALLOCATION_MISSING', `${it.sku}: 出荷に対応する引当が不足しています（在庫の整合性を確認してください）`);
  }
  await tx.exec(
    `UPDATE shipments SET status = 'shipped', shipped_at = $3, confirmed_by = $4, ship_to = $5, updated_at = now() WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, sh.id, shippedAt, tx.actor.userId, JSON.stringify(shipToSnapshot(o))],
  );
  const fStatus = await refreshFulfillmentStatus(tx, f.id);
  await refreshAllocationStatus(tx, o.id);
  const st = await recomputeOrderStatus(tx, o.id, `出荷 ${sh.shipment_number}`);
  if (f.wave_id) await refreshWaveStatus(tx, f.wave_id);
  await audit(tx, {
    action: 'shipment.confirm',
    entityType: 'shipment',
    entityId: sh.id,
    summary: `${sh.shipment_number}（${o.order_number} 箱 ${sh.box_no}）を出荷確定`,
    metadata: { carrier: sh.carrier, hasTracking: !!sh.tracking_number, units: items.reduce((s, i) => s + i.quantity, 0) },
  });
  return { shipmentId: sh.id, shipmentNumber: sh.shipment_number, alreadyShipped: false, orderStatus: st.to, fulfillmentStatus: fStatus };
}

/** 個人情報の表示範囲は注文と同じ（ship_to: 氏名・住所、full: + 電話） */
export function presentShipment(s: any, level: 'full' | 'ship_to' | 'none') {
  const shipTo = s.ship_to && level !== 'none' ? { ...s.ship_to, phone: level === 'full' ? s.ship_to.phone : undefined } : undefined;
  return {
    id: s.id,
    shipmentNumber: s.shipment_number,
    orderId: s.order_id,
    orderNumber: s.order_number,
    externalOrderId: s.external_order_id,
    channelName: s.channel_name,
    fulfillmentId: s.fulfillment_id,
    fulfillmentNumber: s.fulfillment_number,
    warehouseId: s.warehouse_id,
    warehouseCode: s.warehouse_code,
    boxNo: s.box_no,
    carrier: s.carrier,
    carrierLabel: carrierLabel(s.carrier),
    service: s.service,
    trackingNumber: s.tracking_number,
    noTracking: s.no_tracking,
    status: s.status,
    weightG: s.weight_g,
    packageType: s.package_type,
    shippedAt: s.shipped_at,
    confirmedBy: s.confirmed_by_name,
    createdAt: s.created_at,
    onHold: s.on_hold ?? undefined,
    units: s.units ?? undefined,
    recipientName: level !== 'none' ? (s.ship_to?.name ?? s.recipient_name) : undefined,
    shipTo,
  };
}
