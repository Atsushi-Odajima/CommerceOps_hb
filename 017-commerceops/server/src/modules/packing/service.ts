/**
 * Packing Station（docs/PICK_PACK_RULES.md §3）
 * - 1 Fulfillment = 1 active PackSession（部分 UNIQUE + Fulfillment 行ロック）。期限切れセッションは別の Packer が引き継げる
 * - 商品を 1 個ずつ scan。誤 SKU / 別注文 / 別 variant / 数量過多 / 未登録コードは数量を加算せず誤 scan として記録
 * - scan は client_event_id で冪等（R11）。完了は requestId で冪等
 * - 全数一致しないと完了できない（R10）。強制完了は pack.force_complete 権限 + 理由 + 例外 forced_pack
 * - 完了時に箱ごとの下書き Shipment を作成（出荷確定は Phase6 の shipments）
 * - ロック順序は常に Fulfillment → PackSession（注文キャンセル等とのデッドロック回避）
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import { createException } from '../exceptions/service.js';
import { refreshFulfillmentStatus, refreshWaveStatus } from '../fulfillment/status.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { resolveProductByCode } from '../products/routes.js';

export type InputMethod = 'camera' | 'scanner' | 'manual';

export interface PackScanResult {
  ok: boolean;
  duplicate?: boolean;
  code?: string;
  message?: string;
  item?: { fulfillmentItemId: string; sku: string; required: number; packed: number; remaining: number };
  allPacked?: boolean;
  boxNo?: number;
  misScanCount?: number;
}

const MIS_CODE: Record<string, string> = {
  mis_scan_wrong_sku: 'WRONG_SKU',
  mis_scan_other_order: 'OTHER_ORDER',
  mis_scan_variant: 'WRONG_VARIANT',
  mis_scan_over: 'OVER_PACK',
  mis_scan_unknown: 'UNKNOWN_CODE',
};

/** 数量に効くイベント（net = 合計） */
const QTY_EVENTS = `('scan', 'correction', 'force_complete')`;

export function shipToSnapshot(o: any) {
  return {
    name: o.recipient_name,
    postalCode: o.postal_code,
    prefecture: o.prefecture,
    city: o.city,
    address1: o.address1,
    address2: o.address2,
    phone: o.recipient_phone,
  };
}

/** 注文番号 / 出荷作業番号から梱包対象の Fulfillment を特定 */
export async function resolvePackTarget(tx: Tx, code: string, warehouseIds: string[] | null): Promise<{ fulfillmentId: string } | { choices: any[] }> {
  const c = code.normalize('NFKC').trim().toUpperCase();
  const f = await tx.maybeOne(`SELECT id FROM fulfillments WHERE organization_id = $1 AND fulfillment_number = $2`, [tx.orgId, c]);
  if (f) return { fulfillmentId: f.id };
  const o = await tx.maybeOne(`SELECT id, order_number FROM orders WHERE organization_id = $1 AND order_number = $2`, [tx.orgId, c]);
  if (!o) throw notFound(`コード「${code.trim().slice(0, 40)}」に該当する注文・出荷作業`);
  const ffs = await tx.many(
    `SELECT f.id, f.fulfillment_number, f.status, f.on_hold, w.code AS warehouse_code
       FROM fulfillments f JOIN warehouses w ON w.organization_id = f.organization_id AND w.id = f.warehouse_id
      WHERE f.organization_id = $1 AND f.order_id = $2 AND f.status NOT IN ('cancelled', 'shipped')
        AND ($3::uuid[] IS NULL OR f.warehouse_id = ANY($3))
      ORDER BY f.created_at`,
    [tx.orgId, o.id, warehouseIds],
  );
  const packable = ffs.filter((x) => ['picked', 'packing'].includes(x.status));
  if (packable.length === 1) return { fulfillmentId: packable[0].id };
  if (!ffs.length) throw conflict('NOTHING_TO_PACK', `${o.order_number} に梱包できる出荷作業はありません`);
  if (!packable.length) {
    throw conflict('NOTHING_TO_PACK', `${o.order_number} はまだ梱包できる状態ではありません（${ffs.map((x) => `${x.fulfillment_number}: ${x.status}`).join(', ')}）`);
  }
  return { choices: packable.map((x) => ({ fulfillmentId: x.id, fulfillmentNumber: x.fulfillment_number, status: x.status, warehouseCode: x.warehouse_code })) };
}

async function lockFulfillment(tx: Tx, fulfillmentId: string) {
  const f = await tx.maybeOne(`SELECT * FROM fulfillments WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, fulfillmentId]);
  if (!f) throw notFound('出荷作業');
  return f;
}

function assertPackable(f: any) {
  if (f.status === 'cancelled') throw conflict('FULFILLMENT_CANCELLED', 'この出荷作業は取消されています');
  if (f.status === 'shipped') throw conflict('ALREADY_SHIPPED', 'この出荷作業は出荷済みです');
  if (f.on_hold) throw conflict('ON_HOLD', `この注文は保留中です（${f.hold_reason ?? '理由未設定'}）。保留解除まで梱包できません`);
}

async function loadItems(tx: Tx, fulfillmentId: string) {
  return tx.many(
    `SELECT fi.*, p.sku, p.name, p.variant, p.group_code, p.image_url
       FROM fulfillment_items fi LEFT JOIN products p ON p.organization_id = fi.organization_id AND p.id = fi.product_id
      WHERE fi.organization_id = $1 AND fi.fulfillment_id = $2 AND fi.required_qty > 0
      ORDER BY p.sku, fi.id`,
    [tx.orgId, fulfillmentId],
  );
}

function assertFullyPicked(items: any[]) {
  const shortItems = items.filter((i) => i.short_qty > 0);
  if (shortItems.length) throw conflict('PICK_INCOMPLETE', `Short（棚になし）が未解決です（${shortItems.map((i) => i.sku).join(', ')}）。管理者の対応後に梱包してください`);
  const notPicked = items.filter((i) => i.picked_qty < i.required_qty);
  if (notPicked.length) {
    throw conflict('PICK_INCOMPLETE', `ピッキングが完了していません（${notPicked.map((i) => `${i.sku} ${i.picked_qty}/${i.required_qty}`).join(', ')}）`, {
      items: notPicked.map((i) => ({ sku: i.sku, picked: i.picked_qty, required: i.required_qty })),
    });
  }
}

async function afterChange(tx: Tx, f: any, reason: string) {
  await refreshFulfillmentStatus(tx, f.id);
  await recomputeOrderStatus(tx, f.order_id, reason);
  if (f.wave_id) await refreshWaveStatus(tx, f.wave_id);
}

/** 梱包開始（または自分のセッションの再開 / 期限切れセッションの引継ぎ） */
export async function openPackSession(tx: Tx, fulfillmentId: string, userId: string, ttlMinutes: number, opts: { takeover?: boolean } = {}) {
  const f = await lockFulfillment(tx, fulfillmentId);
  assertPackable(f);
  if (f.status === 'packed') throw conflict('ALREADY_PACKED', `${f.fulfillment_number} は梱包済みです。やり直す場合は「梱包を取り消す」を使ってください`);
  const items = await loadItems(tx, fulfillmentId);
  if (!items.length) throw conflict('NOTHING_TO_PACK', '梱包する商品がありません');
  assertFullyPicked(items);
  const active = await tx.maybeOne(
    `SELECT s.*, u.name AS packer_name FROM pack_sessions s LEFT JOIN users u ON u.id = s.packer_user_id
      WHERE s.organization_id = $1 AND s.fulfillment_id = $2 AND s.status = 'active' FOR UPDATE OF s`,
    [tx.orgId, fulfillmentId],
  );
  if (active) {
    const expired = active.claim_expires_at && new Date(active.claim_expires_at) < new Date();
    if (active.packer_user_id !== userId && !expired && !opts.takeover) {
      throw conflict('PACK_IN_PROGRESS', `${active.packer_name ?? '別の作業者'} が梱包中です`, { sessionId: active.id, packerName: active.packer_name });
    }
    await tx.exec(
      `UPDATE pack_sessions SET packer_user_id = $3, claim_expires_at = now() + make_interval(mins => $4) WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, active.id, userId, ttlMinutes],
    );
    if (active.packer_user_id !== userId) {
      await audit(tx, {
        action: 'pack.takeover',
        entityType: 'pack_session',
        entityId: active.id,
        summary: `${f.fulfillment_number} の梱包を引き継ぎ（${expired ? '前担当の作業期限切れ' : '管理者による引継ぎ'}）`,
        metadata: { previousPacker: active.packer_user_id },
      });
    }
    const takenOver = active.packer_user_id !== userId;
    return { sessionId: active.id as string, resumed: true, takenOver, takeoverReason: takenOver ? (expired ? 'expired' : 'manager') : null };
  }
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO pack_sessions (organization_id, id, fulfillment_id, warehouse_id, packer_user_id, claim_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [tx.orgId, id, fulfillmentId, f.warehouse_id, userId, ttlMinutes],
  );
  await afterChange(tx, f, '梱包開始');
  await audit(tx, { action: 'pack.start', entityType: 'pack_session', entityId: id, summary: `${f.fulfillment_number} の梱包を開始` });
  return { sessionId: id, resumed: false, takenOver: false, takeoverReason: null };
}

/** Fulfillment → Session の順にロック。担当者の検証と期限延長 */
async function lockSessionForPacker(tx: Tx, sessionId: string, userId: string, ttlMinutes: number) {
  const s0 = await tx.maybeOne(`SELECT fulfillment_id FROM pack_sessions WHERE organization_id = $1 AND id = $2`, [tx.orgId, sessionId]);
  if (!s0) throw notFound('梱包セッション');
  const f = await lockFulfillment(tx, s0.fulfillment_id);
  const s = await tx.one(`SELECT * FROM pack_sessions WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, sessionId]);
  return { f, s, touch: () => touchSession(tx, s, userId, ttlMinutes) };
}

async function touchSession(tx: Tx, s: any, userId: string, ttlMinutes: number) {
  if (s.status !== 'active') throw conflict('SESSION_CLOSED', 'この梱包セッションは完了または中止されています');
  const expired = s.claim_expires_at && new Date(s.claim_expires_at) < new Date();
  if (s.packer_user_id !== userId && !expired) throw conflict('NOT_ASSIGNED', 'この梱包は別の作業者が担当しています');
  await tx.exec(
    `UPDATE pack_sessions SET packer_user_id = $3, claim_expires_at = now() + make_interval(mins => $4) WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, s.id, userId, ttlMinutes],
  );
}

async function previousScanResult(tx: Tx, clientEventId: string, sessionId: string): Promise<PackScanResult | null> {
  const e = await tx.maybeOne(
    `SELECT e.*, p.sku FROM pack_events e LEFT JOIN products p ON p.organization_id = e.organization_id AND p.id = e.product_id
      WHERE e.organization_id = $1 AND e.client_event_id = $2`,
    [tx.orgId, clientEventId],
  );
  if (!e) return null;
  if (e.pack_session_id !== sessionId) throw conflict('EVENT_ID_REUSED', '同じイベント ID が別の梱包で使われています');
  if (MIS_CODE[e.event_type]) return { ok: false, duplicate: true, code: MIS_CODE[e.event_type], message: e.message ?? '前回と同じ誤 scan です' };
  return { ok: true, duplicate: true, message: e.message ?? undefined, boxNo: e.box_no };
}

async function insertPackEvent(
  tx: Tx,
  e: {
    clientEventId: string;
    session: any;
    fulfillmentItemId?: string | null;
    productId?: string | null;
    userId: string;
    type: string;
    qty?: number;
    boxNo: number;
    code?: string | null;
    inputMethod?: InputMethod | null;
    message?: string | null;
  },
) {
  await tx.exec(
    `INSERT INTO pack_events (organization_id, id, client_event_id, pack_session_id, fulfillment_id, fulfillment_item_id, product_id, packer_user_id,
                              event_type, qty, box_no, scanned_code, input_method, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      tx.orgId,
      uuidv7(),
      e.clientEventId,
      e.session.id,
      e.session.fulfillment_id,
      e.fulfillmentItemId ?? null,
      e.productId ?? null,
      e.userId,
      e.type,
      e.qty ?? 0,
      e.boxNo,
      e.code?.slice(0, 128) ?? null,
      e.inputMethod ?? null,
      e.message?.slice(0, 300) ?? null,
    ],
  );
}

async function recordMisScan(tx: Tx, s: any, userId: string, input: { clientEventId: string; code: string; inputMethod?: InputMethod }, type: string, message: string, productId?: string | null): Promise<PackScanResult> {
  await insertPackEvent(tx, { clientEventId: input.clientEventId, session: s, productId, userId, type, boxNo: s.current_box, code: input.code, inputMethod: input.inputMethod, message });
  const r = await tx.one(`UPDATE pack_sessions SET mis_scan_count = mis_scan_count + 1 WHERE organization_id = $1 AND id = $2 RETURNING mis_scan_count`, [tx.orgId, s.id]);
  return { ok: false, code: MIS_CODE[type], message, misScanCount: r.mis_scan_count };
}

/** 商品 scan（1 scan = 1 個。qty > 1 は同じ商品を 1 個以上 scan 済みの場合のみ = まとめ入力） */
export async function packScan(
  tx: Tx,
  sessionId: string,
  userId: string,
  input: { clientEventId: string; code: string; qty: number; inputMethod?: InputMethod },
  ttlMinutes: number,
): Promise<PackScanResult> {
  const { f, s, touch } = await lockSessionForPacker(tx, sessionId, userId, ttlMinutes);
  const prev = await previousScanResult(tx, input.clientEventId, sessionId);
  if (prev) return prev;
  await touch();
  assertPackable(f);
  const items = await loadItems(tx, f.id);
  const p = await resolveProductByCode(tx, input.code);
  if (!p) return recordMisScan(tx, s, userId, input, 'mis_scan_unknown', `「${input.code.slice(0, 40)}」は登録されていないコードです`);
  const candidates = items.filter((i) => i.product_id === p.id);
  if (!candidates.length) {
    const other = f.wave_id
      ? await tx.maybeOne(
          `SELECT f2.fulfillment_number FROM fulfillment_items fi JOIN fulfillments f2 ON f2.organization_id = fi.organization_id AND f2.id = fi.fulfillment_id
            WHERE fi.organization_id = $1 AND f2.wave_id = $2 AND f2.id <> $3 AND fi.product_id = $4 AND f2.status NOT IN ('cancelled', 'shipped')
            ORDER BY f2.fulfillment_number LIMIT 1`,
          [tx.orgId, f.wave_id, f.id, p.id],
        )
      : null;
    if (other) return recordMisScan(tx, s, userId, input, 'mis_scan_other_order', `別の注文の商品です（${p.sku} は ${other.fulfillment_number} の商品）`, p.id);
    const sameGroup = p.group_code ? items.filter((i) => i.group_code === p.group_code) : [];
    if (sameGroup.length) {
      return recordMisScan(tx, s, userId, input, 'mis_scan_variant', `別バリエーションです（読取: ${p.sku}${p.variant ? ` ${p.variant}` : ''} / 正: ${sameGroup.map((i) => `${i.sku}${i.variant ? ` ${i.variant}` : ''}`).join(', ')}）`, p.id);
    }
    return recordMisScan(tx, s, userId, input, 'mis_scan_wrong_sku', `この注文の商品ではありません（${p.sku} ${p.name}）`, p.id);
  }
  const qty = input.qty;
  if (qty > 1) {
    const scanned = await tx.one(
      `SELECT COALESCE(SUM(qty), 0)::int AS n FROM pack_events WHERE organization_id = $1 AND pack_session_id = $2 AND product_id = $3 AND event_type = 'scan'`,
      [tx.orgId, s.id, p.id],
    );
    if (scanned.n < 1) throw conflict('SCAN_FIRST', 'まとめて入力する前に、実物の商品を 1 個スキャンしてください');
  }
  const target = candidates.find((i) => i.picked_qty - i.packed_qty >= qty);
  if (!target) {
    const remaining = candidates.reduce((sum, i) => sum + (i.picked_qty - i.packed_qty), 0);
    return recordMisScan(tx, s, userId, input, 'mis_scan_over', `数量過多です（${p.sku} は残り ${remaining} 個${qty > 1 ? ` / 入力 ${qty} 個` : ''}）`, p.id);
  }
  const upd = await tx.maybeOne(
    `UPDATE fulfillment_items SET packed_qty = packed_qty + $3, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND packed_qty + $3 <= picked_qty RETURNING packed_qty, required_qty`,
    [tx.orgId, target.id, qty],
  );
  if (!upd) throw new AppError(409, 'CONCURRENT_UPDATE', '他の操作と競合しました。再読み込みしてください');
  await insertPackEvent(tx, {
    clientEventId: input.clientEventId,
    session: s,
    fulfillmentItemId: target.id,
    productId: p.id,
    userId,
    type: 'scan',
    qty,
    boxNo: s.current_box,
    code: input.code,
    inputMethod: input.inputMethod,
    message: `${p.sku} × ${qty}`,
  });
  const rest = await tx.one(
    `SELECT COALESCE(SUM(required_qty - packed_qty), 0)::int AS n FROM fulfillment_items WHERE organization_id = $1 AND fulfillment_id = $2`,
    [tx.orgId, f.id],
  );
  return {
    ok: true,
    item: { fulfillmentItemId: target.id, sku: p.sku, required: upd.required_qty, packed: upd.packed_qty, remaining: upd.required_qty - upd.packed_qty },
    allPacked: rest.n === 0,
    boxNo: s.current_box,
    misScanCount: s.mis_scan_count,
  };
}

async function netByItemBox(tx: Tx, sessionId: string) {
  return tx.many(
    `SELECT fulfillment_item_id, box_no, SUM(qty)::int AS qty FROM pack_events
      WHERE organization_id = $1 AND pack_session_id = $2 AND event_type IN ${QTY_EVENTS} AND fulfillment_item_id IS NOT NULL
      GROUP BY fulfillment_item_id, box_no`,
    [tx.orgId, sessionId],
  );
}

/** scan 訂正（1 個取消）。負数イベントを追加し、最後の箱から減らす */
export async function packCorrect(
  tx: Tx,
  sessionId: string,
  userId: string,
  input: { clientEventId: string; fulfillmentItemId: string; qty: number },
  ttlMinutes: number,
) {
  const { f, s, touch } = await lockSessionForPacker(tx, sessionId, userId, ttlMinutes);
  const prev = await previousScanResult(tx, input.clientEventId, sessionId);
  if (prev) return prev;
  await touch();
  if (f.status === 'cancelled' || f.status === 'shipped') assertPackable(f);
  const nets = (await netByItemBox(tx, s.id)).filter((n) => n.fulfillment_item_id === input.fulfillmentItemId && n.qty > 0).sort((a, b) => b.box_no - a.box_no);
  const box = nets.find((n) => n.qty >= input.qty);
  if (!box) throw conflict('NOTHING_TO_CORRECT', '取り消せる scan 済み数量がありません');
  const upd = await tx.maybeOne(
    `UPDATE fulfillment_items SET packed_qty = packed_qty - $3, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND fulfillment_id = $4 AND packed_qty >= $3 RETURNING packed_qty, required_qty, product_id`,
    [tx.orgId, input.fulfillmentItemId, input.qty, f.id],
  );
  if (!upd) throw conflict('NOTHING_TO_CORRECT', '取り消せる scan 済み数量がありません');
  await insertPackEvent(tx, {
    clientEventId: input.clientEventId,
    session: s,
    fulfillmentItemId: input.fulfillmentItemId,
    productId: upd.product_id,
    userId,
    type: 'correction',
    qty: -input.qty,
    boxNo: box.box_no,
    message: `訂正 −${input.qty}`,
  });
  return { ok: true, packed: upd.packed_qty, remaining: upd.required_qty - upd.packed_qty, boxNo: box.box_no };
}

/** 箱を閉じて次の箱へ（空の箱は閉じられない） */
export async function packNextBox(tx: Tx, sessionId: string, userId: string, input: { clientEventId: string }, ttlMinutes: number) {
  const { s, touch } = await lockSessionForPacker(tx, sessionId, userId, ttlMinutes);
  const prev = await previousScanResult(tx, input.clientEventId, sessionId);
  if (prev) return { ok: true, duplicate: true, currentBox: s.current_box };
  await touch();
  const inBox = (await netByItemBox(tx, s.id)).filter((n) => n.box_no === s.current_box).reduce((sum, n) => sum + n.qty, 0);
  if (inBox <= 0) throw conflict('EMPTY_BOX', `箱 ${s.current_box} に商品が入っていません`);
  await insertPackEvent(tx, { clientEventId: input.clientEventId, session: s, userId, type: 'box_close', boxNo: s.current_box, message: `箱 ${s.current_box} を閉じる（${inBox} 個）` });
  const r = await tx.one(`UPDATE pack_sessions SET current_box = current_box + 1 WHERE organization_id = $1 AND id = $2 RETURNING current_box`, [tx.orgId, s.id]);
  return { ok: true, currentBox: r.current_box as number };
}

async function sessionShipments(tx: Tx, sessionId: string) {
  const ships = await tx.many(
    `SELECT id, shipment_number, box_no, status FROM shipments WHERE organization_id = $1 AND pack_session_id = $2 ORDER BY box_no`,
    [tx.orgId, sessionId],
  );
  const items = await tx.many(
    `SELECT si.shipment_id, si.quantity, p.sku FROM shipment_items si LEFT JOIN products p ON p.organization_id = si.organization_id AND p.id = si.product_id
      WHERE si.organization_id = $1 AND si.shipment_id = ANY($2)`,
    [tx.orgId, ships.map((x) => x.id)],
  );
  return ships.map((x) => ({
    id: x.id,
    shipmentNumber: x.shipment_number,
    boxNo: x.box_no,
    status: x.status,
    items: items.filter((i) => i.shipment_id === x.id).map((i) => ({ sku: i.sku, quantity: i.quantity })),
  }));
}

/** 梱包完了（全数一致必須。強制完了は権限 + 理由） */
export async function completePack(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  sessionId: string,
  userId: string,
  input: { requestId: string; force?: boolean; reason?: string; packageType?: string; weightG?: number },
  opts: { canForce: boolean; ttlMinutes: number; defaultCarrier?: string },
) {
  const { f, s, touch } = await lockSessionForPacker(tx, sessionId, userId, opts.ttlMinutes);
  if (s.status === 'completed') {
    if (s.complete_request_id === input.requestId) {
      return { duplicate: true, sessionId, fulfillmentId: f.id, forced: s.forced, shipments: await sessionShipments(tx, sessionId) };
    }
    throw conflict('SESSION_CLOSED', 'この梱包は既に完了しています');
  }
  await touch();
  assertPackable(f);
  const items = await loadItems(tx, f.id);
  assertFullyPicked(items);
  const unpacked = items.filter((i) => i.packed_qty < i.required_qty);
  let forced = false;
  if (unpacked.length) {
    const summary = unpacked.map((i) => `${i.sku} ${i.packed_qty}/${i.required_qty}`).join(', ');
    if (!input.force) {
      throw conflict('PACK_INCOMPLETE', `全数の検品が終わっていません（${summary}）`, {
        items: unpacked.map((i) => ({ sku: i.sku, packed: i.packed_qty, required: i.required_qty })),
      });
    }
    if (!opts.canForce) throw forbidden('強制完了の権限がありません（Owner / Operations Manager のみ）');
    const reason = input.reason?.trim();
    if (!reason) throw badRequest('REASON_REQUIRED', '強制完了の理由を入力してください');
    forced = true;
    for (const i of unpacked) {
      const fill = i.required_qty - i.packed_qty;
      await tx.one(
        `UPDATE fulfillment_items SET packed_qty = packed_qty + $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND packed_qty + $3 <= picked_qty RETURNING id`,
        [tx.orgId, i.id, fill],
      );
      await insertPackEvent(tx, {
        clientEventId: uuidv7(),
        session: s,
        fulfillmentItemId: i.id,
        productId: i.product_id,
        userId,
        type: 'force_complete',
        qty: fill,
        boxNo: s.current_box,
        message: `強制完了で未検品 ${fill} 個を梱包扱い: ${reason.slice(0, 200)}`,
      });
    }
    await tx.exec(`UPDATE pack_sessions SET forced = true, force_reason = $3, forced_by = $4 WHERE organization_id = $1 AND id = $2`, [
      tx.orgId,
      s.id,
      reason.slice(0, 300),
      userId,
    ]);
    const o = await tx.one(`SELECT order_number FROM orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, f.order_id]);
    await createException(tx, deps, {
      type: 'forced_pack',
      title: `強制完了: ${f.fulfillment_number}（${o.order_number}）未検品 ${unpacked.reduce((sum, i) => sum + i.required_qty - i.packed_qty, 0)} 個`,
      severity: 'high',
      dedupeKey: `forced_pack:${s.id}`,
      orderId: f.order_id,
      fulfillmentId: f.id,
      packSessionId: s.id,
      warehouseId: f.warehouse_id,
      detail: { items: unpacked.map((i) => ({ sku: i.sku, scanned: i.packed_qty, required: i.required_qty })), reason: reason.slice(0, 300) },
    });
  }
  // 箱ごとの内容（net）から下書き Shipment を作成
  const nets = (await netByItemBox(tx, s.id)).filter((n) => n.qty > 0);
  const byItem = new Map<string, number>();
  for (const n of nets) byItem.set(n.fulfillment_item_id, (byItem.get(n.fulfillment_item_id) ?? 0) + n.qty);
  for (const i of items) {
    if ((byItem.get(i.id) ?? 0) !== i.required_qty) {
      throw new AppError(500, 'PACK_INCONSISTENT', `梱包記録と数量が一致しません（${i.sku}）。管理者に連絡してください`);
    }
  }
  const boxes = [...new Set(nets.map((n) => n.box_no))].sort((a, b) => a - b);
  const numbers = await nextNumbers(deps.numberingPool, tx.orgId, 'shipment', boxes.length);
  const o = await tx.one(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, f.order_id]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const [idx, boxNo] of boxes.entries()) {
    const shipmentId = uuidv7();
    await tx.exec(
      `INSERT INTO shipments (organization_id, id, shipment_number, order_id, fulfillment_id, warehouse_id, pack_session_id, box_no, carrier, service,
                              status, ship_to, weight_g, package_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12, $13)`,
      [
        tx.orgId,
        shipmentId,
        numbers[idx],
        f.order_id,
        f.id,
        f.warehouse_id,
        s.id,
        boxNo,
        opts.defaultCarrier ?? null,
        f.shipping_method ?? o.shipping_method ?? null,
        JSON.stringify(shipToSnapshot(o)),
        boxes.length === 1 ? (input.weightG ?? null) : null,
        input.packageType ?? null,
      ],
    );
    for (const n of nets.filter((x) => x.box_no === boxNo)) {
      const it = itemById.get(n.fulfillment_item_id)!;
      await tx.exec(
        `INSERT INTO shipment_items (organization_id, id, shipment_id, order_item_id, fulfillment_item_id, product_id, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tx.orgId, uuidv7(), shipmentId, it.order_item_id, it.id, it.product_id, n.qty],
      );
    }
  }
  await tx.exec(
    `UPDATE pack_sessions SET status = 'completed', completed_at = now(), complete_request_id = $3, claim_expires_at = NULL WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, s.id, input.requestId],
  );
  await afterChange(tx, f, forced ? '梱包完了（強制）' : '梱包完了');
  await audit(tx, {
    action: forced ? 'pack.force_complete' : 'pack.complete',
    entityType: 'pack_session',
    entityId: s.id,
    summary: `${f.fulfillment_number} の梱包を完了（${boxes.length} 箱${forced ? '・強制完了' : ''}${s.mis_scan_count ? `・誤 scan ${s.mis_scan_count} 回` : ''}）`,
    metadata: { boxes: boxes.length, forced, misScans: s.mis_scan_count },
  });
  return { duplicate: false, sessionId, fulfillmentId: f.id, forced, shipments: await sessionShipments(tx, sessionId) };
}

/** 梱包セッションの中止（scan 済み数量を戻す。イベントは履歴として残る） */
export async function cancelPackSession(tx: Tx, sessionId: string, userId: string, input: { reason: string }, isManager: boolean) {
  const s0 = await tx.maybeOne(`SELECT fulfillment_id FROM pack_sessions WHERE organization_id = $1 AND id = $2`, [tx.orgId, sessionId]);
  if (!s0) throw notFound('梱包セッション');
  const f = await lockFulfillment(tx, s0.fulfillment_id);
  const s = await tx.one(`SELECT * FROM pack_sessions WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, sessionId]);
  if (s.status !== 'active') throw conflict('SESSION_CLOSED', 'この梱包セッションは完了または中止されています');
  const expired = s.claim_expires_at && new Date(s.claim_expires_at) < new Date();
  if (s.packer_user_id !== userId && !isManager && !expired) throw forbidden('他の作業者の梱包は中止できません');
  const nets = await netByItemBox(tx, s.id);
  const byItem = new Map<string, number>();
  for (const n of nets) byItem.set(n.fulfillment_item_id, (byItem.get(n.fulfillment_item_id) ?? 0) + n.qty);
  for (const [itemId, qty] of byItem) {
    if (qty <= 0) continue;
    await tx.one(
      `UPDATE fulfillment_items SET packed_qty = packed_qty - $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND packed_qty >= $3 RETURNING id`,
      [tx.orgId, itemId, qty],
    );
  }
  await tx.exec(
    `UPDATE pack_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, claim_expires_at = NULL WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, s.id, input.reason.slice(0, 300)],
  );
  await afterChange(tx, f, '梱包中止');
  await audit(tx, { action: 'pack.cancel', entityType: 'pack_session', entityId: s.id, summary: `${f.fulfillment_number} の梱包を中止`, metadata: { byManager: s.packer_user_id !== userId } });
  return { ok: true };
}

/** 梱包済み（未出荷）を取り消して再梱包できる状態へ戻す。下書き Shipment は取消 */
export async function unpackFulfillment(tx: Tx, fulfillmentId: string, input: { reason: string }) {
  const f = await lockFulfillment(tx, fulfillmentId);
  if (f.status !== 'packed') throw conflict('NOT_PACKED', '梱包済みの出荷作業ではありません');
  const shipped = await tx.one(`SELECT count(*)::int AS n FROM shipments WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'shipped'`, [tx.orgId, f.id]);
  if (shipped.n > 0) throw conflict('ALREADY_SHIPPED', '出荷確定済みの箱があるため梱包を取り消せません');
  const reason = `梱包取消: ${input.reason}`.slice(0, 300);
  await tx.exec(
    `UPDATE pack_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3 WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'completed'`,
    [tx.orgId, f.id, reason],
  );
  const drafts = await tx.many(
    `UPDATE shipments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
      WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'draft' RETURNING shipment_number`,
    [tx.orgId, f.id, reason],
  );
  await tx.exec(`UPDATE fulfillment_items SET packed_qty = 0, updated_at = now() WHERE organization_id = $1 AND fulfillment_id = $2`, [tx.orgId, f.id]);
  await afterChange(tx, f, '梱包取消');
  await audit(tx, {
    action: 'pack.unpack',
    entityType: 'fulfillment',
    entityId: f.id,
    summary: `${f.fulfillment_number} の梱包を取消（下書き荷物 ${drafts.length} 件を取消）`,
    metadata: { shipments: drafts.map((d) => d.shipment_number) },
  });
  return { ok: true, cancelledShipments: drafts.map((d) => d.shipment_number) };
}

/** Packing Station の表示用データ */
export async function packSessionView(tx: Tx, sessionId: string, opts: { showShipTo: boolean; canForce: boolean }) {
  const s = await tx.maybeOne(
    `SELECT s.*, u.name AS packer_name FROM pack_sessions s LEFT JOIN users u ON u.id = s.packer_user_id WHERE s.organization_id = $1 AND s.id = $2`,
    [tx.orgId, sessionId],
  );
  if (!s) throw notFound('梱包セッション');
  const f = await tx.one(
    `SELECT f.*, o.order_number, o.order_type, o.notes, o.recipient_name, o.postal_code, o.prefecture, o.city, o.address1, o.address2,
            c.name AS channel_name, w.code AS warehouse_code, wv.wave_number
       FROM fulfillments f
       JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
       JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
       JOIN warehouses w ON w.organization_id = f.organization_id AND w.id = f.warehouse_id
       LEFT JOIN waves wv ON wv.organization_id = f.organization_id AND wv.id = f.wave_id
      WHERE f.organization_id = $1 AND f.id = $2`,
    [tx.orgId, s.fulfillment_id],
  );
  const items = await loadItems(tx, f.id);
  const barcodes = await tx.many(`SELECT product_id, code FROM product_barcodes WHERE organization_id = $1 AND product_id = ANY($2) ORDER BY code`, [
    tx.orgId,
    items.map((i) => i.product_id).filter(Boolean),
  ]);
  const nets = await netByItemBox(tx, s.id);
  const events = await tx.many(
    `SELECT e.id, e.event_type, e.qty, e.box_no, e.scanned_code, e.message, e.created_at, e.fulfillment_item_id, p.sku
       FROM pack_events e LEFT JOIN products p ON p.organization_id = e.organization_id AND p.id = e.product_id
      WHERE e.organization_id = $1 AND e.pack_session_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT 40`,
    [tx.orgId, s.id],
  );
  const boxes = new Map<number, number>();
  for (const n of nets) boxes.set(n.box_no, (boxes.get(n.box_no) ?? 0) + n.qty);
  if (s.status === 'active' && !boxes.has(s.current_box)) boxes.set(s.current_box, 0);
  const view = {
    sessionId: s.id,
    status: s.status,
    packerUserId: s.packer_user_id,
    packerName: s.packer_name,
    claimExpiresAt: s.claim_expires_at,
    currentBox: s.current_box,
    misScanCount: s.mis_scan_count,
    forced: s.forced,
    startedAt: s.started_at,
    completedAt: s.completed_at,
    canForce: opts.canForce,
    fulfillment: {
      id: f.id,
      fulfillmentNumber: f.fulfillment_number,
      status: f.status,
      type: f.fulfillment_type,
      onHold: f.on_hold,
      holdReason: f.hold_reason,
      orderId: f.order_id,
      orderNumber: f.order_number,
      orderType: f.order_type,
      channelName: f.channel_name,
      warehouseCode: f.warehouse_code,
      waveNumber: f.wave_number,
      shippingMethod: f.shipping_method,
      notes: opts.showShipTo ? f.notes : undefined,
      shipTo: opts.showShipTo
        ? { name: f.recipient_name, postalCode: f.postal_code, prefecture: f.prefecture, city: f.city, address1: f.address1, address2: f.address2 }
        : undefined,
    },
    items: items.map((i) => ({
      fulfillmentItemId: i.id,
      productId: i.product_id,
      sku: i.sku,
      name: i.name,
      variant: i.variant,
      imageUrl: i.image_url,
      barcodes: barcodes.filter((b) => b.product_id === i.product_id).map((b) => b.code),
      required: i.required_qty,
      picked: i.picked_qty,
      packed: i.packed_qty,
      remaining: i.required_qty - i.packed_qty,
      byBox: Object.fromEntries(nets.filter((n) => n.fulfillment_item_id === i.id && n.qty !== 0).map((n) => [n.box_no, n.qty])),
    })),
    boxes: [...boxes.entries()].sort((a, b) => a[0] - b[0]).map(([boxNo, units]) => ({ boxNo, units })),
    allPacked: items.every((i) => i.packed_qty >= i.required_qty),
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      misScan: !!MIS_CODE[e.event_type],
      sku: e.sku,
      qty: e.qty,
      boxNo: e.box_no,
      code: e.scanned_code,
      message: e.message,
      at: e.created_at,
    })),
    shipments: s.status === 'completed' ? await sessionShipments(tx, s.id) : [],
  };
  return view;
}
