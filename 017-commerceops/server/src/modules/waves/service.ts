/**
 * Wave（docs/FULFILLMENT_RULES.md §6）
 * - プレビューで候補 ID を確定 → 作成時に条件付き UPDATE で取り込めた Fulfillment だけを snapshot として固定
 * - Pick タスク/行は引当（ロケーション確定済み）から生成。ロケーション順
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import { createException } from '../exceptions/service.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { refreshFulfillmentStatus } from '../fulfillment/status.js';

export interface WaveFilters {
  warehouseId: string;
  shippingMethods?: string[];
  minPriority?: number;
  dueBefore?: string;
  orderDateFrom?: string;
  orderDateTo?: string;
  fulfillmentType?: 'standard' | 'replacement';
  limit: number;
}

export async function previewWave(tx: Tx, f: WaveFilters) {
  const rows = await tx.many(
    `SELECT f.id, f.fulfillment_number, f.priority, f.due_at, f.shipping_method, f.fulfillment_type, o.order_number, o.order_date,
            (SELECT count(*)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id AND fi.required_qty > 0) AS lines,
            (SELECT COALESCE(SUM(required_qty), 0)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id) AS units
       FROM fulfillments f JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
      WHERE f.organization_id = $1 AND f.warehouse_id = $2 AND f.status = 'ready' AND NOT f.on_hold AND f.wave_id IS NULL
        AND ($3::text[] IS NULL OR COALESCE(f.shipping_method, '') = ANY($3))
        AND ($4::int IS NULL OR f.priority >= $4)
        AND ($5::timestamptz IS NULL OR f.due_at <= $5)
        AND ($6::timestamptz IS NULL OR o.order_date >= $6)
        AND ($7::timestamptz IS NULL OR o.order_date < $7)
        AND ($8::text IS NULL OR f.fulfillment_type = $8)
      ORDER BY f.priority DESC, f.due_at ASC NULLS LAST, o.order_date ASC, f.fulfillment_number ASC
      LIMIT $9`,
    [
      tx.orgId,
      f.warehouseId,
      f.shippingMethods?.length ? f.shippingMethods : null,
      f.minPriority ?? null,
      f.dueBefore ?? null,
      f.orderDateFrom ?? null,
      f.orderDateTo ?? null,
      f.fulfillmentType ?? null,
      f.limit,
    ],
  );
  const methods = await tx.many(
    `SELECT COALESCE(shipping_method, '') AS method, count(*)::int AS n FROM fulfillments
      WHERE organization_id = $1 AND warehouse_id = $2 AND status = 'ready' AND NOT on_hold AND wave_id IS NULL GROUP BY 1 ORDER BY 2 DESC`,
    [tx.orgId, f.warehouseId],
  );
  return {
    fulfillments: rows.map((r) => ({
      id: r.id,
      fulfillmentNumber: r.fulfillment_number,
      orderNumber: r.order_number,
      priority: r.priority,
      dueAt: r.due_at,
      shippingMethod: r.shipping_method,
      type: r.fulfillment_type,
      lines: r.lines,
      units: r.units,
    })),
    totals: { fulfillments: rows.length, lines: rows.reduce((s, r) => s + r.lines, 0), units: rows.reduce((s, r) => s + r.units, 0) },
    availableShippingMethods: methods.map((m) => ({ method: m.method, count: m.n })),
  };
}

export async function createWave(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  input: { warehouseId: string; fulfillmentIds: string[]; label?: string | null; splitMode: 'single' | 'zone' | 'lines'; linesPerTask?: number; criteria?: Record<string, unknown> },
) {
  if (!input.fulfillmentIds.length) throw new AppError(400, 'NO_FULFILLMENTS', 'Wave に含める Fulfillment がありません');
  const wh = await tx.maybeOne(`SELECT id, code FROM warehouses WHERE organization_id = $1 AND id = $2`, [tx.orgId, input.warehouseId]);
  if (!wh) throw notFound('倉庫');
  const [waveNumber] = await nextNumbers(deps.numberingPool, tx.orgId, 'wave', 1);
  const waveId = uuidv7();
  await tx.exec(
    `INSERT INTO waves (organization_id, id, wave_number, warehouse_id, label, status, criteria, split_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
    [tx.orgId, waveId, waveNumber, input.warehouseId, input.label ?? null, JSON.stringify(input.criteria ?? {}), input.splitMode, tx.actor.userId],
  );
  // snapshot: プレビューした ID のうち、今も Wave 待ちのものだけを取り込む（後から来た注文・他の Wave に入ったものは混入しない）
  const claimed = await tx.many(
    `UPDATE fulfillments SET status = 'waved', wave_id = $3, updated_at = now()
      WHERE organization_id = $1 AND id = ANY($2) AND warehouse_id = $4 AND status = 'ready' AND NOT on_hold AND wave_id IS NULL
      RETURNING id, order_id`,
    [tx.orgId, input.fulfillmentIds, waveId, input.warehouseId],
  );
  if (!claimed.length) throw conflict('NOTHING_TO_WAVE', '対象の Fulfillment はすでに他の Wave に入ったか、保留・変更されています。プレビューをやり直してください');
  const ids = claimed.map((c) => c.id as string);
  await tx.exec(
    `INSERT INTO wave_fulfillments (organization_id, wave_id, fulfillment_id) SELECT $1, $2, unnest($3::uuid[])`,
    [tx.orgId, waveId, ids],
  );
  // Pick 行: allocation（ロケーション確定）単位
  const lines = await tx.many(
    `SELECT a.id AS allocation_id, a.quantity - a.shipped_qty - a.released_qty AS qty, a.location_id, a.product_id, a.fulfillment_id, a.fulfillment_item_id,
            l.code AS location_code, l.zone, l.pick_sequence, p.sku, f.priority, f.due_at
       FROM allocations a
       JOIN locations l ON l.organization_id = a.organization_id AND l.id = a.location_id
       JOIN products p ON p.organization_id = a.organization_id AND p.id = a.product_id
       JOIN fulfillments f ON f.organization_id = a.organization_id AND f.id = a.fulfillment_id
      WHERE a.organization_id = $1 AND a.fulfillment_id = ANY($2) AND a.status = 'active' AND a.quantity - a.shipped_qty - a.released_qty > 0
      ORDER BY l.pick_sequence, l.code, p.sku, f.priority DESC, f.due_at ASC NULLS LAST, a.fulfillment_id`,
    [tx.orgId, ids],
  );
  if (!lines.length) throw conflict('NO_PICK_LINES', 'ピック対象の引当がありません');
  // タスク分割
  const groups: { zone: string | null; lines: typeof lines }[] = [];
  if (input.splitMode === 'zone') {
    const byZone = new Map<string, typeof lines>();
    for (const l of lines) byZone.set(l.zone ?? '', [...(byZone.get(l.zone ?? '') ?? []), l]);
    for (const [zone, ls] of byZone) groups.push({ zone: zone || null, lines: ls });
  } else if (input.splitMode === 'lines') {
    const n = Math.max(1, input.linesPerTask ?? 30);
    for (let i = 0; i < lines.length; i += n) groups.push({ zone: null, lines: lines.slice(i, i + n) });
  } else {
    groups.push({ zone: null, lines });
  }
  const taskNumbers = await nextNumbers(deps.numberingPool, tx.orgId, 'pick_task', groups.length);
  let seq = 0;
  for (const [gi, g] of groups.entries()) {
    const taskId = uuidv7();
    await tx.exec(
      `INSERT INTO pick_tasks (organization_id, id, task_number, wave_id, warehouse_id, zone, seq, status, line_count, unit_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)`,
      [tx.orgId, taskId, taskNumbers[gi], waveId, input.warehouseId, g.zone, gi + 1, g.lines.length, g.lines.reduce((s, l) => s + l.qty, 0)],
    );
    const col = <K extends string>(k: K) => g.lines.map((l) => l[k]);
    await tx.exec(
      `INSERT INTO pick_task_lines (organization_id, id, pick_task_id, wave_id, fulfillment_id, fulfillment_item_id, allocation_id, location_id, product_id, required_qty, seq)
       SELECT $1, u.id, $2, $3, u.ff, u.fi, u.alloc, u.loc, u.prod, u.qty, u.seq
         FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[], $9::uuid[], $10::int[], $11::int[]) AS u(id, ff, fi, alloc, loc, prod, qty, seq)`,
      [
        tx.orgId,
        taskId,
        waveId,
        g.lines.map(() => uuidv7()),
        col('fulfillment_id'),
        col('fulfillment_item_id'),
        col('allocation_id'),
        col('location_id'),
        col('product_id'),
        col('qty'),
        g.lines.map(() => ++seq),
      ],
    );
  }
  const totals = await tx.one(
    `SELECT count(*)::int AS lines, COALESCE(SUM(required_qty), 0)::int AS units FROM pick_task_lines WHERE organization_id = $1 AND wave_id = $2`,
    [tx.orgId, waveId],
  );
  await tx.exec(`UPDATE waves SET fulfillment_count = $3, line_count = $4, unit_count = $5 WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    waveId,
    ids.length,
    totals.lines,
    totals.units,
  ]);
  for (const orderId of new Set(claimed.map((c) => c.order_id as string))) {
    await recomputeOrderStatus(tx, orderId, `Wave ${waveNumber} に投入`);
  }
  await audit(tx, {
    action: 'wave.create',
    entityType: 'wave',
    entityId: waveId,
    summary: `${waveNumber}（${wh.code}）${ids.length}件 / ${totals.units}個 / タスク${groups.length}`,
    metadata: { fulfillments: ids.length, excluded: input.fulfillmentIds.length - ids.length, lines: totals.lines, units: totals.units, splitMode: input.splitMode },
  });
  return { waveId, waveNumber, fulfillments: ids.length, excluded: input.fulfillmentIds.length - ids.length, tasks: groups.length, ...totals };
}

/** Wave 取消: ピック実績があれば confirm 必須（棚戻し例外） */
export async function cancelWave(tx: Tx, deps: Pick<AppDeps, 'numberingPool'>, waveId: string, opts: { reason: string; confirm?: boolean }) {
  const w = await tx.maybeOne(`SELECT * FROM waves WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, waveId]);
  if (!w) throw notFound('Wave');
  if (w.status === 'cancelled') return { alreadyCancelled: true };
  const members = await tx.many(
    `SELECT f.* FROM wave_fulfillments wf JOIN fulfillments f ON f.organization_id = wf.organization_id AND f.id = wf.fulfillment_id
      WHERE wf.organization_id = $1 AND wf.wave_id = $2 AND wf.removed_at IS NULL FOR UPDATE OF f`,
    [tx.orgId, waveId],
  );
  if (members.some((f) => ['packing', 'packed', 'shipped'].includes(f.status))) {
    throw conflict('WAVE_PACKING_STARTED', '梱包が始まった Fulfillment を含む Wave は取消できません');
  }
  if (members.some((f) => f.has_short)) {
    throw conflict('SHORT_UNRESOLVED', '未解決の Short Pick があります。先に例外キューで解決してください');
  }
  const picked = await tx.many(
    `SELECT l.picked_qty, l.fulfillment_id, p.sku, loc.code AS location FROM pick_task_lines l
       JOIN products p ON p.organization_id = l.organization_id AND p.id = l.product_id
       JOIN locations loc ON loc.organization_id = l.organization_id AND loc.id = l.location_id
      WHERE l.organization_id = $1 AND l.wave_id = $2 AND l.picked_qty > 0`,
    [tx.orgId, waveId],
  );
  if (picked.length && !opts.confirm) {
    throw new AppError(409, 'CONFIRM_REQUIRED', 'ピック済みの商品があります。取消すると棚戻しが必要です。確認のうえ再実行してください', {
      pickedUnits: picked.reduce((s, p) => s + p.picked_qty, 0),
    });
  }
  // ピック実績を取消（訂正イベントとして記録し、数量を戻す）
  if (picked.length) {
    await tx.exec(
      `INSERT INTO pick_events (organization_id, id, client_event_id, pick_task_id, pick_task_line_id, wave_id, fulfillment_id, warehouse_id, location_id, product_id,
                                picker_user_id, event_type, qty, note)
       SELECT l.organization_id, uuidv7(), uuidv7(), l.pick_task_id, l.id, l.wave_id, l.fulfillment_id, $3, l.location_id, l.product_id, $4, 'correction', -l.picked_qty, 'Wave取消'
         FROM pick_task_lines l WHERE l.organization_id = $1 AND l.wave_id = $2 AND l.picked_qty > 0`,
      [tx.orgId, waveId, w.warehouse_id, tx.actor.userId ?? '00000000-0000-0000-0000-000000000000'],
    );
    await tx.exec(
      `UPDATE fulfillment_items fi SET picked_qty = 0, updated_at = now()
        WHERE fi.organization_id = $1 AND fi.fulfillment_id IN (SELECT fulfillment_id FROM wave_fulfillments WHERE organization_id = $1 AND wave_id = $2)`,
      [tx.orgId, waveId],
    );
    await createException(tx, deps, {
      type: 'cancel_putback',
      title: `Wave取消の棚戻し: ${w.wave_number}（${picked.reduce((s, p) => s + p.picked_qty, 0)} 個）`,
      dedupeKey: `wave_putback:${waveId}`,
      waveId,
      warehouseId: w.warehouse_id,
      detail: { items: picked.map((p) => ({ sku: p.sku, qty: p.picked_qty, location: p.location })) },
    });
  }
  await tx.exec(`UPDATE pick_task_lines SET status = 'cancelled', picked_qty = 0, updated_at = now() WHERE organization_id = $1 AND wave_id = $2`, [tx.orgId, waveId]);
  await tx.exec(
    `UPDATE pick_tasks SET status = 'cancelled', cancelled_at = now(), assignee_user_id = NULL, claim_expires_at = NULL, updated_at = now()
      WHERE organization_id = $1 AND wave_id = $2 AND status <> 'completed'`,
    [tx.orgId, waveId],
  );
  await tx.exec(`UPDATE wave_fulfillments SET removed_at = now(), removed_reason = $3 WHERE organization_id = $1 AND wave_id = $2 AND removed_at IS NULL`, [
    tx.orgId,
    waveId,
    `Wave取消: ${opts.reason}`.slice(0, 200),
  ]);
  await tx.exec(`UPDATE waves SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4 WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    waveId,
    tx.actor.userId,
    opts.reason,
  ]);
  for (const f of members) {
    if (f.status === 'cancelled') continue;
    await tx.exec(`UPDATE fulfillments SET wave_id = NULL, status = 'ready', updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, f.id]);
    // short が残っていた場合もリセット（引当は short 時点で解放済み。必要数は Short 解決で調整）
    await refreshFulfillmentStatus(tx, f.id);
    await recomputeOrderStatus(tx, f.order_id, `Wave ${w.wave_number} 取消`);
  }
  await audit(tx, { action: 'wave.cancel', entityType: 'wave', entityId: waveId, summary: `${w.wave_number} を取消`, metadata: { pickedLines: picked.length } });
  return { alreadyCancelled: false };
}
