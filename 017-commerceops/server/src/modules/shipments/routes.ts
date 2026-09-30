import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { contentDisposition, encodeCsv, toCsv } from '../../lib/csv.js';
import { readUpload } from '../../lib/upload.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { decodeCsvBuffer, parseCsvText } from '../imports/csvfile.js';
import { piiLevel } from '../orders/present.js';
import { audit } from '../audit/audit.js';
import { CARRIERS, carrierLabel, confirmShipment, normalizeTracking, presentShipment, resolveCarrier, updateShipmentInfo } from './service.js';
import { importTracking } from './tracking-import.js';

const SHIPMENT_SELECT = `
  SELECT s.*, o.order_number, o.external_order_id, o.recipient_name, c.name AS channel_name, f.fulfillment_number, f.on_hold, w.code AS warehouse_code,
         u.name AS confirmed_by_name,
         (SELECT COALESCE(SUM(si.quantity), 0)::int FROM shipment_items si WHERE si.organization_id = s.organization_id AND si.shipment_id = s.id) AS units
    FROM shipments s
    JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id
    JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
    JOIN fulfillments f ON f.organization_id = s.organization_id AND f.id = s.fulfillment_id
    JOIN warehouses w ON w.organization_id = s.organization_id AND w.id = s.warehouse_id
    LEFT JOIN users u ON u.id = s.confirmed_by`;

/** 組織タイムゾーンでの日付文字列（YYYY-MM-DD）→ UTC の範囲 */
function dayRange(from: string | undefined, to: string | undefined) {
  return { from: from ?? null, to: to ?? null };
}

function fmtLocal(d: Date | string | null, tz: string) {
  if (!d) return '';
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
  return p.replace('T', ' ');
}

export async function shipmentRoutes(app: FastifyInstance) {
  async function loadShipmentWarehouse(req: FastifyRequest, id: string) {
    return orgTx(req, async (tx) => {
      const s = await tx.maybeOne(`SELECT warehouse_id FROM shipments WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!s) throw notFound('荷物');
      assertWarehouse(req, s.warehouse_id);
      return s.warehouse_id as string;
    });
  }
  const requireTracking = (req: FastifyRequest) => requireOrg(req).org.settings.shipping.requireTracking;

  app.get('/api/shipments/meta', { preHandler: perm('shipments.read', 'shipments.manage') }, async (req) => {
    const auth = requireOrg(req);
    return {
      carriers: CARRIERS.map((c) => ({ value: c.code, label: c.label })),
      defaultCarrier: auth.org.settings.shipping.defaultCarrier ? resolveCarrier(auth.org.settings.shipping.defaultCarrier) : null,
      requireTracking: auth.org.settings.shipping.requireTracking,
    };
  });

  app.get('/api/shipments', { preHandler: perm('shipments.read', 'shipments.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(
      zPage.extend({
        status: z.enum(['draft', 'shipped', 'cancelled']).optional(),
        warehouseId: z.uuid().optional(),
        carrier: z.string().max(20).optional(),
        missingTracking: z.enum(['true']).optional(),
        q: z.string().trim().max(60).optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      }),
      req.query,
    );
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    const level = piiLevel(auth);
    return orgTx(req, async (tx) => {
      let tracking: string | null = null;
      if (q.q) {
        try {
          tracking = normalizeTracking(q.q);
        } catch {
          tracking = null;
        }
      }
      const r = dayRange(q.from, q.to);
      const params: unknown[] = [tx.orgId, q.status ?? null, q.warehouseId ?? null, q.carrier ?? null, q.missingTracking ?? null, q.q?.toUpperCase() ?? null, tracking, auth.warehouseIds, r.from, r.to, auth.org.timezone];
      const where = `s.organization_id = $1 AND ($2::text IS NULL OR s.status = $2) AND ($3::uuid IS NULL OR s.warehouse_id = $3)
        AND ($4::text IS NULL OR s.carrier = $4) AND ($5::text IS NULL OR (s.tracking_number IS NULL AND NOT s.no_tracking))
        AND ($6::text IS NULL OR s.shipment_number = $6 OR o.order_number = $6 OR upper(o.external_order_id) = $6 OR s.tracking_number = $7)
        AND ($8::uuid[] IS NULL OR s.warehouse_id = ANY($8))
        AND ($9::date IS NULL OR COALESCE(s.shipped_at, s.created_at) >= ($9::date::timestamp AT TIME ZONE $11))
        AND ($10::date IS NULL OR COALESCE(s.shipped_at, s.created_at) < (($10::date + 1)::timestamp AT TIME ZONE $11))`;
      const total = (await tx.one(`SELECT count(*)::int AS n FROM shipments s JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id WHERE ${where}`, params)).n;
      const counts = await tx.many(
        `SELECT s.status, count(*)::int AS n FROM shipments s WHERE s.organization_id = $1 AND ($2::uuid[] IS NULL OR s.warehouse_id = ANY($2)) GROUP BY s.status`,
        [tx.orgId, auth.warehouseIds],
      );
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `${SHIPMENT_SELECT} WHERE ${where}
          ORDER BY (s.status = 'draft') DESC, COALESCE(s.shipped_at, s.created_at) DESC, s.shipment_number DESC
          LIMIT $12 OFFSET $13`,
        params,
      );
      return {
        total,
        counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        items: rows.map((s) => presentShipment(s, level === 'full' ? 'ship_to' : level)),
      };
    });
  });

  app.get('/api/shipments/export', { preHandler: perm('export.csv') }, async (req, reply) => {
    const auth = requireOrg(req);
    const q = parse(
      z.object({
        type: z.enum(['pending', 'shipped']),
        warehouseId: z.uuid().optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        encoding: z.enum(['utf-8', 'shift_jis']).default('utf-8'),
      }),
      req.query,
    );
    if (q.type === 'pending' && !hasPerm(auth, 'orders.read_ship_to')) throw forbidden('送付先を含む出力の権限がありません');
    if (!hasPerm(auth, 'shipments.read')) throw forbidden();
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    const tz = auth.org.timezone;
    const { text, count } = await orgTx(req, async (tx) => {
      const rows = await tx.many(
        `${SHIPMENT_SELECT}
          WHERE s.organization_id = $1 AND s.status = $2 AND ($3::uuid IS NULL OR s.warehouse_id = $3) AND ($4::uuid[] IS NULL OR s.warehouse_id = ANY($4))
            AND ($2 <> 'draft' OR (NOT f.on_hold AND o.cancelled_at IS NULL))
            AND ($5::date IS NULL OR COALESCE(s.shipped_at, s.created_at) >= ($5::date::timestamp AT TIME ZONE $7))
            AND ($6::date IS NULL OR COALESCE(s.shipped_at, s.created_at) < (($6::date + 1)::timestamp AT TIME ZONE $7))
          ORDER BY s.shipment_number LIMIT 50000`,
        [tx.orgId, q.type === 'pending' ? 'draft' : 'shipped', q.warehouseId ?? null, auth.warehouseIds, q.from ?? null, q.to ?? null, tz],
      );
      const items = await tx.many(
        `SELECT si.shipment_id, si.quantity, p.sku, oi.product_name FROM shipment_items si
           JOIN order_items oi ON oi.organization_id = si.organization_id AND oi.id = si.order_item_id
           LEFT JOIN products p ON p.organization_id = si.organization_id AND p.id = si.product_id
          WHERE si.organization_id = $1 AND si.shipment_id = ANY($2) ORDER BY si.id`,
        [tx.orgId, rows.map((r) => r.id)],
      );
      const byShipment = new Map<string, typeof items>();
      for (const it of items) byShipment.set(it.shipment_id, [...(byShipment.get(it.shipment_id) ?? []), it]);
      const showPhone = hasPerm(auth, 'orders.read_pii');
      let csvText: string;
      if (q.type === 'pending') {
        csvText = toCsv(
          ['出荷番号', '注文番号', 'チャネル', '外部注文番号', '箱番号', '配送会社', '配送方法', 'お届け先氏名', '郵便番号', '都道府県', '市区町村', '住所1', '住所2', '電話番号', '品名', '個数', '重量(g)'],
          rows.map((s) => {
            const its = byShipment.get(s.id) ?? [];
            const st = s.ship_to ?? {};
            const first = its[0]?.product_name ?? '';
            return [
              s.shipment_number,
              s.order_number,
              s.channel_name,
              s.external_order_id,
              s.box_no,
              carrierLabel(s.carrier),
              s.service,
              st.name,
              st.postalCode,
              st.prefecture,
              st.city,
              st.address1,
              st.address2,
              showPhone ? st.phone : '',
              its.length > 1 ? `${first} 他${its.length - 1}点` : first,
              its.reduce((sum, i) => sum + i.quantity, 0),
              s.weight_g,
            ];
          }),
        );
      } else {
        csvText = toCsv(
          ['出荷番号', '注文番号', 'チャネル', '外部注文番号', '箱番号', '配送会社', '追跡番号', '出荷日時', '内容'],
          rows.map((s) => [
            s.shipment_number,
            s.order_number,
            s.channel_name,
            s.external_order_id,
            s.box_no,
            carrierLabel(s.carrier),
            s.no_tracking ? '' : s.tracking_number,
            fmtLocal(s.shipped_at, tz),
            (byShipment.get(s.id) ?? []).map((i) => `${i.sku}×${i.quantity}`).join(' / '),
          ]),
        );
      }
      await audit(tx, { action: 'export.shipments', entityType: 'shipment', summary: `出荷 CSV 出力（${q.type === 'pending' ? '出荷予定' : '出荷実績'} ${rows.length} 件）`, metadata: { type: q.type, count: rows.length, encoding: q.encoding } });
      return { text: csvText, count: rows.length };
    });
    const date = fmtLocal(new Date(), tz).slice(0, 10).replace(/-/g, '');
    reply.header('content-type', `text/csv; charset=${q.encoding === 'shift_jis' ? 'Shift_JIS' : 'utf-8'}`);
    reply.header('content-disposition', contentDisposition(`${q.type === 'pending' ? '出荷予定' : '出荷実績'}_${date}.csv`));
    reply.header('x-row-count', String(count));
    return reply.send(encodeCsv(text, q.encoding));
  });

  app.get('/api/shipments/:id', { preHandler: perm('shipments.read', 'shipments.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadShipmentWarehouse(req, id);
    return orgTx(req, async (tx) => {
      const s = await tx.one(`${SHIPMENT_SELECT} WHERE s.organization_id = $1 AND s.id = $2`, [tx.orgId, id]);
      const items = await tx.many(
        `SELECT si.id, si.quantity, si.order_item_id, oi.sku, oi.product_name, oi.variant FROM shipment_items si
           JOIN order_items oi ON oi.organization_id = si.organization_id AND oi.id = si.order_item_id
          WHERE si.organization_id = $1 AND si.shipment_id = $2 ORDER BY oi.line_no`,
        [tx.orgId, id],
      );
      const siblings = await tx.many(
        `SELECT id, shipment_number, box_no, status FROM shipments WHERE organization_id = $1 AND order_id = $2 AND id <> $3 ORDER BY shipment_number`,
        [tx.orgId, s.order_id, id],
      );
      const history = hasPerm(auth, 'audit.read') || hasPerm(auth, 'shipments.manage')
        ? await tx.many(
            `SELECT a.action, a.summary, a.created_at, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
              WHERE a.organization_id = $1 AND a.entity_type = 'shipment' AND a.entity_id = $2 ORDER BY a.created_at`,
            [tx.orgId, id],
          )
        : [];
      return {
        ...presentShipment(s, piiLevel(auth)),
        items: items.map((i) => ({ id: i.id, orderItemId: i.order_item_id, sku: i.sku, name: i.product_name, variant: i.variant, quantity: i.quantity })),
        siblings: siblings.map((x) => ({ id: x.id, shipmentNumber: x.shipment_number, boxNo: x.box_no, status: x.status })),
        history: history.map((h) => ({ action: h.action, summary: h.summary, actor: h.actor_name, at: h.created_at })),
      };
    });
  });

  app.patch('/api/shipments/:id', { preHandler: perm('shipments.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        carrier: z.string().trim().max(40).nullable().optional(),
        service: z.string().trim().max(60).nullable().optional(),
        trackingNumber: z.string().trim().max(60).nullable().optional(),
        noTracking: z.boolean().optional(),
        weightG: z.number().int().min(0).max(1_000_000).nullable().optional(),
        packageType: z.string().trim().max(40).nullable().optional(),
        reason: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    await loadShipmentWarehouse(req, id);
    return orgTx(req, (tx) => updateShipmentInfo(tx, id, body));
  });

  app.post('/api/shipments/:id/confirm', { preHandler: perm('shipments.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ shippedAt: z.iso.datetime({ offset: true }).optional() }), req.body ?? {});
    await loadShipmentWarehouse(req, id);
    return orgTx(req, (tx) => confirmShipment(tx, id, body, { requireTracking: requireTracking(req) }), { retries: 3 });
  });

  /** まとめて出荷確定（荷物ごとに独立したトランザクション。失敗した荷物は結果に理由を返す） */
  app.post('/api/shipments/bulk-confirm', { preHandler: perm('shipments.manage') }, async (req) => {
    const body = parse(z.object({ shipmentIds: z.array(z.uuid()).min(1).max(200), shippedAt: z.iso.datetime({ offset: true }).optional() }), req.body);
    const results: { shipmentId: string; ok: boolean; shipmentNumber?: string; alreadyShipped?: boolean; error?: string; code?: string }[] = [];
    for (const shipmentId of [...new Set(body.shipmentIds)]) {
      try {
        await loadShipmentWarehouse(req, shipmentId);
        const r = await orgTx(req, (tx) => confirmShipment(tx, shipmentId, { shippedAt: body.shippedAt }, { requireTracking: requireTracking(req) }), { retries: 3 });
        results.push({ shipmentId, ok: true, shipmentNumber: r.shipmentNumber, alreadyShipped: r.alreadyShipped });
      } catch (e) {
        results.push({ shipmentId, ok: false, error: e instanceof AppError ? e.message : '出荷確定に失敗しました', code: e instanceof AppError ? e.code : 'ERROR' });
      }
    }
    return { confirmed: results.filter((r) => r.ok && !r.alreadyShipped).length, failed: results.filter((r) => !r.ok).length, results };
  });

  /** scan 出荷: 荷物コード（SH-）+ 追跡番号バーコード → 追跡番号を保存して出荷確定（1 トランザクション） */
  app.post('/api/shipments/scan-confirm', { preHandler: perm('shipments.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({ shipmentCode: z.string().trim().min(1).max(40), trackingCode: z.string().trim().max(60).optional(), carrier: z.string().trim().max(40).optional(), noTracking: z.boolean().optional() }),
      req.body,
    );
    const id = await orgTx(req, async (tx) => {
      const s = await tx.maybeOne(`SELECT id, warehouse_id FROM shipments WHERE organization_id = $1 AND shipment_number = $2`, [tx.orgId, body.shipmentCode.normalize('NFKC').toUpperCase()]);
      if (!s) throw notFound(`荷物 ${body.shipmentCode.slice(0, 20)}`);
      assertWarehouse(req, s.warehouse_id);
      return s.id as string;
    });
    return orgTx(
      req,
      async (tx) => {
        const cur = await tx.one(`SELECT status, carrier FROM shipments WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
        if (cur.status === 'draft') {
          const carrier = body.carrier ?? cur.carrier ?? auth.org.settings.shipping.defaultCarrier ?? null;
          if (!carrier) throw badRequest('CARRIER_REQUIRED', '配送会社を選択してください');
          await updateShipmentInfo(tx, id, { carrier, trackingNumber: body.noTracking ? null : (body.trackingCode ?? null), noTracking: body.noTracking ?? false });
        }
        return confirmShipment(tx, id, {}, { requireTracking: requireTracking(req) });
      },
      { retries: 3 },
    );
  });

  app.post('/api/shipments/tracking-import', { preHandler: perm('shipments.manage') }, async (req) => {
    const auth = requireOrg(req);
    const up = await readUpload(req);
    const encoding = up.fields.encoding === 'shift_jis' ? 'shift_jis' : 'utf-8';
    const apply = up.fields.dryRun === 'false';
    const confirm = up.fields.confirm === 'true';
    const { text } = decodeCsvBuffer(up.buffer, encoding);
    const csv = parseCsvText(text, { delimiter: ',', hasHeader: true, skipRows: 0 });
    if (csv.rows.length > 5000) throw badRequest('CSV_TOO_MANY_ROWS', '追跡番号 CSV は 1 回 5,000 行までです。分割してください');
    return orgTx(req, (tx) =>
      importTracking(tx, req.server.deps, csv, {
        apply,
        confirm,
        requireTracking: auth.org.settings.shipping.requireTracking,
        timeZone: auth.org.timezone,
        defaultCarrier: auth.org.settings.shipping.defaultCarrier,
        warehouseIds: auth.warehouseIds,
      }),
    );
  });
}
