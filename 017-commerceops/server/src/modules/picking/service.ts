/**
 * スマホ Pick（docs/PICK_PACK_RULES.md）
 * - 1 Task = 1 active assignee（条件付き UPDATE の claim、TTL、timeout）
 * - scan は client_event_id で冪等。誤 Location / 誤 SKU / 数量過多は数量を加算せずイベントとして記録
 * - Short Pick: 在庫は on_hand を減らさず held へ、引当の該当分を解放、例外を作成（注文はキャンセルしない）
 * - 訂正は負数イベント（上書きしない）
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { withTenant } from '../../db/tx.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import { createException } from '../exceptions/service.js';
import { applyMovement } from '../inventory/service.js';
import { resolveProductByCode } from '../products/routes.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { refreshFulfillmentStatus, refreshWaveStatus } from '../fulfillment/status.js';
import { refreshAllocationStatus } from '../allocation/engine.js';

export type InputMethod = 'camera' | 'scanner' | 'manual';

export interface ScanResult {
  ok: boolean;
  duplicate?: boolean;
  code?: string;
  message?: string;
  picked?: number;
  group?: { required: number; picked: number; short: number; remaining: number };
  taskCompleted?: boolean;
  expected?: Record<string, unknown>;
}

const MIS_SCAN_CODE: Record<string, string> = {
  mis_scan_location: 'WRONG_LOCATION',
  mis_scan_sku: 'WRONG_SKU',
  over_pick: 'OVER_PICK',
};

async function lockTaskForPicker(tx: Tx, taskId: string, userId: string, ttlMinutes: number, allowCompleted = false) {
  const t = await tx.maybeOne(`SELECT * FROM pick_tasks WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, taskId]);
  if (!t) throw notFound('Pick タスク');
  const allowed = allowCompleted ? ['open', 'in_progress', 'completed'] : ['open', 'in_progress'];
  if (!allowed.includes(t.status)) throw conflict('TASK_CLOSED', 'このタスクは完了または取消されています');
  const expired = t.claim_expires_at && new Date(t.claim_expires_at) < new Date();
  if (t.assignee_user_id && t.assignee_user_id !== userId && !expired) {
    throw conflict('NOT_ASSIGNED', 'このタスクは別の作業者が担当しています（再接続時の再検証で拒否しました）');
  }
  if (t.assignee_user_id !== userId) {
    // 未担当 or 期限切れ → この作業者が引き継ぐ
    await tx.exec(`UPDATE pick_tasks SET assignee_user_id = $3, claimed_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, taskId, userId]);
  }
  await tx.exec(
    `UPDATE pick_tasks SET claim_expires_at = now() + make_interval(mins => $3), updated_at = now() WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, taskId, ttlMinutes],
  );
  return t;
}

/**
 * 同じ clientEventId の再送が同時に届いた場合: 先にタスクの行ロックを取ってから冪等チェックをやり直す。
 * ロック待ちの間に先の要求が確定していれば、その結果をそのまま返す（後着を誤 scan・完了済みエラーとして扱わない）。
 */
async function lockTaskAndCheckResend(tx: Tx, taskId: string, clientEventId: string): Promise<ScanResult | null> {
  await tx.maybeOne(`SELECT id FROM pick_tasks WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, taskId]);
  return previousResult(tx, clientEventId);
}

async function previousResult(tx: Tx, clientEventId: string): Promise<ScanResult | null> {
  const prev = await tx.many(`SELECT event_type, qty, note FROM pick_events WHERE organization_id = $1 AND client_event_id = $2`, [tx.orgId, clientEventId]);
  if (!prev.length) return null;
  const mis = prev.find((e) => MIS_SCAN_CODE[e.event_type]);
  if (mis) return { ok: false, duplicate: true, code: MIS_SCAN_CODE[mis.event_type], message: mis.note ?? '前回と同じ scan です' };
  return { ok: true, duplicate: true, picked: prev.reduce((s, e) => s + (e.event_type === 'pick' ? e.qty : 0), 0) };
}

async function insertEvent(
  tx: Tx,
  e: {
    clientEventId: string;
    task: any;
    lineId?: string | null;
    fulfillmentId?: string | null;
    locationId?: string | null;
    productId?: string | null;
    userId: string;
    type: string;
    qty?: number;
    code?: string | null;
    reason?: string | null;
    note?: string | null;
    correctsEventId?: string | null;
    inputMethod?: InputMethod | null;
    offline?: boolean;
    clientCreatedAt?: string | null;
  },
) {
  await tx.exec(
    `INSERT INTO pick_events (organization_id, id, client_event_id, pick_task_id, pick_task_line_id, wave_id, fulfillment_id, warehouse_id, location_id,
                              product_id, picker_user_id, event_type, qty, scanned_code, reason_code, note, corrects_event_id, input_method, offline, client_created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      tx.orgId,
      uuidv7(),
      e.clientEventId,
      e.task.id,
      e.lineId ?? null,
      e.task.wave_id,
      e.fulfillmentId ?? null,
      e.task.warehouse_id,
      e.locationId ?? null,
      e.productId ?? null,
      e.userId,
      e.type,
      e.qty ?? 0,
      e.code?.slice(0, 128) ?? null,
      e.reason ?? null,
      e.note?.slice(0, 300) ?? null,
      e.correctsEventId ?? null,
      e.inputMethod ?? null,
      e.offline ?? false,
      e.clientCreatedAt ?? null,
    ],
  );
}

async function afterProgress(tx: Tx, task: any, fulfillmentIds: Set<string>, reason: string): Promise<boolean> {
  const open = await tx.one(`SELECT count(*)::int AS n FROM pick_task_lines WHERE organization_id = $1 AND pick_task_id = $2 AND status = 'open'`, [tx.orgId, task.id]);
  const completed = open.n === 0;
  await tx.exec(
    `UPDATE pick_tasks SET status = $3, started_at = COALESCE(started_at, now()),
            completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE NULL END,
            claim_expires_at = CASE WHEN $3 = 'completed' THEN NULL ELSE claim_expires_at END, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, task.id, completed ? 'completed' : 'in_progress'],
  );
  // ロックは ID 順（同じ Fulfillment・注文の明細が複数タスクに分かれていても、取引ごとにロック順が逆にならずデッドロックしない）
  const orders = new Set<string>();
  for (const fid of [...fulfillmentIds].sort()) {
    await refreshFulfillmentStatus(tx, fid);
    const f = await tx.one(`SELECT order_id FROM fulfillments WHERE organization_id = $1 AND id = $2`, [tx.orgId, fid]);
    orders.add(f.order_id);
  }
  for (const oid of [...orders].sort()) await recomputeOrderStatus(tx, oid, reason);
  await refreshWaveStatus(tx, task.wave_id);
  return completed;
}

export async function claimTask(tx: Tx, taskId: string, userId: string, ttlMinutes: number, force = false) {
  const r = await tx.maybeOne(
    `UPDATE pick_tasks SET assignee_user_id = $3, claimed_at = now(), claim_expires_at = now() + make_interval(mins => $4), updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND status IN ('open', 'in_progress')
        AND (assignee_user_id IS NULL OR assignee_user_id = $3 OR claim_expires_at < now() OR $5)
      RETURNING *`,
    [tx.orgId, taskId, userId, ttlMinutes, force],
  );
  if (!r) {
    const t = await tx.maybeOne(
      `SELECT t.status, u.name AS assignee_name FROM pick_tasks t LEFT JOIN users u ON u.id = t.assignee_user_id WHERE t.organization_id = $1 AND t.id = $2`,
      [tx.orgId, taskId],
    );
    if (!t) throw notFound('Pick タスク');
    if (!['open', 'in_progress'].includes(t.status)) throw conflict('TASK_CLOSED', 'このタスクは完了または取消されています');
    throw conflict('ALREADY_CLAIMED', `このタスクは ${t.assignee_name ?? '他の作業者'} が担当中です`);
  }
  await audit(tx, { action: force ? 'pick_task.assign' : 'pick_task.claim', entityType: 'pick_task', entityId: taskId, summary: `${r.task_number} を担当`, metadata: { assignee: userId } });
  return r;
}

export async function releaseTask(tx: Tx, taskId: string, userId: string, isManager: boolean) {
  const t = await tx.maybeOne(`SELECT * FROM pick_tasks WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, taskId]);
  if (!t) throw notFound('Pick タスク');
  if (t.assignee_user_id && t.assignee_user_id !== userId && !isManager) throw conflict('NOT_ASSIGNED', '自分が担当しているタスクのみ解除できます');
  await tx.exec(`UPDATE pick_tasks SET assignee_user_id = NULL, claim_expires_at = NULL, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, taskId]);
  await audit(tx, { action: 'pick_task.release', entityType: 'pick_task', entityId: taskId, summary: `${t.task_number} の担当を解除（進捗は保持）` });
}

/** Picker 用のタスク表示（個人情報なし: 注文番号/Fulfillment 番号のみ） */
export async function taskView(tx: Tx, taskId: string) {
  const t = await tx.maybeOne(
    `SELECT t.*, w.wave_number, w.label AS wave_label, wh.code AS warehouse_code, u.name AS assignee_name
       FROM pick_tasks t JOIN waves w ON w.organization_id = t.organization_id AND w.id = t.wave_id
       JOIN warehouses wh ON wh.organization_id = t.organization_id AND wh.id = t.warehouse_id
       LEFT JOIN users u ON u.id = t.assignee_user_id
      WHERE t.organization_id = $1 AND t.id = $2`,
    [tx.orgId, taskId],
  );
  if (!t) throw notFound('Pick タスク');
  const lines = await tx.many(
    `SELECT l.*, loc.code AS location_code, loc.barcode AS location_barcode, loc.zone, loc.pick_sequence,
            p.sku, p.name, p.variant, p.image_url, f.fulfillment_number,
            (SELECT COALESCE(array_agg(b.code ORDER BY b.code), '{}') FROM product_barcodes b WHERE b.organization_id = p.organization_id AND b.product_id = p.id) AS barcodes
       FROM pick_task_lines l
       JOIN locations loc ON loc.organization_id = l.organization_id AND loc.id = l.location_id
       JOIN products p ON p.organization_id = l.organization_id AND p.id = l.product_id
       JOIN fulfillments f ON f.organization_id = l.organization_id AND f.id = l.fulfillment_id
      WHERE l.organization_id = $1 AND l.pick_task_id = $2 AND l.status <> 'cancelled'
      ORDER BY l.seq`,
    [tx.orgId, taskId],
  );
  const groups: any[] = [];
  const byKey = new Map<string, any>();
  for (const l of lines) {
    const key = `${l.location_id}:${l.product_id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        locationId: l.location_id,
        locationCode: l.location_code,
        locationBarcode: l.location_barcode,
        zone: l.zone,
        productId: l.product_id,
        sku: l.sku,
        name: l.name,
        variant: l.variant,
        imageUrl: l.image_url,
        barcodes: [l.sku, ...l.barcodes],
        required: 0,
        picked: 0,
        short: 0,
        fulfillments: [] as { number: string; qty: number }[],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.required += l.required_qty;
    g.picked += l.picked_qty;
    g.short += l.short_qty;
    g.fulfillments.push({ number: l.fulfillment_number, qty: l.required_qty });
  }
  for (const g of groups) {
    g.remaining = g.required - g.picked - g.short;
    g.status = g.remaining > 0 ? 'open' : g.short > 0 ? 'short' : 'done';
  }
  const events = await tx.many(
    `SELECT e.id, e.event_type, e.qty, e.created_at, e.reason_code, p.sku, loc.code AS location_code,
            (SELECT COALESCE(SUM(c.qty), 0)::int FROM pick_events c WHERE c.organization_id = e.organization_id AND c.corrects_event_id = e.id) AS corrected
       FROM pick_events e LEFT JOIN products p ON p.organization_id = e.organization_id AND p.id = e.product_id
       LEFT JOIN locations loc ON loc.organization_id = e.organization_id AND loc.id = e.location_id
      WHERE e.organization_id = $1 AND e.pick_task_id = $2 AND e.event_type IN ('pick', 'short', 'mis_scan_sku', 'mis_scan_location', 'over_pick')
      ORDER BY e.created_at DESC LIMIT 50`,
    [tx.orgId, taskId],
  );
  return {
    id: t.id,
    taskNumber: t.task_number,
    status: t.status,
    waveId: t.wave_id,
    waveNumber: t.wave_number,
    waveLabel: t.wave_label,
    warehouseId: t.warehouse_id,
    warehouseCode: t.warehouse_code,
    zone: t.zone,
    assigneeUserId: t.assignee_user_id,
    assigneeName: t.assignee_name,
    claimExpiresAt: t.claim_expires_at,
    groups,
    totals: {
      required: groups.reduce((s, g) => s + g.required, 0),
      picked: groups.reduce((s, g) => s + g.picked, 0),
      short: groups.reduce((s, g) => s + g.short, 0),
    },
    recentEvents: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      qty: e.qty,
      corrected: e.corrected,
      sku: e.sku,
      locationCode: e.location_code,
      reasonCode: e.reason_code,
      at: e.created_at,
    })),
  };
}

export async function scanLocation(
  tx: Tx,
  taskId: string,
  userId: string,
  input: { clientEventId: string; code: string; expectedLocationId: string; inputMethod?: InputMethod; offline?: boolean; clientCreatedAt?: string | null },
  ttlMinutes: number,
): Promise<ScanResult> {
  const prev = await previousResult(tx, input.clientEventId);
  if (prev) return prev;
  const raced = await lockTaskAndCheckResend(tx, taskId, input.clientEventId);
  if (raced) return raced;
  const task = await lockTaskForPicker(tx, taskId, userId, ttlMinutes);
  const expected = await tx.maybeOne(`SELECT id, code FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, input.expectedLocationId]);
  if (!expected) throw notFound('ロケーション');
  const code = input.code.normalize('NFKC').trim(); // 全角で手入力されたコードも半角として照合
  const loc = await tx.maybeOne(
    `SELECT id, code FROM locations WHERE organization_id = $1 AND warehouse_id = $2 AND (barcode = $3 OR code = $3) ORDER BY (barcode = $3) DESC LIMIT 1`,
    [tx.orgId, task.warehouse_id, code],
  );
  if (!loc || loc.id !== expected.id) {
    const message = `ロケーションが違います（読取: ${loc?.code ?? code} / 正: ${expected.code}）`;
    await insertEvent(tx, { clientEventId: input.clientEventId, task, locationId: loc?.id ?? null, userId, type: 'mis_scan_location', code, note: message, inputMethod: input.inputMethod, offline: input.offline, clientCreatedAt: input.clientCreatedAt });
    return { ok: false, code: 'WRONG_LOCATION', message, expected: { locationCode: expected.code } };
  }
  await insertEvent(tx, { clientEventId: input.clientEventId, task, locationId: loc.id, userId, type: 'location_ok', code, inputMethod: input.inputMethod, offline: input.offline, clientCreatedAt: input.clientCreatedAt });
  return { ok: true };
}

export async function pickScan(
  tx: Tx,
  taskId: string,
  userId: string,
  input: { clientEventId: string; locationId: string; code: string; qty: number; inputMethod?: InputMethod; offline?: boolean; clientCreatedAt?: string | null },
  ttlMinutes: number,
): Promise<ScanResult> {
  const prev = await previousResult(tx, input.clientEventId);
  if (prev) return prev;
  const raced = await lockTaskAndCheckResend(tx, taskId, input.clientEventId);
  if (raced) return raced;
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 10000) throw new AppError(400, 'INVALID_QTY', '数量が不正です');
  const task = await lockTaskForPicker(tx, taskId, userId, ttlMinutes);
  const code = input.code.normalize('NFKC').trim(); // 全角で手入力されたコードも半角として照合
  const base = { clientEventId: input.clientEventId, task, userId, inputMethod: input.inputMethod, offline: input.offline, clientCreatedAt: input.clientCreatedAt, code };
  const product = await resolveProductByCode(tx, code);
  const expectedHere = await tx.maybeOne(
    `SELECT p.sku, p.name FROM pick_task_lines l JOIN products p ON p.organization_id = l.organization_id AND p.id = l.product_id
      WHERE l.organization_id = $1 AND l.pick_task_id = $2 AND l.location_id = $3 AND l.status = 'open' ORDER BY l.seq LIMIT 1`,
    [tx.orgId, taskId, input.locationId],
  );
  if (!product) {
    const message = `登録されていないコードです（${code.slice(0, 40)}）${expectedHere ? ` / 正: ${expectedHere.sku}` : ''}`;
    await insertEvent(tx, { ...base, locationId: input.locationId, type: 'mis_scan_sku', note: message });
    return { ok: false, code: 'UNKNOWN_CODE', message, expected: expectedHere ? { sku: expectedHere.sku } : undefined };
  }
  const lines = await tx.many(
    `SELECT l.* FROM pick_task_lines l JOIN fulfillments f ON f.organization_id = l.organization_id AND f.id = l.fulfillment_id
      WHERE l.organization_id = $1 AND l.pick_task_id = $2 AND l.location_id = $3 AND l.product_id = $4 AND l.status = 'open'
      ORDER BY f.priority DESC, f.due_at ASC NULLS LAST, l.seq
      FOR UPDATE OF l`,
    [tx.orgId, taskId, input.locationId, product.id],
  );
  if (!lines.length) {
    const elsewhere = await tx.maybeOne(
      `SELECT loc.code FROM pick_task_lines l JOIN locations loc ON loc.organization_id = l.organization_id AND loc.id = l.location_id
        WHERE l.organization_id = $1 AND l.pick_task_id = $2 AND l.product_id = $3 AND l.status = 'open' LIMIT 1`,
      [tx.orgId, taskId, product.id],
    );
    const message = elsewhere
      ? `${product.sku} はこのロケーションではありません（正: ${elsewhere.code}）`
      : expectedHere
        ? `違う商品です（読取: ${product.sku} / 正: ${expectedHere.sku}）`
        : `${product.sku} はこのタスクのピック対象ではありません`;
    await insertEvent(tx, { ...base, locationId: input.locationId, productId: product.id, type: 'mis_scan_sku', note: message });
    return { ok: false, code: 'WRONG_SKU', message, expected: expectedHere ? { sku: expectedHere.sku } : undefined };
  }
  const remaining = lines.reduce((s, l) => s + (l.required_qty - l.picked_qty - l.short_qty), 0);
  if (input.qty > remaining) {
    const message = `必要数を超えています（残り ${remaining} 個）`;
    await insertEvent(tx, { ...base, locationId: input.locationId, productId: product.id, type: 'over_pick', qty: input.qty, note: message });
    return { ok: false, code: 'OVER_PICK', message };
  }
  // 更新する Fulfillment 明細を ID 順に先にロック（同じ明細を別タスクの行が更新する場合のデッドロック防止）
  await tx.many(`SELECT id FROM fulfillment_items WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [
    tx.orgId,
    [...new Set(lines.map((l) => l.fulfillment_item_id as string))],
  ]);
  let rest = input.qty;
  const ffs = new Set<string>();
  for (const l of lines) {
    if (rest <= 0) break;
    const take = Math.min(rest, l.required_qty - l.picked_qty - l.short_qty);
    if (take <= 0) continue;
    await insertEvent(tx, { ...base, lineId: l.id, fulfillmentId: l.fulfillment_id, locationId: l.location_id, productId: l.product_id, type: 'pick', qty: take });
    await tx.exec(
      `UPDATE pick_task_lines SET picked_qty = picked_qty + $3,
              status = CASE WHEN picked_qty + $3 + short_qty >= required_qty THEN (CASE WHEN short_qty > 0 THEN 'short' ELSE 'picked' END) ELSE 'open' END,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, l.id, take],
    );
    await tx.exec(`UPDATE fulfillment_items SET picked_qty = picked_qty + $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, l.fulfillment_item_id, take]);
    ffs.add(l.fulfillment_id);
    rest -= take;
  }
  const taskCompleted = await afterProgress(tx, task, ffs, 'ピッキング');
  const g = await tx.one<{ required: number; picked: number; short: number }>(
    `SELECT COALESCE(SUM(required_qty), 0)::int AS required, COALESCE(SUM(picked_qty), 0)::int AS picked, COALESCE(SUM(short_qty), 0)::int AS short
       FROM pick_task_lines WHERE organization_id = $1 AND pick_task_id = $2 AND location_id = $3 AND product_id = $4 AND status <> 'cancelled'`,
    [tx.orgId, taskId, input.locationId, product.id],
  );
  return { ok: true, picked: input.qty, group: { ...g, remaining: g.required - g.picked - g.short }, taskCompleted };
}

export const SHORT_REASONS = ['not_found', 'damaged', 'wrong_location', 'qty_short', 'other'] as const;

export async function shortPick(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  taskId: string,
  userId: string,
  input: { clientEventId: string; locationId: string; productId: string; reasonCode: (typeof SHORT_REASONS)[number]; note?: string | null; offline?: boolean },
  ttlMinutes: number,
): Promise<ScanResult & { shortQty?: number }> {
  const prev = await previousResult(tx, input.clientEventId);
  if (prev) return prev;
  const raced = await lockTaskAndCheckResend(tx, taskId, input.clientEventId);
  if (raced) return raced;
  if (input.reasonCode === 'other' && !input.note?.trim()) throw new AppError(400, 'NOTE_REQUIRED', '「その他」の場合はメモを入力してください');
  const task = await lockTaskForPicker(tx, taskId, userId, ttlMinutes);
  const lines = await tx.many(
    `SELECT l.*, a.balance_id, a.order_item_id, a.quantity AS a_qty, a.shipped_qty AS a_shipped, a.released_qty AS a_released
       FROM pick_task_lines l JOIN allocations a ON a.organization_id = l.organization_id AND a.id = l.allocation_id
      WHERE l.organization_id = $1 AND l.pick_task_id = $2 AND l.location_id = $3 AND l.product_id = $4 AND l.status = 'open'
      ORDER BY a.balance_id, l.seq FOR UPDATE OF l, a`,
    [tx.orgId, taskId, input.locationId, input.productId],
  );
  if (!lines.length) throw conflict('NOTHING_TO_SHORT', 'Short にできる残数量がありません');
  await tx.many(`SELECT id FROM fulfillment_items WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [
    tx.orgId,
    [...new Set(lines.map((l) => l.fulfillment_item_id as string))],
  ]);
  const ffs = new Set<string>();
  const orders = new Set<string>();
  let total = 0;
  const byBalance = new Map<string, number>();
  for (const l of lines) {
    const rem = l.required_qty - l.picked_qty - l.short_qty;
    if (rem <= 0) continue;
    await insertEvent(tx, {
      clientEventId: input.clientEventId,
      task,
      lineId: l.id,
      fulfillmentId: l.fulfillment_id,
      locationId: l.location_id,
      productId: l.product_id,
      userId,
      type: 'short',
      qty: rem,
      reason: input.reasonCode,
      note: input.note ?? null,
      offline: input.offline,
    });
    await tx.exec(`UPDATE pick_task_lines SET short_qty = short_qty + $3, status = 'short', updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, l.id, rem]);
    await tx.exec(
      `UPDATE fulfillment_items SET short_qty = short_qty + $3, allocated_qty = allocated_qty - $3, updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, l.fulfillment_item_id, rem],
    );
    // 引当の short 分を解放（ピック済み分は引き続き確保）
    const aOpen = l.a_qty - l.a_shipped - l.a_released;
    const releaseQty = Math.min(rem, aOpen);
    if (releaseQty > 0) {
      await tx.exec(
        `UPDATE allocations SET released_qty = released_qty + $3,
                status = CASE WHEN shipped_qty + released_qty + $3 >= quantity THEN (CASE WHEN shipped_qty > 0 THEN 'consumed' ELSE 'released' END) ELSE status END,
                released_at = now(), released_by = $4, release_reason = 'Short Pick'
          WHERE organization_id = $1 AND id = $2`,
        [tx.orgId, l.allocation_id, releaseQty, userId],
      );
      await tx.exec(`UPDATE order_items SET allocated_qty = allocated_qty - $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, l.order_item_id, releaseQty]);
      const ok = await tx.maybeOne(
        `UPDATE inventory_balances SET allocated = allocated - $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND allocated >= $3 RETURNING id`,
        [tx.orgId, l.balance_id, releaseQty],
      );
      if (!ok) throw new AppError(500, 'INVENTORY_INCONSISTENT', '在庫の引当数が不整合です');
      byBalance.set(l.balance_id, (byBalance.get(l.balance_id) ?? 0) + releaseQty);
    }
    ffs.add(l.fulfillment_id);
    total += rem;
  }
  // 在庫: on_hand は減らさず held（調査中）へ
  for (const [balanceId, qty] of byBalance) {
    await applyMovement(tx, {
      balanceId,
      type: 'hold',
      heldDelta: qty,
      referenceType: 'pick_task',
      referenceId: taskId,
      idempotencyKey: `short:${input.clientEventId}:${balanceId}`,
      reason: `Short Pick: ${input.reasonCode}`,
    });
    await createException(tx, deps, {
      type: 'inventory_mismatch',
      title: `在庫不整合の可能性（Short Pick ${qty} 個）`,
      severity: 'high',
      dedupeKey: `inventory_mismatch:${balanceId}`,
      balanceId,
      productId: input.productId,
      locationId: input.locationId,
      warehouseId: task.warehouse_id,
      pickTaskId: taskId,
      detail: { heldQty: qty, reasonCode: input.reasonCode },
    });
  }
  for (const fid of ffs) {
    const f = await tx.one(`SELECT order_id, fulfillment_number FROM fulfillments WHERE organization_id = $1 AND id = $2`, [tx.orgId, fid]);
    orders.add(f.order_id);
    await refreshAllocationStatus(tx, f.order_id);
    await createException(tx, deps, {
      type: 'short_pick',
      title: `Short Pick: ${f.fulfillment_number}`,
      severity: 'high',
      dedupeKey: `short_pick:${fid}`,
      fulfillmentId: fid,
      orderId: f.order_id,
      waveId: task.wave_id,
      pickTaskId: taskId,
      productId: input.productId,
      locationId: input.locationId,
      warehouseId: task.warehouse_id,
      detail: { reasonCode: input.reasonCode, shortQty: total },
    });
  }
  const taskCompleted = await afterProgress(tx, task, ffs, 'Short Pick');
  await audit(tx, {
    action: 'pick.short',
    entityType: 'pick_task',
    entityId: taskId,
    summary: `Short Pick ${total} 個（${input.reasonCode}）`,
    metadata: { reasonCode: input.reasonCode, qty: total, fulfillments: ffs.size },
  });
  return { ok: true, shortQty: total, taskCompleted };
}

export async function correctPick(
  tx: Tx,
  taskId: string,
  userId: string,
  input: { clientEventId: string; pickEventId: string; qty: number; note?: string | null },
  ttlMinutes: number,
  isManager: boolean,
): Promise<ScanResult> {
  const prev = await previousResult(tx, input.clientEventId);
  if (prev) return prev;
  const raced = await lockTaskAndCheckResend(tx, taskId, input.clientEventId);
  if (raced) return raced;
  // 訂正は完了済みタスクにも可能（梱包開始前まで）。完了タスクは訂正で作業中に戻る
  const task = isManager
    ? await tx.maybeOne(`SELECT * FROM pick_tasks WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, taskId])
    : await lockTaskForPicker(tx, taskId, userId, ttlMinutes, true);
  if (!task) throw notFound('Pick タスク');
  if (task.status === 'cancelled') throw conflict('TASK_CLOSED', 'このタスクは取消されています');
  const ev = await tx.maybeOne(`SELECT * FROM pick_events WHERE organization_id = $1 AND id = $2 AND pick_task_id = $3 AND event_type = 'pick'`, [
    tx.orgId,
    input.pickEventId,
    taskId,
  ]);
  if (!ev) throw notFound('ピック実績');
  const corrected = await tx.one(`SELECT COALESCE(SUM(qty), 0)::int AS n FROM pick_events WHERE organization_id = $1 AND corrects_event_id = $2`, [tx.orgId, ev.id]);
  const max = ev.qty + corrected.n;
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > max) throw conflict('INVALID_QTY', `訂正できる数量は ${max} までです`);
  const ff = await tx.one(`SELECT status FROM fulfillments WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, ev.fulfillment_id]);
  if (['packing', 'packed', 'shipped', 'cancelled'].includes(ff.status)) throw conflict('PACKING_STARTED', '梱包が始まった Fulfillment のピック実績は訂正できません');
  const line = await tx.one(`SELECT * FROM pick_task_lines WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, ev.pick_task_line_id]);
  await insertEvent(tx, {
    clientEventId: input.clientEventId,
    task,
    lineId: line.id,
    fulfillmentId: ev.fulfillment_id,
    locationId: ev.location_id,
    productId: ev.product_id,
    userId,
    type: 'correction',
    qty: -input.qty,
    note: input.note ?? '訂正',
    correctsEventId: ev.id,
  });
  await tx.exec(
    `UPDATE pick_task_lines SET picked_qty = picked_qty - $3, status = CASE WHEN picked_qty - $3 + short_qty >= required_qty THEN status ELSE 'open' END, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, line.id, input.qty],
  );
  await tx.exec(`UPDATE fulfillment_items SET picked_qty = picked_qty - $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, line.fulfillment_item_id, input.qty]);
  await afterProgress(tx, task, new Set([ev.fulfillment_id]), 'ピック訂正');
  await audit(tx, { action: 'pick.correct', entityType: 'pick_task', entityId: taskId, summary: `ピック実績を ${input.qty} 個訂正`, metadata: { pickEventId: ev.id, qty: input.qty } });
  return { ok: true, picked: -input.qty };
}

/** 保守: claim の期限切れを解除（進捗は保持。担当者は再開時に再 claim） */
export async function expirePickClaims(deps: Pick<AppDeps, 'pool'>): Promise<number> {
  const orgs = (await deps.pool.query(`SELECT id FROM organizations WHERE status = 'active'`)).rows as { id: string }[];
  let n = 0;
  for (const o of orgs) {
    n += await withTenant(deps.pool, o.id, { userId: null, type: 'job' }, async (tx) => {
      const rows = await tx.many(
        `UPDATE pick_tasks SET assignee_user_id = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE organization_id = $1 AND status IN ('open', 'in_progress') AND assignee_user_id IS NOT NULL AND claim_expires_at < now()
          RETURNING id, task_number`,
        [tx.orgId],
      );
      for (const r of rows) await audit(tx, { action: 'pick_task.claim_timeout', entityType: 'pick_task', entityId: r.id, summary: `${r.task_number} の担当がタイムアウトで解除` });
      return rows.length;
    });
  }
  return n;
}
