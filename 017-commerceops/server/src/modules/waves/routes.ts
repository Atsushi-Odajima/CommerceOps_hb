import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { cappedCount } from '../../lib/pagination.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { cancelWave, createWave, previewWave } from './service.js';
import { claimTask, correctPick, pickScan, releaseTask, scanLocation, shortPick, SHORT_REASONS, taskView } from '../picking/service.js';
import { resolveShort } from '../fulfillment/service.js';

const InputMethod = z.enum(['camera', 'scanner', 'manual']).optional();

export async function waveRoutes(app: FastifyInstance) {
  // ---------------- fulfillments ----------------
  app.get('/api/fulfillments', { preHandler: perm('fulfillment.manage', 'waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(
      zPage.extend({
        status: z.string().max(20).optional(),
        warehouseId: z.uuid().optional(),
        onHold: z.enum(['true', 'false']).optional(),
        hasShort: z.enum(['true', 'false']).optional(),
        overdue: z.enum(['true']).optional(),
        q: z.string().trim().max(60).optional(),
      }),
      req.query,
    );
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, q.status ?? null, q.warehouseId ?? null, q.onHold ?? null, q.hasShort ?? null, q.overdue ?? null, q.q ?? null, auth.warehouseIds];
      const where = `f.organization_id = $1 AND ($2::text IS NULL OR f.status = $2) AND ($3::uuid IS NULL OR f.warehouse_id = $3)
        AND ($4::text IS NULL OR f.on_hold = ($4 = 'true')) AND ($5::text IS NULL OR f.has_short = ($5 = 'true'))
        AND ($6::text IS NULL OR (f.due_at < now() AND f.status NOT IN ('shipped', 'cancelled')))
        AND ($7::text IS NULL OR f.fulfillment_number = $7 OR o.order_number = $7 OR o.external_order_id = $7)
        AND ($8::uuid[] IS NULL OR f.warehouse_id = ANY($8))`;
      const { total, totalCapped } = await cappedCount(tx, `FROM fulfillments f JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id WHERE ${where}`, params);
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `SELECT f.*, o.order_number, o.external_order_id, w.code AS warehouse_code, wv.wave_number,
                (SELECT COALESCE(SUM(required_qty), 0)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id) AS units,
                (SELECT COALESCE(SUM(picked_qty), 0)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id) AS picked,
                (SELECT COALESCE(SUM(short_qty), 0)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id) AS short
           FROM fulfillments f
           JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
           JOIN warehouses w ON w.organization_id = f.organization_id AND w.id = f.warehouse_id
           LEFT JOIN waves wv ON wv.organization_id = f.organization_id AND wv.id = f.wave_id
          WHERE ${where}
          ORDER BY (f.status IN ('shipped', 'cancelled')), f.priority DESC, f.due_at ASC NULLS LAST, f.created_at
          LIMIT $9 OFFSET $10`,
        params,
      );
      return {
        total,
        totalCapped,
        items: rows.map((f) => ({
          id: f.id,
          fulfillmentNumber: f.fulfillment_number,
          orderId: f.order_id,
          orderNumber: f.order_number,
          externalOrderId: f.external_order_id,
          warehouseCode: f.warehouse_code,
          type: f.fulfillment_type,
          status: f.status,
          onHold: f.on_hold,
          hasShort: f.has_short,
          priority: f.priority,
          dueAt: f.due_at,
          shippingMethod: f.shipping_method,
          waveId: f.wave_id,
          waveNumber: f.wave_number,
          units: f.units,
          picked: f.picked,
          short: f.short,
        })),
      };
    });
  });

  app.post('/api/fulfillments/:id/resolve-short', { preHandler: perm('fulfillment.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ action: z.enum(['backlog', 'reallocate']), warehouseId: z.uuid().optional(), note: z.string().trim().max(300).optional() }), req.body);
    if (body.warehouseId) assertWarehouse(req, body.warehouseId);
    return orgTx(req, (tx) => resolveShort(tx, req.server.deps, id, body), { retries: 3 });
  });

  // ---------------- waves ----------------
  const PreviewBody = z.object({
    warehouseId: z.uuid(),
    shippingMethods: z.array(z.string().max(50)).max(20).optional(),
    minPriority: z.number().int().min(0).max(9).optional(),
    dueBefore: z.iso.datetime({ offset: true }).optional(),
    orderDateFrom: z.iso.datetime({ offset: true }).optional(),
    orderDateTo: z.iso.datetime({ offset: true }).optional(),
    fulfillmentType: z.enum(['standard', 'replacement']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  });

  app.post('/api/waves/preview', { preHandler: perm('waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(PreviewBody, req.body);
    assertWarehouse(req, body.warehouseId);
    return orgTx(req, async (tx) => {
      if (!(await tx.maybeOne('SELECT id FROM warehouses WHERE organization_id = $1 AND id = $2', [tx.orgId, body.warehouseId]))) throw notFound('倉庫');
      return previewWave(tx, { ...body, limit: body.limit ?? auth.org.settings.wave.maxFulfillments });
    });
  });

  app.post('/api/waves', { preHandler: perm('waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({
        warehouseId: z.uuid(),
        fulfillmentIds: z.array(z.uuid()).min(1).max(500),
        label: z.string().trim().max(60).optional(),
        splitMode: z.enum(['single', 'zone', 'lines']).default('single'),
        linesPerTask: z.number().int().min(1).max(500).optional(),
        criteria: z.record(z.string(), z.unknown()).optional(),
      }),
      req.body,
    );
    assertWarehouse(req, body.warehouseId);
    if (body.fulfillmentIds.length > auth.org.settings.wave.maxFulfillments) {
      throw forbidden(`1 Wave の上限（${auth.org.settings.wave.maxFulfillments} 件）を超えています`);
    }
    return orgTx(req, (tx) => createWave(tx, req.server.deps, body));
  });

  app.get('/api/waves', { preHandler: perm('waves.read', 'waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(zPage.extend({ status: z.string().max(20).optional(), warehouseId: z.uuid().optional() }), req.query);
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, q.status ?? null, q.warehouseId ?? null, auth.warehouseIds];
      const where = `w.organization_id = $1 AND ($2::text IS NULL OR w.status = $2) AND ($3::uuid IS NULL OR w.warehouse_id = $3) AND ($4::uuid[] IS NULL OR w.warehouse_id = ANY($4))`;
      const total = (await tx.one(`SELECT count(*)::int AS n FROM waves w WHERE ${where}`, params)).n;
      params.push(q.limit, q.offset);
      // 先に 1 ページ分の Wave を決めてから、その分だけ Pick 進捗を集計する（全 Wave を集計しない）
      const rows = await tx.many(
        `WITH page AS (
           SELECT w.id FROM waves w WHERE ${where}
            ORDER BY (w.status IN ('completed', 'cancelled')), w.created_at DESC LIMIT $5 OFFSET $6
         )
         SELECT w.*, wh.code AS warehouse_code, u.name AS created_by_name, pr.picked_units, pr.short_units
           FROM page JOIN waves w ON w.organization_id = $1 AND w.id = page.id
           JOIN warehouses wh ON wh.organization_id = w.organization_id AND wh.id = w.warehouse_id
           LEFT JOIN users u ON u.id = w.created_by
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(l.picked_qty), 0)::int AS picked_units, COALESCE(SUM(l.short_qty), 0)::int AS short_units
               FROM pick_task_lines l WHERE l.organization_id = w.organization_id AND l.wave_id = w.id
           ) pr ON true
          ORDER BY (w.status IN ('completed', 'cancelled')), w.created_at DESC`,
        params,
      );
      return {
        total,
        items: rows.map((w) => ({
          id: w.id,
          waveNumber: w.wave_number,
          label: w.label,
          warehouseCode: w.warehouse_code,
          status: w.status,
          fulfillmentCount: w.fulfillment_count,
          lineCount: w.line_count,
          unitCount: w.unit_count,
          pickedUnits: w.picked_units,
          shortUnits: w.short_units,
          createdBy: w.created_by_name,
          createdAt: w.created_at,
        })),
      };
    });
  });

  app.get('/api/waves/:id', { preHandler: perm('waves.read', 'waves.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const w = await tx.maybeOne(
        `SELECT w.*, wh.code AS warehouse_code, wh.name AS warehouse_name FROM waves w JOIN warehouses wh ON wh.organization_id = w.organization_id AND wh.id = w.warehouse_id
          WHERE w.organization_id = $1 AND w.id = $2`,
        [tx.orgId, id],
      );
      if (!w) throw notFound('Wave');
      assertWarehouse(req, w.warehouse_id);
      const tasks = await tx.many(
        `SELECT t.*, u.name AS assignee_name,
                (SELECT COALESCE(SUM(picked_qty), 0)::int FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id) AS picked,
                (SELECT COALESCE(SUM(short_qty), 0)::int FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id) AS short
           FROM pick_tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
          WHERE t.organization_id = $1 AND t.wave_id = $2 ORDER BY t.seq`,
        [tx.orgId, id],
      );
      const ffs = await tx.many(
        `SELECT f.id, f.fulfillment_number, f.status, f.on_hold, f.has_short, f.priority, f.due_at, o.order_number, o.id AS order_id, wf.removed_at, wf.removed_reason
           FROM wave_fulfillments wf JOIN fulfillments f ON f.organization_id = wf.organization_id AND f.id = wf.fulfillment_id
           JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
          WHERE wf.organization_id = $1 AND wf.wave_id = $2 ORDER BY f.fulfillment_number`,
        [tx.orgId, id],
      );
      return {
        id: w.id,
        waveNumber: w.wave_number,
        label: w.label,
        warehouseId: w.warehouse_id,
        warehouseCode: w.warehouse_code,
        warehouseName: w.warehouse_name,
        status: w.status,
        criteria: w.criteria,
        splitMode: w.split_mode,
        fulfillmentCount: w.fulfillment_count,
        lineCount: w.line_count,
        unitCount: w.unit_count,
        createdAt: w.created_at,
        completedAt: w.completed_at,
        cancelReason: w.cancel_reason,
        tasks: tasks.map((t) => ({
          id: t.id,
          taskNumber: t.task_number,
          zone: t.zone,
          status: t.status,
          assigneeUserId: t.assignee_user_id,
          assigneeName: t.assignee_name,
          claimExpiresAt: t.claim_expires_at,
          lineCount: t.line_count,
          unitCount: t.unit_count,
          picked: t.picked,
          short: t.short,
          startedAt: t.started_at,
          completedAt: t.completed_at,
        })),
        fulfillments: ffs.map((f) => ({
          id: f.id,
          fulfillmentNumber: f.fulfillment_number,
          orderId: f.order_id,
          orderNumber: f.order_number,
          status: f.status,
          onHold: f.on_hold,
          hasShort: f.has_short,
          priority: f.priority,
          dueAt: f.due_at,
          removedAt: f.removed_at,
          removedReason: f.removed_reason,
        })),
      };
    });
  });

  app.get('/api/waves/:id/pick-list', { preHandler: perm('waves.read', 'waves.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const w = await tx.maybeOne(
        `SELECT w.*, wh.code AS warehouse_code, wh.name AS warehouse_name FROM waves w JOIN warehouses wh ON wh.organization_id = w.organization_id AND wh.id = w.warehouse_id
          WHERE w.organization_id = $1 AND w.id = $2`,
        [tx.orgId, id],
      );
      if (!w) throw notFound('Wave');
      assertWarehouse(req, w.warehouse_id);
      const rows = await tx.many(
        `SELECT loc.code AS location_code, loc.barcode AS location_barcode, loc.zone, loc.pick_sequence, p.sku, p.name, p.variant, t.task_number,
                SUM(l.required_qty)::int AS qty, SUM(l.picked_qty)::int AS picked,
                string_agg(DISTINCT f.fulfillment_number, ', ' ORDER BY f.fulfillment_number) AS fulfillments
           FROM pick_task_lines l
           JOIN locations loc ON loc.organization_id = l.organization_id AND loc.id = l.location_id
           JOIN products p ON p.organization_id = l.organization_id AND p.id = l.product_id
           JOIN fulfillments f ON f.organization_id = l.organization_id AND f.id = l.fulfillment_id
           JOIN pick_tasks t ON t.organization_id = l.organization_id AND t.id = l.pick_task_id
          WHERE l.organization_id = $1 AND l.wave_id = $2 AND l.status <> 'cancelled'
          GROUP BY loc.code, loc.barcode, loc.zone, loc.pick_sequence, p.sku, p.name, p.variant, t.task_number
          ORDER BY t.task_number, loc.pick_sequence, loc.code, p.sku`,
        [tx.orgId, id],
      );
      return {
        waveNumber: w.wave_number,
        label: w.label,
        warehouseCode: w.warehouse_code,
        warehouseName: w.warehouse_name,
        createdAt: w.created_at,
        lines: rows.map((r) => ({
          taskNumber: r.task_number,
          locationCode: r.location_code,
          locationBarcode: r.location_barcode,
          zone: r.zone,
          sku: r.sku,
          name: r.name,
          variant: r.variant,
          qty: r.qty,
          picked: r.picked,
          fulfillments: r.fulfillments,
        })),
      };
    });
  });

  app.post('/api/waves/:id/cancel', { preHandler: perm('waves.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1).max(300), confirm: z.boolean().default(false) }), req.body);
    return orgTx(req, async (tx) => {
      const w = await tx.maybeOne(`SELECT warehouse_id FROM waves WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!w) throw notFound('Wave');
      assertWarehouse(req, w.warehouse_id);
      return cancelWave(tx, req.server.deps, id, body);
    });
  });

  // ---------------- pick tasks ----------------
  app.get('/api/pick-tasks', { preHandler: perm('pick.execute', 'waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(z.object({ scope: z.enum(['mine', 'available', 'all']).default('mine') }), req.query);
    return orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT t.*, w.wave_number, w.label, wh.code AS warehouse_code, u.name AS assignee_name,
                (SELECT COALESCE(SUM(picked_qty + short_qty), 0)::int FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id AND l.status <> 'cancelled') AS done_units
           FROM pick_tasks t JOIN waves w ON w.organization_id = t.organization_id AND w.id = t.wave_id
           JOIN warehouses wh ON wh.organization_id = t.organization_id AND wh.id = t.warehouse_id
           LEFT JOIN users u ON u.id = t.assignee_user_id
          WHERE t.organization_id = $1 AND t.status IN ('open', 'in_progress')
            AND ($2::uuid[] IS NULL OR t.warehouse_id = ANY($2))
            AND ($3 = 'all' OR ($3 = 'mine' AND t.assignee_user_id = $4) OR ($3 = 'available' AND (t.assignee_user_id IS NULL OR t.claim_expires_at < now())))
          ORDER BY (t.assignee_user_id = $4) DESC NULLS LAST, t.created_at, t.seq
          LIMIT 200`,
        [tx.orgId, auth.warehouseIds, q.scope, auth.userId],
      );
      return {
        items: rows.map((t) => ({
          id: t.id,
          taskNumber: t.task_number,
          waveNumber: t.wave_number,
          waveLabel: t.label,
          warehouseCode: t.warehouse_code,
          zone: t.zone,
          status: t.status,
          assigneeName: t.assignee_name,
          mine: t.assignee_user_id === auth.userId,
          claimExpiresAt: t.claim_expires_at,
          lineCount: t.line_count,
          unitCount: t.unit_count,
          doneUnits: t.done_units,
        })),
      };
    });
  });

  async function loadTaskWarehouse(req: Parameters<typeof orgTx>[0], taskId: string) {
    return orgTx(req, async (tx) => {
      const t = await tx.maybeOne(`SELECT warehouse_id FROM pick_tasks WHERE organization_id = $1 AND id = $2`, [tx.orgId, taskId]);
      if (!t) throw notFound('Pick タスク');
      assertWarehouse(req, t.warehouse_id);
      return t.warehouse_id as string;
    });
  }

  app.get('/api/pick-tasks/:id', { preHandler: perm('pick.execute', 'waves.read') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    await loadTaskWarehouse(req, id);
    return orgTx(req, (tx) => taskView(tx, id));
  });

  app.post('/api/pick-tasks/:id/claim', { preHandler: perm('pick.execute') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadTaskWarehouse(req, id);
    await orgTx(req, (tx) => claimTask(tx, id, auth.userId, auth.org.settings.assignment.claimTimeoutMinutes));
    return orgTx(req, (tx) => taskView(tx, id));
  });

  app.post('/api/pick-tasks/:id/release', { preHandler: perm('pick.execute', 'waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadTaskWarehouse(req, id);
    await orgTx(req, (tx) => releaseTask(tx, id, auth.userId, hasPerm(auth, 'waves.manage')));
    return { ok: true };
  });

  app.post('/api/pick-tasks/:id/assign', { preHandler: perm('waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ userId: z.uuid() }), req.body);
    const wh = await loadTaskWarehouse(req, id);
    // 割当先が同組織の有効なメンバーで、Pick 権限と倉庫範囲を持つことを確認
    const m = await req.server.deps.pool.query(
      `SELECT role, warehouse_ids FROM memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [auth.org.id, body.userId],
    );
    const mem = m.rows[0];
    if (!mem || !['owner', 'ops_manager', 'picker'].includes(mem.role) || (mem.warehouse_ids && !mem.warehouse_ids.includes(wh))) {
      throw forbidden('このユーザーにはこの倉庫の Pick 作業を割り当てられません');
    }
    await orgTx(req, (tx) => claimTask(tx, id, body.userId, auth.org.settings.assignment.claimTimeoutMinutes, true));
    return { ok: true };
  });

  const scanStatus = (r: { ok: boolean }) => (r.ok ? 200 : 422);
  /** 誤 scan（422）も共通のエラー形式 { error: { code, message } } を含めて返す（結果フィールドはそのまま） */
  const scanBody = (r: { ok: boolean; code?: string; message?: string }) => (r.ok ? r : { ...r, error: { code: r.code, message: r.message } });

  app.post('/api/pick-tasks/:id/scan-location', { preHandler: perm('pick.execute') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        clientEventId: z.uuid(),
        code: z.string().trim().min(1).max(128),
        expectedLocationId: z.uuid(),
        inputMethod: InputMethod,
        offline: z.boolean().optional(),
        clientCreatedAt: z.iso.datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    await loadTaskWarehouse(req, id);
    const r = await orgTx(req, (tx) => scanLocation(tx, id, auth.userId, body, auth.org.settings.assignment.claimTimeoutMinutes));
    return reply.status(scanStatus(r)).send(scanBody(r));
  });

  app.post('/api/pick-tasks/:id/pick', { preHandler: perm('pick.execute') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        clientEventId: z.uuid(),
        locationId: z.uuid(),
        code: z.string().trim().min(1).max(128),
        qty: z.number().int().min(1).max(10000).default(1),
        inputMethod: InputMethod,
        offline: z.boolean().optional(),
        clientCreatedAt: z.iso.datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    await loadTaskWarehouse(req, id);
    const r = await orgTx(req, (tx) => pickScan(tx, id, auth.userId, body, auth.org.settings.assignment.claimTimeoutMinutes), { retries: 3 });
    return reply.status(scanStatus(r)).send(scanBody(r));
  });

  app.post('/api/pick-tasks/:id/short', { preHandler: perm('pick.execute') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        clientEventId: z.uuid(),
        locationId: z.uuid(),
        productId: z.uuid(),
        reasonCode: z.enum(SHORT_REASONS),
        note: z.string().trim().max(300).optional(),
        offline: z.boolean().optional(),
      }),
      req.body,
    );
    await loadTaskWarehouse(req, id);
    return orgTx(req, (tx) => shortPick(tx, req.server.deps, id, auth.userId, body, auth.org.settings.assignment.claimTimeoutMinutes), { retries: 3 });
  });

  app.post('/api/pick-tasks/:id/correct', { preHandler: perm('pick.execute', 'waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ clientEventId: z.uuid(), pickEventId: z.uuid(), qty: z.number().int().min(1), note: z.string().trim().max(300).optional() }), req.body);
    await loadTaskWarehouse(req, id);
    return orgTx(req, (tx) => correctPick(tx, id, auth.userId, body, auth.org.settings.assignment.claimTimeoutMinutes, hasPerm(auth, 'waves.manage')));
  });
}
