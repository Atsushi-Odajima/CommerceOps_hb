/**
 * 仕入先・発注（分納・発注残）・補充提案（StockPilot #013 から統合。DECISIONS.md ADR-040）
 *
 * 数量: Q=発注数量, R=入荷済み, C=未入荷打切り, 発注残 O = Q − R − C（発注済みのみ。下書きは含めない）
 * 補充: P = U + O − D
 *   U = 販売可能ロケーション（kind='pick'・有効）の引当可能数（on_hand − allocated − held）の合計
 *   O = 販売可能ロケーションへ入る発注残
 *   D = 引当待ちの注文の未引当数量（EC の受注残。StockPilot には無い概念）
 *   P ≦ 発注点 なら 必要数 = max(0, 目標 − P)、必要数 > 0 なら 推奨 = ceil(max(必要数, 最小発注数量) ÷ 発注単位) × 発注単位
 *   安全在庫割れ = U < 安全在庫（入荷予定があっても手元不足を隠さない）
 */
import type { Pool } from '../../db/pool.js';
import type { Tx } from '../../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { receiveStock, specialLocation } from '../inventory/service.js';

export type PoDisplayStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'closed_short' | 'closed' | 'cancelled';

export const PO_STATUS_LABELS: Record<PoDisplayStatus, string> = {
  draft: '下書き',
  ordered: '発注済み',
  partial: '一部入荷',
  received: '入荷完了',
  closed_short: '残数打切り完了',
  closed: '打切り',
  cancelled: '取消',
};

export function poDisplayStatus(status: string, lines: { ordered_qty: number; received_qty: number; closed_qty: number }[]): PoDisplayStatus {
  if (status === 'draft') return 'draft';
  if (status === 'cancelled') return 'cancelled';
  const q = lines.reduce((a, l) => a + l.ordered_qty, 0);
  const r = lines.reduce((a, l) => a + l.received_qty, 0);
  const c = lines.reduce((a, l) => a + l.closed_qty, 0);
  const o = q - r - c;
  if (o > 0) return r > 0 ? 'partial' : 'ordered';
  if (c === 0) return 'received';
  return r > 0 ? 'closed_short' : 'closed';
}

/** 補充の推奨数量（純関数。StockPilot computeReplenishment と同じ式） */
export function recommendQty(s: { reorderPoint: number; targetStock: number; minOrderQty: number; orderMultiple: number }, p: number): number {
  if (p > s.reorderPoint) return 0;
  const need = Math.max(0, s.targetStock - p);
  if (need <= 0) return 0;
  return Math.ceil(Math.max(need, s.minOrderQty) / s.orderMultiple) * s.orderMultiple;
}

// ---------------------------------------------------------------- 仕入先

export interface SupplierInput {
  code: string;
  name: string;
  contact?: string | null;
  leadTimeDays?: number | null;
  note?: string | null;
  active?: boolean;
}

export async function createSupplier(tx: Tx, input: SupplierInput) {
  const dup = await tx.maybeOne(`SELECT id FROM suppliers WHERE organization_id = $1 AND code = $2`, [tx.orgId, input.code]);
  if (dup) throw conflict('DUPLICATE_CODE', `仕入先コード ${input.code} はすでに使われています`);
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO suppliers (organization_id, id, code, name, contact, lead_time_days, note, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tx.orgId, id, input.code, input.name, input.contact ?? null, input.leadTimeDays ?? null, input.note ?? null, input.active ?? true],
  );
  return id;
}

export async function updateSupplier(tx: Tx, id: string, input: SupplierInput) {
  const dup = await tx.maybeOne(`SELECT id FROM suppliers WHERE organization_id = $1 AND code = $2 AND id <> $3`, [tx.orgId, input.code, id]);
  if (dup) throw conflict('DUPLICATE_CODE', `仕入先コード ${input.code} はすでに使われています`);
  const n = await tx.exec(
    `UPDATE suppliers SET code=$3, name=$4, contact=$5, lead_time_days=$6, note=$7, active=$8, updated_at=now() WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, id, input.code, input.name, input.contact ?? null, input.leadTimeDays ?? null, input.note ?? null, input.active ?? true],
  );
  if (n === 0) throw notFound('仕入先');
}

// ---------------------------------------------------------------- 発注

export interface PoLineInput {
  productId: string;
  locationId?: string | null;
  qty: number;
  basisP?: number | null;
}

async function resolveLines(tx: Tx, warehouseId: string, lines: PoLineInput[]) {
  if (lines.length === 0) throw badRequest('NO_LINES', '明細を1行以上入力してください');
  if (lines.length > 200) throw badRequest('TOO_MANY_LINES', '明細は200行までです');
  const def = await specialLocation(tx, warehouseId, 'pick');
  const out: { productId: string; locationId: string; qty: number; basisP: number | null }[] = [];
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1_000_000) throw badRequest('INVALID_QTY', '数量は1〜1,000,000の整数にしてください');
    const p = await tx.maybeOne(`SELECT id FROM products WHERE organization_id = $1 AND id = $2`, [tx.orgId, l.productId]);
    if (!p) throw notFound('商品');
    const locationId = l.locationId ?? def;
    const loc = await tx.maybeOne(`SELECT id FROM locations WHERE organization_id = $1 AND id = $2 AND warehouse_id = $3 AND active`, [
      tx.orgId,
      locationId,
      warehouseId,
    ]);
    if (!loc) throw badRequest('INVALID_LOCATION', '入荷先のロケーションは発注先の倉庫の有効なロケーションにしてください');
    out.push({ productId: l.productId, locationId, qty: l.qty, basisP: l.basisP ?? null });
  }
  return out;
}

async function insertLines(tx: Tx, poId: string, warehouseId: string, lines: Awaited<ReturnType<typeof resolveLines>>) {
  for (const [i, l] of lines.entries()) {
    await tx.exec(
      `INSERT INTO purchase_order_lines (organization_id, id, purchase_order_id, line_no, product_id, warehouse_id, location_id, ordered_qty, basis_p)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tx.orgId, uuidv7(), poId, i + 1, l.productId, warehouseId, l.locationId, l.qty, l.basisP],
    );
  }
}

export async function createDraft(
  tx: Tx,
  numberingPool: Pool,
  input: { supplierId: string; warehouseId: string; expectedDate?: string | null; note?: string | null; lines: PoLineInput[] },
) {
  const sup = await tx.maybeOne(`SELECT id, active FROM suppliers WHERE organization_id = $1 AND id = $2`, [tx.orgId, input.supplierId]);
  if (!sup) throw notFound('仕入先');
  const wh = await tx.maybeOne(`SELECT id FROM warehouses WHERE organization_id = $1 AND id = $2`, [tx.orgId, input.warehouseId]);
  if (!wh) throw notFound('倉庫');
  const lines = await resolveLines(tx, input.warehouseId, input.lines);
  const [no] = await nextNumbers(numberingPool, tx.orgId, 'purchase_order');
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO purchase_orders (organization_id, id, po_number, supplier_id, warehouse_id, status, expected_date, note, created_by)
     VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8)`,
    [tx.orgId, id, no, input.supplierId, input.warehouseId, input.expectedDate ?? null, input.note ?? null, tx.actor.userId],
  );
  await insertLines(tx, id, input.warehouseId, lines);
  return { id, poNumber: no };
}

async function lockPo(tx: Tx, id: string) {
  const po = await tx.maybeOne<{ id: string; status: string; warehouse_id: string; po_number: string }>(
    `SELECT id, status, warehouse_id, po_number FROM purchase_orders WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [tx.orgId, id],
  );
  if (!po) throw notFound('発注');
  return po;
}

export async function updateDraft(tx: Tx, id: string, input: { expectedDate?: string | null; note?: string | null; lines: PoLineInput[] }) {
  const po = await lockPo(tx, id);
  if (po.status !== 'draft') throw conflict('INVALID_STATE', '下書きの発注のみ編集できます');
  const lines = await resolveLines(tx, po.warehouse_id, input.lines);
  await tx.exec(`DELETE FROM purchase_order_lines WHERE organization_id = $1 AND purchase_order_id = $2`, [tx.orgId, id]);
  await insertLines(tx, id, po.warehouse_id, lines);
  await tx.exec(`UPDATE purchase_orders SET expected_date = $3, note = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    id,
    input.expectedDate ?? null,
    input.note ?? null,
  ]);
}

/** 「発注済みにする」= 利用者が実際に発注したことの記録。以後は発注残に入る */
export async function placeOrder(tx: Tx, id: string) {
  const po = await lockPo(tx, id);
  if (po.status !== 'draft') throw conflict('INVALID_STATE', '下書きの発注のみ発注済みにできます');
  const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_order_lines WHERE organization_id = $1 AND purchase_order_id = $2`, [tx.orgId, id]);
  if (n.n === 0) throw badRequest('NO_LINES', '明細がありません');
  await tx.exec(`UPDATE purchase_orders SET status = 'placed', placed_at = now(), updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
}

/** 取消: 下書き、または1個も入荷していない発注のみ */
export async function cancelOrder(tx: Tx, id: string) {
  const po = await lockPo(tx, id);
  if (po.status === 'cancelled') return;
  const r = await tx.one<{ r: number }>(
    `SELECT COALESCE(SUM(received_qty), 0)::int AS r FROM purchase_order_lines WHERE organization_id = $1 AND purchase_order_id = $2`,
    [tx.orgId, id],
  );
  if (r.r > 0) throw conflict('ALREADY_RECEIVED', '入荷済みの明細がある発注は取り消せません。残りは「未入荷分を打ち切る」で締めてください');
  await tx.exec(`UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    id,
  ]);
}

interface LineRow {
  id: string;
  line_no: number;
  product_id: string;
  location_id: string;
  ordered_qty: number;
  received_qty: number;
  closed_qty: number;
}

/**
 * 発注入荷（分納可）。1回で複数明細・明細ごとに入荷先ロケーションを変えられる。
 * 合計が発注残を超えると OVER_RECEIPT（在庫・発注とも変えない）。同じ requestId の再送は1回だけ反映。
 */
export async function receivePo(
  tx: Tx,
  id: string,
  input: { requestId: string; lines: { lineId: string; qty: number; locationId?: string | null }[]; note?: string | null },
) {
  const po = await lockPo(tx, id);
  if (po.status !== 'placed') throw conflict('INVALID_STATE', '発注済みの発注のみ入荷できます');
  if (input.lines.length === 0) throw badRequest('NO_LINES', '入荷する明細を入力してください');
  // 再送の検出（入荷 movement は requestId 単位の冪等キーを持つ）
  // 1行目（i=0）の冪等キーで判定する（一意索引で引ける）
  const replay = await tx.maybeOne(`SELECT id FROM inventory_movements WHERE organization_id = $1 AND idempotency_key = $2`, [
    tx.orgId,
    `po_receipt:${input.requestId}:0`,
  ]);
  if (replay) return { applied: false };
  const lines = await tx.many<LineRow>(
    `SELECT id, line_no, product_id, location_id, ordered_qty, received_qty, closed_qty FROM purchase_order_lines
      WHERE organization_id = $1 AND purchase_order_id = $2 ORDER BY id FOR UPDATE`,
    [tx.orgId, id],
  );
  const byId = new Map(lines.map((l) => [l.id, l]));
  const totals = new Map<string, number>();
  for (const r of input.lines) {
    const l = byId.get(r.lineId);
    if (!l) throw notFound('発注明細');
    if (!Number.isInteger(r.qty) || r.qty < 1) throw badRequest('INVALID_QTY', '入荷数量は1以上の整数にしてください');
    totals.set(r.lineId, (totals.get(r.lineId) ?? 0) + r.qty);
  }
  for (const [lineId, qty] of totals) {
    const l = byId.get(lineId)!;
    const open = l.ordered_qty - l.received_qty - l.closed_qty;
    if (qty > open) throw conflict('OVER_RECEIPT', `明細${l.line_no}の入荷数量（${qty}）が発注残（${open}）を超えています`, { lineNo: l.line_no, open, qty });
  }
  for (const [i, r] of input.lines.entries()) {
    const l = byId.get(r.lineId)!;
    const locationId = r.locationId ?? l.location_id;
    const loc = await tx.maybeOne(`SELECT id FROM locations WHERE organization_id = $1 AND id = $2 AND warehouse_id = $3`, [tx.orgId, locationId, po.warehouse_id]);
    if (!loc) throw badRequest('INVALID_LOCATION', '入荷先は発注先の倉庫のロケーションにしてください');
    await receiveStock(tx, {
      locationId,
      productId: l.product_id,
      qty: r.qty,
      reason: `発注入荷 ${po.po_number}${input.note ? ` ${input.note}` : ''}`,
      referenceType: 'po_line',
      referenceId: l.id,
      idempotencyKey: `po_receipt:${input.requestId}:${i}`,
    });
  }
  for (const [lineId, qty] of totals) {
    await tx.exec(`UPDATE purchase_order_lines SET received_qty = received_qty + $3 WHERE organization_id = $1 AND id = $2`, [tx.orgId, lineId, qty]);
  }
  await tx.exec(`UPDATE purchase_orders SET updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
  return { applied: true };
}

/** 未入荷分の打切り（理由必須）。lineIds 省略時はすべての明細 */
export async function closeRemaining(tx: Tx, id: string, input: { reason: string; lineIds?: string[] }) {
  const po = await lockPo(tx, id);
  if (po.status !== 'placed') throw conflict('INVALID_STATE', '発注済みの発注のみ打ち切れます');
  const n = await tx.exec(
    `UPDATE purchase_order_lines SET closed_qty = ordered_qty - received_qty, close_reason = $3
      WHERE organization_id = $1 AND purchase_order_id = $2 AND ordered_qty - received_qty - closed_qty > 0
        AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))`,
    [tx.orgId, id, input.reason, input.lineIds ?? null],
  );
  await tx.exec(`UPDATE purchase_orders SET updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
  return { closedLines: n };
}

export async function loadPo(tx: Tx, id: string) {
  const po = await tx.maybeOne(
    `SELECT po.*, s.code AS supplier_code, s.name AS supplier_name, w.code AS warehouse_code
       FROM purchase_orders po
       JOIN suppliers s ON s.organization_id = po.organization_id AND s.id = po.supplier_id
       JOIN warehouses w ON w.organization_id = po.organization_id AND w.id = po.warehouse_id
      WHERE po.organization_id = $1 AND po.id = $2`,
    [tx.orgId, id],
  );
  if (!po) throw notFound('発注');
  const lines = await tx.many(
    `SELECT pl.*, p.sku, p.name AS product_name, l.code AS location_code
       FROM purchase_order_lines pl
       JOIN products p ON p.organization_id = pl.organization_id AND p.id = pl.product_id
       JOIN locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id
      WHERE pl.organization_id = $1 AND pl.purchase_order_id = $2 ORDER BY pl.line_no`,
    [tx.orgId, id],
  );
  const display = poDisplayStatus(po.status, lines as LineRow[]);
  return {
    id: po.id,
    poNumber: po.po_number,
    status: po.status,
    displayStatus: display,
    displayStatusLabel: PO_STATUS_LABELS[display],
    supplier: { id: po.supplier_id, code: po.supplier_code, name: po.supplier_name },
    warehouseId: po.warehouse_id,
    warehouseCode: po.warehouse_code,
    expectedDate: po.expected_date ? toDateStr(po.expected_date) : null,
    note: po.note,
    placedAt: po.placed_at,
    cancelledAt: po.cancelled_at,
    createdAt: po.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      productId: l.product_id,
      sku: l.sku,
      productName: l.product_name,
      locationId: l.location_id,
      locationCode: l.location_code,
      orderedQty: l.ordered_qty,
      receivedQty: l.received_qty,
      closedQty: l.closed_qty,
      openQty: po.status === 'placed' ? l.ordered_qty - l.received_qty - l.closed_qty : 0,
      closeReason: l.close_reason,
    })),
  };
}

function toDateStr(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // DATE 列は pg がローカル 0 時の Date にする。ローカル日付で文字列化
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 補充

export interface ReplenishmentSettings {
  supplierId: string | null;
  safetyStock: number;
  reorderPoint: number;
  targetStock: number;
  orderMultiple: number;
  minOrderQty: number;
  leadTimeDays: number | null;
}

/** 補充設定の保存。null で削除（補充設定なし = 提案しない） */
export async function saveReplenishment(tx: Tx, productId: string, s: ReplenishmentSettings | null) {
  const p = await tx.maybeOne(`SELECT id FROM products WHERE organization_id = $1 AND id = $2`, [tx.orgId, productId]);
  if (!p) throw notFound('商品');
  if (!s) {
    await tx.exec(`DELETE FROM product_replenishment WHERE organization_id = $1 AND product_id = $2`, [tx.orgId, productId]);
    return;
  }
  if (!(s.safetyStock <= s.reorderPoint && s.reorderPoint < s.targetStock)) {
    throw badRequest('INVALID_SETTINGS', '安全在庫 ≦ 発注点 ＜ 目標在庫 になるように入力してください');
  }
  if (s.supplierId) {
    const sup = await tx.maybeOne(`SELECT id FROM suppliers WHERE organization_id = $1 AND id = $2`, [tx.orgId, s.supplierId]);
    if (!sup) throw notFound('仕入先');
  }
  await tx.exec(
    `INSERT INTO product_replenishment (organization_id, id, product_id, supplier_id, safety_stock, reorder_point, target_stock, order_multiple, min_order_qty, lead_time_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (organization_id, product_id) DO UPDATE SET supplier_id = EXCLUDED.supplier_id, safety_stock = EXCLUDED.safety_stock,
       reorder_point = EXCLUDED.reorder_point, target_stock = EXCLUDED.target_stock, order_multiple = EXCLUDED.order_multiple,
       min_order_qty = EXCLUDED.min_order_qty, lead_time_days = EXCLUDED.lead_time_days, updated_at = now()`,
    [tx.orgId, uuidv7(), productId, s.supplierId, s.safetyStock, s.reorderPoint, s.targetStock, s.orderMultiple, s.minOrderQty, s.leadTimeDays],
  );
}

export interface Suggestion {
  productId: string;
  sku: string;
  name: string;
  supplierId: string | null;
  supplierName: string | null;
  usable: number;
  openPo: number;
  overduePo: number;
  demand: number;
  p: number;
  safetyStock: number;
  reorderPoint: number;
  targetStock: number;
  orderMultiple: number;
  minOrderQty: number;
  leadTimeDays: number | null;
  recommended: number;
  belowSafety: boolean;
  suggestedDate: string;
}

/** 補充設定のある商品の補充判断。productIds 指定時はその商品だけ（下書き作成時の再計算に使う） */
export async function computeSuggestions(tx: Tx, opts: { productIds?: string[]; onlyActionable?: boolean } = {}): Promise<Suggestion[]> {
  const rows = await tx.many(
    `WITH settings AS (
       SELECT r.*, p.sku, p.name, s.name AS supplier_name, s.lead_time_days AS supplier_lead
         FROM product_replenishment r
         JOIN products p ON p.organization_id = r.organization_id AND p.id = r.product_id
         LEFT JOIN suppliers s ON s.organization_id = r.organization_id AND s.id = r.supplier_id
        WHERE r.organization_id = $1 AND p.active AND ($2::uuid[] IS NULL OR r.product_id = ANY($2::uuid[]))
     ),
     usable AS (
       SELECT ib.product_id, SUM(ib.on_hand - ib.allocated - ib.held)::int AS qty
         FROM inventory_balances ib JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
        WHERE ib.organization_id = $1 AND l.kind = 'pick' AND l.active AND ib.product_id IN (SELECT product_id FROM settings)
        GROUP BY ib.product_id
     ),
     open_po AS (
       SELECT pl.product_id,
              SUM(pl.ordered_qty - pl.received_qty - pl.closed_qty)::int AS qty,
              SUM(pl.ordered_qty - pl.received_qty - pl.closed_qty) FILTER (WHERE po.expected_date < $3::date)::int AS overdue
         FROM purchase_order_lines pl
         JOIN purchase_orders po ON po.organization_id = pl.organization_id AND po.id = pl.purchase_order_id
         JOIN locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id
        WHERE pl.organization_id = $1 AND po.status = 'placed' AND l.kind = 'pick' AND pl.product_id IN (SELECT product_id FROM settings)
        GROUP BY pl.product_id
     ),
     demand AS (
       SELECT oi.product_id, SUM(oi.quantity - oi.cancelled_qty - oi.shipped_qty - oi.allocated_qty)::int AS qty
         FROM orders o JOIN order_items oi ON oi.organization_id = o.organization_id AND oi.order_id = o.id
        WHERE o.organization_id = $1 AND o.status IN ('ready_for_allocation', 'partially_allocated', 'partially_shipped')
          AND oi.product_id IN (SELECT product_id FROM settings)
        GROUP BY oi.product_id
     )
     SELECT st.*, COALESCE(u.qty, 0) AS usable, COALESCE(op.qty, 0) AS open_po, COALESCE(op.overdue, 0) AS overdue_po, GREATEST(COALESCE(d.qty, 0), 0) AS demand
       FROM settings st
       LEFT JOIN usable u ON u.product_id = st.product_id
       LEFT JOIN open_po op ON op.product_id = st.product_id
       LEFT JOIN demand d ON d.product_id = st.product_id
      ORDER BY st.sku`,
    [tx.orgId, opts.productIds ?? null, await todayOf(tx)],
  );
  const today = await todayOf(tx);
  const out = rows.map((r): Suggestion => {
    const p = r.usable + r.open_po - r.demand;
    const lead = r.lead_time_days ?? r.supplier_lead ?? null;
    const recommended = recommendQty({ reorderPoint: r.reorder_point, targetStock: r.target_stock, minOrderQty: r.min_order_qty, orderMultiple: r.order_multiple }, p);
    return {
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      usable: r.usable,
      openPo: r.open_po,
      overduePo: r.overdue_po,
      demand: r.demand,
      p,
      safetyStock: r.safety_stock,
      reorderPoint: r.reorder_point,
      targetStock: r.target_stock,
      orderMultiple: r.order_multiple,
      minOrderQty: r.min_order_qty,
      leadTimeDays: lead,
      recommended,
      belowSafety: r.usable < r.safety_stock,
      suggestedDate: addDays(today, lead ?? 0),
    };
  });
  return opts.onlyActionable ? out.filter((s) => s.recommended > 0 || s.belowSafety || s.overduePo > 0) : out;
}

async function todayOf(tx: Tx): Promise<string> {
  const r = await tx.one<{ d: string }>(`SELECT to_char((now() AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS d FROM organizations o WHERE o.id = $1`, [tx.orgId]);
  return r.d;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 補充候補から発注の下書きを作る（仕入先ごとに1件）。
 * 作成時に P を再計算し、画面表示時（basisP）と違えば BASIS_CHANGED（最新の値を確認してからやり直す）。
 */
export async function createDraftsFromSuggestions(
  tx: Tx,
  numberingPool: Pool,
  input: { warehouseId: string; items: { productId: string; qty: number; basisP: number }[] },
) {
  if (input.items.length === 0) throw badRequest('NO_LINES', '発注する商品を選んでください');
  const current = await computeSuggestions(tx, { productIds: input.items.map((i) => i.productId) });
  const byProduct = new Map(current.map((s) => [s.productId, s]));
  const changed = input.items.filter((i) => byProduct.get(i.productId)?.p !== i.basisP);
  if (changed.length > 0) {
    throw new AppError(409, 'BASIS_CHANGED', '在庫や発注残が変わりました。最新の補充候補を確認してからもう一度作成してください', {
      changed: changed.map((c) => ({ productId: c.productId, before: c.basisP, now: byProduct.get(c.productId)?.p ?? null })),
    });
  }
  const noSupplier = input.items.filter((i) => !byProduct.get(i.productId)?.supplierId);
  if (noSupplier.length > 0) throw badRequest('NO_SUPPLIER', '仕入先が設定されていない商品があります（補充設定で仕入先を選んでください）');
  const groups = new Map<string, { productId: string; qty: number; basisP: number }[]>();
  for (const i of input.items) {
    const sup = byProduct.get(i.productId)!.supplierId!;
    groups.set(sup, [...(groups.get(sup) ?? []), i]);
  }
  const created: { id: string; poNumber: string; supplierId: string }[] = [];
  for (const [supplierId, items] of groups) {
    const lead = Math.max(...items.map((i) => byProduct.get(i.productId)!.leadTimeDays ?? 0));
    const r = await createDraft(tx, numberingPool, {
      supplierId,
      warehouseId: input.warehouseId,
      expectedDate: addDays(await todayOf(tx), lead),
      note: '補充候補から作成',
      lines: items.map((i) => ({ productId: i.productId, qty: i.qty, basisP: i.basisP })),
    });
    created.push({ ...r, supplierId });
  }
  return created;
}
