import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPerm, orgTx, requireOrg } from '../../http.js';
import { parse } from '../../lib/validate.js';
import { normalizeTracking } from '../shipments/service.js';

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/**
 * 横断検索。権限のない種類のデータは検索しない・返さない（例: 氏名・郵便番号での注文検索は送付先閲覧権限のある人だけ）。
 * 倉庫に紐づくデータ（荷物・Wave・出荷作業・返品）は担当倉庫の範囲のみ。
 */
export async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', async (req) => {
    const auth = requireOrg(req);
    const { q: raw } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const q = raw.normalize('NFKC').trim();
    const upper = q.toUpperCase();
    const fuzzy = q.length >= 2 ? `%${likeEscape(q)}%` : null;
    const can = (p: Parameters<typeof hasPerm>[1]) => hasPerm(auth, p);
    let tracking: string | null = null;
    try {
      tracking = normalizeTracking(q);
    } catch {
      tracking = null;
    }
    const postal = /^\d{3}-?\d{4}$/.test(q) ? `${q.replace('-', '').slice(0, 3)}-${q.replace('-', '').slice(3)}` : null;
    return orgTx(req, async (tx) => {
      const out: Record<string, unknown[]> = {};
      if (can('orders.read')) {
        const shipTo = can('orders.read_ship_to');
        const pii = can('orders.read_pii');
        const rows = await tx.many(
          `SELECT o.id, o.order_number, o.external_order_id, o.status, o.order_date, o.order_type, c.name AS channel_name,
                  CASE WHEN $6 THEN o.recipient_name END AS recipient_name,
                  CASE
                    WHEN o.order_number = $2 OR upper(o.external_order_id) = $2 THEN '注文番号'
                    WHEN $5::text IS NOT NULL AND EXISTS (SELECT 1 FROM shipments s WHERE s.organization_id = o.organization_id AND s.order_id = o.id AND s.tracking_number = $5) THEN '追跡番号'
                    WHEN $6 AND o.postal_code = $4 THEN '郵便番号'
                    WHEN $6 AND $3::text IS NOT NULL AND o.recipient_name ILIKE $3 THEN '送付先氏名'
                    WHEN $7 AND $3::text IS NOT NULL AND o.customer_name ILIKE $3 THEN '購入者名'
                    ELSE 'SKU・商品名' END AS matched
             FROM orders o JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
            WHERE o.organization_id = $1 AND (
                  o.order_number = $2 OR upper(o.external_order_id) = $2
               OR ($5::text IS NOT NULL AND EXISTS (SELECT 1 FROM shipments s WHERE s.organization_id = o.organization_id AND s.order_id = o.id AND s.tracking_number = $5))
               OR ($6 AND $4::text IS NOT NULL AND o.postal_code = $4)
               OR ($6 AND $3::text IS NOT NULL AND o.recipient_name ILIKE $3)
               OR ($7 AND $3::text IS NOT NULL AND o.customer_name ILIKE $3)
               OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.organization_id = o.organization_id AND oi.order_id = o.id AND (upper(oi.sku) = $2 OR ($3::text IS NOT NULL AND oi.product_name ILIKE $3))))
            ORDER BY (o.order_number = $2 OR upper(o.external_order_id) = $2) DESC, o.order_date DESC
            LIMIT 20`,
          [tx.orgId, upper, fuzzy, postal, tracking, shipTo, pii],
        );
        out.orders = rows.map((r) => ({
          id: r.id,
          orderNumber: r.order_number,
          externalOrderId: r.external_order_id,
          channelName: r.channel_name,
          status: r.status,
          orderType: r.order_type,
          orderDate: r.order_date,
          recipientName: shipTo ? r.recipient_name : undefined,
          matched: r.matched,
        }));
      }
      if (can('products.read')) {
        const rows = await tx.many(
          `SELECT p.id, p.sku, p.name, p.variant, p.active FROM products p
            WHERE p.organization_id = $1 AND (upper(p.sku) = $2 OR ($3::text IS NOT NULL AND (p.sku ILIKE $3 OR p.name ILIKE $3))
               OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.organization_id = p.organization_id AND b.product_id = p.id AND b.code = $4))
            ORDER BY (upper(p.sku) = $2) DESC, p.sku LIMIT 20`,
          [tx.orgId, upper, fuzzy, q],
        );
        out.products = rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, variant: r.variant, active: r.active }));
      }
      if (can('shipments.read') || can('shipments.manage')) {
        const rows = await tx.many(
          `SELECT s.id, s.shipment_number, s.status, s.tracking_number, s.carrier, o.order_number FROM shipments s
             JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id
            WHERE s.organization_id = $1 AND (s.shipment_number = $2 OR ($3::text IS NOT NULL AND s.tracking_number = $3)) AND ($4::uuid[] IS NULL OR s.warehouse_id = ANY($4))
            ORDER BY s.created_at DESC LIMIT 20`,
          [tx.orgId, upper, tracking, auth.warehouseIds],
        );
        out.shipments = rows.map((r) => ({ id: r.id, shipmentNumber: r.shipment_number, status: r.status, trackingNumber: r.tracking_number, carrier: r.carrier, orderNumber: r.order_number }));
      }
      if (can('returns.read') || can('returns.receive') || can('returns.inspect')) {
        const rows = await tx.many(
          `SELECT r.id, r.return_number, r.status, o.order_number FROM returns r JOIN orders o ON o.organization_id = r.organization_id AND o.id = r.order_id
            WHERE r.organization_id = $1 AND r.return_number = $2 AND ($3::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($3)) LIMIT 20`,
          [tx.orgId, upper, auth.warehouseIds],
        );
        out.returns = rows.map((r) => ({ id: r.id, returnNumber: r.return_number, status: r.status, orderNumber: r.order_number }));
      }
      if (can('waves.read') || can('waves.manage')) {
        const rows = await tx.many(
          `SELECT id, wave_number, label, status FROM waves WHERE organization_id = $1 AND (wave_number = $2 OR ($3::text IS NOT NULL AND label ILIKE $3)) AND ($4::uuid[] IS NULL OR warehouse_id = ANY($4))
            ORDER BY created_at DESC LIMIT 20`,
          [tx.orgId, upper, fuzzy, auth.warehouseIds],
        );
        out.waves = rows.map((r) => ({ id: r.id, waveNumber: r.wave_number, label: r.label, status: r.status }));
      }
      if (can('fulfillment.manage') || can('pack.execute')) {
        const rows = await tx.many(
          `SELECT f.id, f.fulfillment_number, f.status, o.id AS order_id, o.order_number FROM fulfillments f JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
            WHERE f.organization_id = $1 AND f.fulfillment_number = $2 AND ($3::uuid[] IS NULL OR f.warehouse_id = ANY($3)) LIMIT 20`,
          [tx.orgId, upper, auth.warehouseIds],
        );
        out.fulfillments = rows.map((r) => ({ id: r.id, fulfillmentNumber: r.fulfillment_number, status: r.status, orderId: can('orders.read') ? r.order_id : undefined, orderNumber: r.order_number }));
      }
      if (can('exceptions.read')) {
        const rows = await tx.many(
          `SELECT id, exception_number, type, status, title FROM exception_cases
            WHERE organization_id = $1 AND exception_number = $2 AND ($3::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($3)) LIMIT 20`,
          [tx.orgId, upper, auth.warehouseIds],
        );
        out.exceptions = rows.map((r) => ({ id: r.id, number: r.exception_number, type: r.type, status: r.status, title: r.title }));
      }
      if (can('orders.import')) {
        const rows = await tx.many(`SELECT id, batch_number, status, filename FROM import_batches WHERE organization_id = $1 AND batch_number = $2 LIMIT 5`, [tx.orgId, upper]);
        out.imports = rows.map((r) => ({ id: r.id, batchNumber: r.batch_number, status: r.status, filename: r.filename }));
      }
      const total = Object.values(out).reduce((s, v) => s + v.length, 0);
      return { q, total, results: out };
    });
  });
}
