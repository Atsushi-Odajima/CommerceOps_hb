import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPerm, orgTx, requireOrg } from '../../http.js';
import { parse } from '../../lib/validate.js';
import { normalizeTracking } from '../shipments/service.js';
import { gtinVariants } from '../products/routes.js';

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
        // 条件ごとに索引を使う問い合わせを分け（1 つの OR にすると全件走査になる）、各 20 件までで打ち切ってから結合する
        const rows = await tx.many(
          `WITH hits AS (
             SELECT id, 1 AS rank, '注文番号' AS matched FROM orders WHERE organization_id = $1 AND order_number = $2
             UNION ALL
             SELECT id, 1, '注文番号' FROM orders WHERE organization_id = $1 AND external_order_id IN ($8, $2)
             UNION ALL
             SELECT order_id, 2, '追跡番号' FROM shipments WHERE $5::text IS NOT NULL AND organization_id = $1 AND tracking_number = $5
             UNION ALL
             (SELECT id, 3, '郵便番号' FROM orders WHERE $6 AND $4::text IS NOT NULL AND organization_id = $1 AND postal_code = $4 ORDER BY order_date DESC LIMIT 20)
             UNION ALL
             -- 氏名: 姓からの前方一致は全期間（索引）、部分一致（名だけ等）は直近 1 万件の注文から（RLS の下では LIKE に索引が使えないため範囲を限定）
             (SELECT id, 4, '送付先氏名' FROM orders WHERE $6 AND $3::text IS NOT NULL AND organization_id = $1 AND recipient_name ^@ $8 ORDER BY order_date DESC LIMIT 20)
             UNION ALL
             (SELECT id, 5, '購入者名' FROM orders WHERE $7 AND $3::text IS NOT NULL AND organization_id = $1 AND customer_name ^@ $8 ORDER BY order_date DESC LIMIT 20)
             UNION ALL
             (SELECT id, 4, '送付先氏名' FROM (SELECT id, order_date, recipient_name FROM orders WHERE $6 AND $3::text IS NOT NULL AND organization_id = $1 ORDER BY order_date DESC LIMIT 10000) r
               WHERE recipient_name ILIKE $3 ORDER BY order_date DESC LIMIT 20)
             UNION ALL
             (SELECT id, 5, '購入者名' FROM (SELECT id, order_date, customer_name FROM orders WHERE $7 AND $3::text IS NOT NULL AND organization_id = $1 ORDER BY order_date DESC LIMIT 10000) c
               WHERE customer_name ILIKE $3 ORDER BY order_date DESC LIMIT 20)
             UNION ALL
             (SELECT order_id, 6, 'SKU' FROM order_items WHERE organization_id = $1 AND sku IN ($8, $2) ORDER BY created_at DESC LIMIT 20)
           ), best AS (
             SELECT id, min(rank) AS rank, (array_agg(matched ORDER BY rank))[1] AS matched FROM hits GROUP BY id
           )
           SELECT o.id, o.order_number, o.external_order_id, o.status, o.order_date, o.order_type, c.name AS channel_name,
                  CASE WHEN $6 THEN o.recipient_name END AS recipient_name, b.matched
             FROM best b
             JOIN orders o ON o.organization_id = $1 AND o.id = b.id
             JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
            ORDER BY b.rank, o.order_date DESC
            LIMIT 20`,
          [tx.orgId, upper, fuzzy, postal, tracking, shipTo, pii, q],
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
               OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.organization_id = p.organization_id AND b.product_id = p.id AND b.code = ANY($4::text[])))
            ORDER BY (upper(p.sku) = $2) DESC, p.sku LIMIT 20`,
          [tx.orgId, upper, fuzzy, gtinVariants(q)],
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
