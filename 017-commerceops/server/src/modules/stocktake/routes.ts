import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { addLine, cancelStocktake, confirmStocktake, loadStocktake, recordCount, startStocktake, toReview } from './service.js';

const STATUS_LABELS: Record<string, string> = { counting: '計数中', review: '差異確認', confirmed: '確定', cancelled: '中止' };

export async function stocktakeRoutes(app: FastifyInstance) {
  const guard = async (req: Parameters<typeof orgTx>[0], id: string, tx: Parameters<Parameters<typeof orgTx>[1]>[0]) => {
    const st = await tx.maybeOne(`SELECT warehouse_id FROM stocktakes WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
    if (!st) throw notFound('棚卸');
    assertWarehouse(req, st.warehouse_id);
  };

  app.get('/api/stocktakes', { preHandler: perm('stocktake.count', 'inventory.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(zPage.extend({ status: z.enum(['counting', 'review', 'confirmed', 'cancelled', 'open']).optional() }), req.query);
    return orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT s.id, s.status, s.created_at, s.confirmed_at, l.code AS location_code, w.code AS warehouse_code,
                (SELECT count(*)::int FROM stocktake_lines x WHERE x.organization_id = s.organization_id AND x.stocktake_id = s.id) AS line_count,
                (SELECT count(*)::int FROM stocktake_lines x WHERE x.organization_id = s.organization_id AND x.stocktake_id = s.id AND x.counted_qty IS NULL) AS uncounted
           FROM stocktakes s
           JOIN locations l ON l.organization_id = s.organization_id AND l.id = s.location_id
           JOIN warehouses w ON w.organization_id = s.organization_id AND w.id = s.warehouse_id
          WHERE s.organization_id = $1 AND ($2::uuid[] IS NULL OR s.warehouse_id = ANY($2))
            AND ($3::text IS NULL OR ($3 = 'open' AND s.status IN ('counting','review')) OR s.status = $3)
          ORDER BY s.created_at DESC, s.id DESC LIMIT $4 OFFSET $5`,
        [tx.orgId, auth.warehouseIds, q.status ?? null, q.limit, q.offset],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          status: r.status,
          statusLabel: STATUS_LABELS[r.status],
          warehouseCode: r.warehouse_code,
          locationCode: r.location_code,
          lineCount: r.line_count,
          uncounted: r.uncounted,
          createdAt: r.created_at,
          confirmedAt: r.confirmed_at,
        })),
      };
    });
  });

  app.post('/api/stocktakes', { preHandler: perm('stocktake.count') }, async (req) => {
    const body = parse(z.object({ locationId: z.uuid(), note: z.string().trim().max(1000).nullable().optional() }), req.body);
    return orgTx(req, async (tx) => {
      const loc = await tx.maybeOne(`SELECT warehouse_id, code FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.locationId]);
      if (!loc) throw notFound('ロケーション');
      assertWarehouse(req, loc.warehouse_id);
      const id = await startStocktake(tx, body);
      await audit(tx, { action: 'stocktake.start', entityType: 'stocktake', entityId: id, summary: `ロケーション ${loc.code} の棚卸を開始` });
      return loadStocktake(tx, id);
    });
  });

  app.get('/api/stocktakes/:id', { preHandler: perm('stocktake.count', 'inventory.read') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      await guard(req, id, tx);
      return loadStocktake(tx, id);
    });
  });

  // 商品の追加（productId か、スキャンしたバーコード / SKU）
  app.post('/api/stocktakes/:id/lines', { preHandler: perm('stocktake.count') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ productId: z.uuid().optional(), code: z.string().trim().min(1).max(128).optional() }), req.body);
    return orgTx(req, async (tx) => {
      await guard(req, id, tx);
      let productId = body.productId;
      if (!productId && body.code) {
        const p = await tx.maybeOne(
          `SELECT p.id FROM products p WHERE p.organization_id = $1 AND p.sku = $2
           UNION SELECT b.product_id FROM product_barcodes b WHERE b.organization_id = $1 AND b.code = $2 LIMIT 1`,
          [tx.orgId, body.code],
        );
        if (!p) throw notFound('商品');
        productId = p.id;
      }
      if (!productId) throw badRequest('PRODUCT_REQUIRED', '商品を指定してください');
      const lineId = await addLine(tx, id, productId);
      return { lineId, stocktake: await loadStocktake(tx, id) };
    });
  });

  app.put('/api/stocktakes/:id/lines/:lineId', { preHandler: perm('stocktake.count') }, async (req) => {
    const p = parse(z.object({ id: z.uuid(), lineId: z.uuid() }), req.params);
    const body = parse(z.object({ countedQty: z.number().int().min(0).max(1_000_000_000).nullable(), reason: z.string().trim().max(300).nullable().optional(), version: z.number().int() }), req.body);
    return orgTx(req, async (tx) => {
      await guard(req, p.id, tx);
      await recordCount(tx, p.id, p.lineId, body);
      return loadStocktake(tx, p.id);
    });
  });

  app.post('/api/stocktakes/:id/review', { preHandler: perm('stocktake.count') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      await guard(req, id, tx);
      await toReview(tx, id);
      return loadStocktake(tx, id);
    });
  });

  app.post('/api/stocktakes/:id/confirm', { preHandler: perm('stocktake.confirm') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      await guard(req, id, tx);
      const r = await confirmStocktake(tx, id);
      if (r.applied) await audit(tx, { action: 'stocktake.confirm', entityType: 'stocktake', entityId: id, summary: `棚卸を確定（調整 ${r.adjustments} 件）`, metadata: r });
      return { ...(await loadStocktake(tx, id)), adjustments: r.adjustments };
    });
  });

  app.post('/api/stocktakes/:id/cancel', { preHandler: perm('stocktake.confirm') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      await guard(req, id, tx);
      await cancelStocktake(tx, id);
      await audit(tx, { action: 'stocktake.cancel', entityType: 'stocktake', entityId: id, summary: '棚卸を中止' });
      return loadStocktake(tx, id);
    });
  });
}
