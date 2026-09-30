import type { FastifyInstance } from 'fastify';
import { hasPerm, orgTx, requireOrg } from '../../http.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/badges', async (req) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'exceptions.read')) return { exceptionsOpen: 0 };
    return orgTx(req, async (tx) => {
      const r = await tx.one(
        `SELECT count(*)::int AS n FROM exception_cases WHERE organization_id = $1 AND status IN ('open', 'investigating')
            AND ($2::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($2))`,
        [tx.orgId, auth.warehouseIds],
      );
      return { exceptionsOpen: r.n };
    });
  });

  /**
   * ホームの件数。権限のある項目だけ返す（権限外の件数は返さない）。倉庫に紐づく作業は担当倉庫のみ集計。
   * 「今日」は組織のタイムゾーンで判定。
   */
  app.get('/api/dashboard/home', async (req) => {
    const auth = requireOrg(req);
    const tz = auth.org.timezone;
    const can = (p: Parameters<typeof hasPerm>[1]) => hasPerm(auth, p);
    return orgTx(req, async (tx) => {
      const out: Record<string, number | null> = {};
      const today = `((now() AT TIME ZONE $2)::date::timestamp AT TIME ZONE $2)`;
      if (can('orders.read')) {
        const o = await tx.one(
          `SELECT
             count(*) FILTER (WHERE created_at >= ${today} AND order_type = 'standard')::int AS today_orders,
             count(*) FILTER (WHERE status = 'validation_required')::int AS validation_required,
             count(*) FILTER (WHERE status = 'ready_for_allocation')::int AS ready_for_allocation,
             count(*) FILTER (WHERE status = 'partially_allocated')::int AS partially_allocated,
             count(*) FILTER (WHERE status = 'on_hold')::int AS on_hold
           FROM orders WHERE organization_id = $1 AND status NOT IN ('shipped', 'cancelled', 'closed')
              OR (organization_id = $1 AND created_at >= ${today})`,
          [tx.orgId, tz],
        );
        Object.assign(out, {
          todayOrders: o.today_orders,
          validationRequired: o.validation_required,
          readyForAllocation: o.ready_for_allocation,
          partiallyAllocated: o.partially_allocated,
          onHold: o.on_hold,
        });
        if (can('orders.import')) {
          out.todayImports = (await tx.one(`SELECT count(*)::int AS n FROM import_batches WHERE organization_id = $1 AND status = 'committed' AND committed_at >= ${today}`, [tx.orgId, tz])).n;
        }
      }
      if (can('exceptions.read')) {
        const e = await tx.one(
          `SELECT count(*) FILTER (WHERE status IN ('open', 'investigating'))::int AS open,
                  count(*) FILTER (WHERE status IN ('open', 'investigating') AND type = 'shortage')::int AS shortage,
                  count(*) FILTER (WHERE status IN ('open', 'investigating') AND severity = 'high')::int AS high
             FROM exception_cases WHERE organization_id = $1 AND ($2::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($2))`,
          [tx.orgId, auth.warehouseIds],
        );
        Object.assign(out, { exceptionsOpen: e.open, shortage: e.shortage, exceptionsHigh: e.high });
      }
      if (can('fulfillment.manage') || can('waves.manage') || can('pack.execute')) {
        const f = await tx.one(
          `SELECT count(*) FILTER (WHERE status = 'ready' AND NOT on_hold)::int AS wave_wait,
                  count(*) FILTER (WHERE status IN ('waved', 'picking'))::int AS picking,
                  count(*) FILTER (WHERE status IN ('picked', 'packing') AND NOT on_hold)::int AS packing,
                  count(*) FILTER (WHERE due_at < now() AND status NOT IN ('shipped', 'cancelled'))::int AS overdue
             FROM fulfillments WHERE organization_id = $1 AND status NOT IN ('shipped', 'cancelled') AND ($2::uuid[] IS NULL OR warehouse_id = ANY($2))`,
          [tx.orgId, auth.warehouseIds],
        );
        Object.assign(out, { waveWaiting: f.wave_wait, picking: f.picking, packing: f.packing, overdue: f.overdue });
      }
      if (can('shipments.read') || can('shipments.manage')) {
        const s = await tx.one(
          `SELECT count(*) FILTER (WHERE status = 'draft')::int AS awaiting,
                  count(*) FILTER (WHERE status = 'shipped' AND shipped_at >= ${today})::int AS shipped_today
             FROM shipments WHERE organization_id = $1 AND (status = 'draft' OR shipped_at >= ${today}) AND ($3::uuid[] IS NULL OR warehouse_id = ANY($3))`,
          [tx.orgId, tz, auth.warehouseIds],
        );
        Object.assign(out, { awaitingShipment: s.awaiting, shippedToday: s.shipped_today });
      }
      if (can('returns.read') || can('returns.receive') || can('returns.inspect')) {
        const r = await tx.one(
          `SELECT count(*) FILTER (WHERE status IN ('received', 'inspecting'))::int AS to_inspect,
                  count(*) FILTER (WHERE status IN ('authorized', 'in_transit'))::int AS to_receive,
                  count(*) FILTER (WHERE status = 'requested')::int AS to_authorize
             FROM returns WHERE organization_id = $1 AND status IN ('requested', 'authorized', 'in_transit', 'received', 'inspecting')
              AND ($2::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($2))`,
          [tx.orgId, auth.warehouseIds],
        );
        Object.assign(out, { returnsToInspect: r.to_inspect, returnsToReceive: r.to_receive, returnsToAuthorize: r.to_authorize });
      }
      if (can('pick.execute')) {
        const t = await tx.one(
          `SELECT count(*) FILTER (WHERE assignee_user_id = $2)::int AS mine, count(*) FILTER (WHERE assignee_user_id IS NULL)::int AS available
             FROM pick_tasks WHERE organization_id = $1 AND status IN ('open', 'in_progress') AND ($3::uuid[] IS NULL OR warehouse_id = ANY($3))`,
          [tx.orgId, auth.userId, auth.warehouseIds],
        );
        Object.assign(out, { myPickTasks: t.mine, availablePickTasks: t.available });
      }
      return { generatedAt: new Date().toISOString(), timezone: tz, counts: out };
    });
  });
}
