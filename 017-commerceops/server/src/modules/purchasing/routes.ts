import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, orgTx, perm, requireOrg } from '../../http.js';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import {
  cancelOrder,
  closeRemaining,
  computeSuggestions,
  createDraft,
  createDraftsFromSuggestions,
  createSupplier,
  loadPo,
  placeOrder,
  poDisplayStatus,
  PO_STATUS_LABELS,
  receivePo,
  saveReplenishment,
  updateDraft,
  updateSupplier,
} from './service.js';

const SupplierBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(500).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD で入力してください');
const LineBody = z.object({ productId: z.uuid(), locationId: z.uuid().nullable().optional(), qty: z.number().int().min(1).max(1_000_000) });

const ReplenishmentBody = z
  .object({
    supplierId: z.uuid().nullable().default(null),
    safetyStock: z.number().int().min(0).max(1_000_000_000),
    reorderPoint: z.number().int().min(0).max(1_000_000_000),
    targetStock: z.number().int().min(1).max(1_000_000_000),
    orderMultiple: z.number().int().min(1).max(1_000_000).default(1),
    minOrderQty: z.number().int().min(0).max(1_000_000).default(0),
    leadTimeDays: z.number().int().min(0).max(365).nullable().default(null),
  })
  .nullable();

export async function purchasingRoutes(app: FastifyInstance) {
  // ---------------- 仕入先 ----------------
  app.get('/api/suppliers', { preHandler: perm('purchasing.read') }, async (req) => {
    const q = parse(z.object({ includeInactive: z.enum(['true', 'false']).optional() }), req.query);
    return orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT id, code, name, contact, lead_time_days, note, active FROM suppliers WHERE organization_id = $1 AND ($2::boolean OR active) ORDER BY code, id`,
        [tx.orgId, q.includeInactive === 'true'],
      );
      return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, contact: r.contact, leadTimeDays: r.lead_time_days, note: r.note, active: r.active })) };
    });
  });

  app.post('/api/suppliers', { preHandler: perm('purchasing.manage') }, async (req) => {
    const body = parse(SupplierBody, req.body);
    return orgTx(req, async (tx) => {
      const id = await createSupplier(tx, body);
      await audit(tx, { action: 'supplier.create', entityType: 'supplier', entityId: id, summary: `仕入先 ${body.code} を登録` });
      return { id };
    });
  });

  app.put('/api/suppliers/:id', { preHandler: perm('purchasing.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(SupplierBody, req.body);
    return orgTx(req, async (tx) => {
      await updateSupplier(tx, id, body);
      await audit(tx, { action: 'supplier.update', entityType: 'supplier', entityId: id, summary: `仕入先 ${body.code} を更新` });
      return { id };
    });
  });

  // ---------------- 発注 ----------------
  app.get('/api/purchase-orders', { preHandler: perm('purchasing.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(zPage.extend({ status: z.enum(['draft', 'placed', 'cancelled', 'open']).optional(), supplierId: z.uuid().optional() }), req.query);
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, q.status ?? null, q.supplierId ?? null, auth.warehouseIds];
      const where = `po.organization_id = $1 AND ($3::uuid IS NULL OR po.supplier_id = $3) AND ($4::uuid[] IS NULL OR po.warehouse_id = ANY($4))
        AND ($2::text IS NULL OR ($2 = 'open' AND po.status = 'placed' AND EXISTS (
              SELECT 1 FROM purchase_order_lines x WHERE x.organization_id = po.organization_id AND x.purchase_order_id = po.id AND x.ordered_qty - x.received_qty - x.closed_qty > 0))
          OR po.status = $2)`;
      const total = (await tx.one(`SELECT count(*)::int AS n FROM purchase_orders po WHERE ${where}`, params)).n;
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `SELECT po.id, po.po_number, po.status, po.expected_date, po.created_at, po.placed_at, s.name AS supplier_name, w.code AS warehouse_code,
                COALESCE(SUM(pl.ordered_qty), 0)::int AS q, COALESCE(SUM(pl.received_qty), 0)::int AS r, COALESCE(SUM(pl.closed_qty), 0)::int AS c,
                count(pl.id)::int AS line_count
           FROM purchase_orders po
           JOIN suppliers s ON s.organization_id = po.organization_id AND s.id = po.supplier_id
           JOIN warehouses w ON w.organization_id = po.organization_id AND w.id = po.warehouse_id
           LEFT JOIN purchase_order_lines pl ON pl.organization_id = po.organization_id AND pl.purchase_order_id = po.id
          WHERE ${where}
          GROUP BY po.organization_id, po.id, s.name, w.code
          ORDER BY po.created_at DESC, po.id DESC LIMIT $5 OFFSET $6`,
        params,
      );
      return {
        total,
        items: rows.map((r) => {
          const display = poDisplayStatus(r.status, [{ ordered_qty: r.q, received_qty: r.r, closed_qty: r.c }]);
          return {
            id: r.id,
            poNumber: r.po_number,
            status: r.status,
            displayStatus: display,
            displayStatusLabel: PO_STATUS_LABELS[display],
            supplierName: r.supplier_name,
            warehouseCode: r.warehouse_code,
            expectedDate: r.expected_date,
            lineCount: r.line_count,
            orderedQty: r.q,
            receivedQty: r.r,
            openQty: r.status === 'placed' ? r.q - r.r - r.c : 0,
            createdAt: r.created_at,
          };
        }),
      };
    });
  });

  app.get('/api/purchase-orders/:id', { preHandler: perm('purchasing.read') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const po = await loadPo(tx, id);
      assertWarehouse(req, po.warehouseId);
      return po;
    });
  });

  app.post('/api/purchase-orders', { preHandler: perm('purchasing.manage') }, async (req) => {
    const body = parse(
      z.object({ supplierId: z.uuid(), warehouseId: z.uuid(), expectedDate: zDate.nullable().optional(), note: z.string().trim().max(1000).nullable().optional(), lines: z.array(LineBody).min(1).max(200) }),
      req.body,
    );
    assertWarehouse(req, body.warehouseId);
    return orgTx(req, async (tx) => {
      const r = await createDraft(tx, req.server.deps.numberingPool, body);
      await audit(tx, { action: 'purchase_order.create', entityType: 'purchase_order', entityId: r.id, summary: `発注 ${r.poNumber} を下書き作成` });
      return loadPo(tx, r.id);
    });
  });

  const withPo = async (req: Parameters<typeof orgTx>[0], id: string, fn: (tx: Parameters<Parameters<typeof orgTx>[1]>[0], po: { po_number: string }) => Promise<void>) =>
    orgTx(req, async (tx) => {
      const po = await tx.maybeOne(`SELECT warehouse_id, po_number FROM purchase_orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!po) throw notFound('発注');
      assertWarehouse(req, po.warehouse_id);
      await fn(tx, po as { po_number: string });
      return loadPo(tx, id);
    });

  app.put('/api/purchase-orders/:id', { preHandler: perm('purchasing.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ expectedDate: zDate.nullable().optional(), note: z.string().trim().max(1000).nullable().optional(), lines: z.array(LineBody).min(1).max(200) }), req.body);
    return withPo(req, id, async (tx, po) => {
      await updateDraft(tx, id, body);
      await audit(tx, { action: 'purchase_order.update', entityType: 'purchase_order', entityId: id, summary: `発注 ${po.po_number} の下書きを更新` });
    });
  });

  app.post('/api/purchase-orders/:id/place', { preHandler: perm('purchasing.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return withPo(req, id, async (tx, po) => {
      await placeOrder(tx, id);
      await audit(tx, { action: 'purchase_order.place', entityType: 'purchase_order', entityId: id, summary: `発注 ${po.po_number} を発注済みにした` });
    });
  });

  app.post('/api/purchase-orders/:id/cancel', { preHandler: perm('purchasing.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return withPo(req, id, async (tx, po) => {
      await cancelOrder(tx, id);
      await audit(tx, { action: 'purchase_order.cancel', entityType: 'purchase_order', entityId: id, summary: `発注 ${po.po_number} を取消` });
    });
  });

  // 入荷は倉庫作業なので、発注の管理権限か在庫調整の権限があれば行える
  app.post('/api/purchase-orders/:id/receive', { preHandler: perm('purchasing.manage', 'inventory.adjust') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        requestId: z.uuid(),
        lines: z.array(z.object({ lineId: z.uuid(), qty: z.number().int().min(1).max(1_000_000), locationId: z.uuid().nullable().optional() })).min(1).max(400),
        note: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    let applied = false;
    const po = await withPo(req, id, async (tx, p) => {
      const r = await receivePo(tx, id, body);
      applied = r.applied;
      if (r.applied) {
        const qty = body.lines.reduce((a, l) => a + l.qty, 0);
        await audit(tx, { action: 'purchase_order.receive', entityType: 'purchase_order', entityId: id, summary: `発注 ${p.po_number} を入荷 ${qty} 個`, metadata: { qty } });
      }
    });
    return { ...po, applied };
  });

  app.post('/api/purchase-orders/:id/close', { preHandler: perm('purchasing.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, '打切りの理由を入力してください').max(300), lineIds: z.array(z.uuid()).max(200).optional() }), req.body);
    return withPo(req, id, async (tx, po) => {
      const r = await closeRemaining(tx, id, body);
      await audit(tx, { action: 'purchase_order.close', entityType: 'purchase_order', entityId: id, summary: `発注 ${po.po_number} の未入荷分を打切り（${r.closedLines}行）` });
    });
  });

  // ---------------- 補充 ----------------
  app.get('/api/replenishment', { preHandler: perm('purchasing.read') }, async (req) => {
    const q = parse(z.object({ all: z.enum(['true', 'false']).optional() }), req.query);
    return orgTx(req, async (tx) => ({ items: await computeSuggestions(tx, { onlyActionable: q.all !== 'true' }) }));
  });

  app.put('/api/products/:id/replenishment', { preHandler: perm('purchasing.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ settings: ReplenishmentBody }), req.body);
    return orgTx(req, async (tx) => {
      await saveReplenishment(tx, id, body.settings);
      await audit(tx, { action: 'product.replenishment', entityType: 'product', entityId: id, summary: body.settings ? '補充設定を保存' : '補充設定を削除' });
      const [s] = await computeSuggestions(tx, { productIds: [id] });
      return { settings: s ?? null };
    });
  });

  app.post('/api/replenishment/drafts', { preHandler: perm('purchasing.manage') }, async (req) => {
    const body = parse(
      z.object({ warehouseId: z.uuid(), items: z.array(z.object({ productId: z.uuid(), qty: z.number().int().min(1).max(1_000_000), basisP: z.number().int() })).min(1).max(200) }),
      req.body,
    );
    assertWarehouse(req, body.warehouseId);
    return orgTx(req, async (tx) => {
      const created = await createDraftsFromSuggestions(tx, req.server.deps.numberingPool, body);
      await audit(tx, { action: 'purchase_order.create_from_replenishment', entityType: 'purchase_order', summary: `補充候補から発注の下書きを ${created.length} 件作成`, metadata: { count: created.length } });
      return { created };
    });
  });
}
