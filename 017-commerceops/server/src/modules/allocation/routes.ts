import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFromReq, orgTx, perm, requireOrg } from '../../http.js';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/validate.js';
import { enqueue, getJob } from '../../jobs/queue.js';
import { allocateOrderInTx, deallocate, explainAllocation, releaseAllocations, runAllocation } from './engine.js';
import { cancelOrder, cancelOrderLines } from '../orders/cancel.js';

export async function allocationRoutes(app: FastifyInstance) {
  /** 引当実行（Job）。組織ごとに同時 1 本（dedupe） */
  app.post('/api/allocation/run', { preHandler: perm('allocation.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(z.object({ orderIds: z.array(z.uuid()).max(5000).optional() }), req.body ?? {});
    const j = await enqueue(req.server.deps.pool, {
      type: 'allocation.run',
      organizationId: auth.org.id,
      payload: { trigger: 'manual', userId: auth.userId, orderIds: body.orderIds },
      dedupeKey: `allocation:${auth.org.id}`,
      maxAttempts: 3,
    });
    return { jobId: j.id, deduped: j.deduped };
  });

  /** 同期実行（少量向け・テスト用）。Job と同じ処理 */
  app.post('/api/allocation/run-now', { preHandler: perm('allocation.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(z.object({ orderIds: z.array(z.uuid()).max(500).optional() }), req.body ?? {});
    return runAllocation(req.server.deps, auth.org.id, actorFromReq(req), { trigger: 'manual', orderIds: body.orderIds, limit: 500 });
  });

  app.get('/api/jobs/:id', async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const j = await getJob(req.server.deps.pool, id, auth.org.id);
    if (!j) throw notFound('ジョブ');
    return { id: j.id, type: j.type, status: j.status, attempts: j.attempts, result: j.result, lastError: j.last_error, createdAt: j.created_at, finishedAt: j.finished_at };
  });

  app.get('/api/allocation/summary', { preHandler: perm('allocation.manage') }, async (req) => {
    return orgTx(req, async (tx) => {
      const counts = await tx.one(
        `SELECT count(*) FILTER (WHERE status = 'ready_for_allocation')::int AS ready,
                count(*) FILTER (WHERE status = 'partially_allocated')::int AS partial,
                count(*) FILTER (WHERE status = 'validation_required')::int AS validation,
                count(*) FILTER (WHERE status = 'on_hold')::int AS on_hold
           FROM orders WHERE organization_id = $1`,
        [tx.orgId],
      );
      const shortages = await tx.many(
        `WITH demand AS (
           SELECT oi.product_id, SUM(oi.quantity - oi.cancelled_qty - oi.shipped_qty - oi.allocated_qty)::int AS need, count(DISTINCT oi.order_id)::int AS orders
             FROM order_items oi JOIN orders o ON o.organization_id = oi.organization_id AND o.id = oi.order_id
            WHERE oi.organization_id = $1 AND o.status IN ('ready_for_allocation', 'partially_allocated', 'partially_shipped') AND oi.product_id IS NOT NULL
            GROUP BY oi.product_id HAVING SUM(oi.quantity - oi.cancelled_qty - oi.shipped_qty - oi.allocated_qty) > 0),
         avail AS (
           SELECT ib.product_id, SUM(ib.on_hand - ib.allocated - ib.held)::int AS available
             FROM inventory_balances ib JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
            WHERE ib.organization_id = $1 AND l.kind = 'pick' AND l.active GROUP BY ib.product_id)
         SELECT p.id, p.sku, p.name, d.need, d.orders, COALESCE(a.available, 0) AS available
           FROM demand d JOIN products p ON p.organization_id = $1 AND p.id = d.product_id
           LEFT JOIN avail a ON a.product_id = d.product_id
          ORDER BY (d.need - COALESCE(a.available, 0)) DESC LIMIT 100`,
        [tx.orgId],
      );
      const runs = await tx.many(
        `SELECT r.*, u.name AS started_by_name FROM allocation_runs r LEFT JOIN users u ON u.id = r.started_by
          WHERE r.organization_id = $1 ORDER BY r.started_at DESC LIMIT 10`,
        [tx.orgId],
      );
      return {
        counts,
        shortages: shortages.map((s) => ({ productId: s.id, sku: s.sku, name: s.name, need: s.need, orders: s.orders, available: s.available })),
        runs: runs.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          considered: r.orders_considered,
          allocated: r.orders_allocated,
          partial: r.orders_partial,
          unallocated: r.orders_unallocated,
          startedBy: r.started_by_name,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          error: r.error,
        })),
      };
    });
  });

  app.get('/api/orders/:id/allocation-plan', { preHandler: perm('allocation.manage', 'orders.read') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      if (!(await tx.maybeOne('SELECT id FROM orders WHERE organization_id = $1 AND id = $2', [tx.orgId, id]))) throw notFound('注文');
      return explainAllocation(tx, id);
    });
  });

  app.post('/api/orders/:id/allocate', { preHandler: perm('allocation.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ warehouseId: z.uuid().optional() }), req.body ?? {});
    return orgTx(
      req,
      (tx) =>
        allocateOrderInTx(tx, req.server.deps, id, {
          allowPartial: body.warehouseId ? true : auth.org.settings.allocation.allowPartialAllocation,
          autoRelease: auth.org.settings.allocation.autoReleaseFullyAllocated,
          warehouseId: body.warehouseId,
          manual: true,
        }),
      { retries: 3 },
    );
  });

  app.post('/api/orders/:id/deallocate', { preHandler: perm('allocation.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ allocationIds: z.array(z.uuid()).optional(), reason: z.string().trim().min(1).max(200) }), req.body);
    const released = await orgTx(req, (tx) => deallocate(tx, id, body));
    return { released };
  });

  /** 揃った分を先行出荷（一部引当でも Fulfillment を作成） */
  app.post('/api/orders/:id/release', { preHandler: perm('allocation.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const fulfillmentIds = await orgTx(req, (tx) => releaseAllocations(tx, req.server.deps, id, { mode: 'partial' }));
    return { fulfillmentIds };
  });

  app.post('/api/orders/:id/cancel', { preHandler: perm('orders.cancel') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, 'キャンセル理由を入力してください').max(300), confirm: z.boolean().default(false) }), req.body);
    return orgTx(req, (tx) => cancelOrder(tx, req.server.deps, id, body));
  });

  app.post('/api/orders/:id/cancel-lines', { preHandler: perm('orders.cancel') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({ lines: z.array(z.object({ itemId: z.uuid(), qty: z.number().int().min(1) })).min(1).max(200), reason: z.string().trim().min(1).max(300) }),
      req.body,
    );
    return orgTx(req, (tx) => cancelOrderLines(tx, id, body.lines, body.reason));
  });
}
