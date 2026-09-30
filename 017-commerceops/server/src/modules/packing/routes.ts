import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/validate.js';
import {
  cancelPackSession,
  completePack,
  openPackSession,
  packCorrect,
  packNextBox,
  packScan,
  packSessionView,
  resolvePackTarget,
  unpackFulfillment,
  type PackScanResult,
} from './service.js';

const InputMethod = z.enum(['camera', 'scanner', 'manual']).optional();

export async function packingRoutes(app: FastifyInstance) {
  async function loadSessionWarehouse(req: FastifyRequest, sessionId: string) {
    return orgTx(req, async (tx) => {
      const s = await tx.maybeOne(`SELECT warehouse_id FROM pack_sessions WHERE organization_id = $1 AND id = $2`, [tx.orgId, sessionId]);
      if (!s) throw notFound('梱包セッション');
      assertWarehouse(req, s.warehouse_id);
      return s.warehouse_id as string;
    });
  }
  async function loadFulfillmentWarehouse(req: FastifyRequest, fulfillmentId: string) {
    return orgTx(req, async (tx) => {
      const f = await tx.maybeOne(`SELECT warehouse_id FROM fulfillments WHERE organization_id = $1 AND id = $2`, [tx.orgId, fulfillmentId]);
      if (!f) throw notFound('出荷作業');
      assertWarehouse(req, f.warehouse_id);
      return f.warehouse_id as string;
    });
  }
  const ttl = (req: FastifyRequest) => requireOrg(req).org.settings.assignment.claimTimeoutMinutes;
  /** 誤 scan は 422 + 共通エラー形式（結果フィールドも保持） */
  const scanReply = (r: PackScanResult) => (r.ok ? r : { ...r, error: { code: r.code, message: r.message } });

  /** 梱包待ち・梱包中の一覧（Packing Station のホーム） */
  app.get('/api/pack/queue', { preHandler: perm('pack.execute', 'fulfillment.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(z.object({ warehouseId: z.uuid().optional() }), req.query);
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    return orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT f.id, f.fulfillment_number, f.status, f.priority, f.due_at, f.shipping_method, f.fulfillment_type, o.order_number, w.code AS warehouse_code,
                wv.wave_number, s.id AS session_id, s.packer_user_id, u.name AS packer_name, s.claim_expires_at, s.started_at,
                (SELECT COALESCE(SUM(required_qty), 0)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id) AS units,
                (SELECT count(*)::int FROM fulfillment_items fi WHERE fi.organization_id = f.organization_id AND fi.fulfillment_id = f.id AND fi.required_qty > 0) AS lines
           FROM fulfillments f
           JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
           JOIN warehouses w ON w.organization_id = f.organization_id AND w.id = f.warehouse_id
           LEFT JOIN waves wv ON wv.organization_id = f.organization_id AND wv.id = f.wave_id
           LEFT JOIN pack_sessions s ON s.organization_id = f.organization_id AND s.fulfillment_id = f.id AND s.status = 'active'
           LEFT JOIN users u ON u.id = s.packer_user_id
          WHERE f.organization_id = $1 AND f.status IN ('picked', 'packing') AND NOT f.on_hold
            AND ($2::uuid IS NULL OR f.warehouse_id = $2) AND ($3::uuid[] IS NULL OR f.warehouse_id = ANY($3))
          ORDER BY (s.id IS NULL), f.priority DESC, f.due_at ASC NULLS LAST, f.created_at
          LIMIT 300`,
        [tx.orgId, q.warehouseId ?? null, auth.warehouseIds],
      );
      const recent = await tx.many(
        `SELECT s.id, s.completed_at, s.forced, s.mis_scan_count, f.id AS fulfillment_id, f.fulfillment_number, o.order_number,
                (SELECT count(*)::int FROM shipments sh WHERE sh.organization_id = s.organization_id AND sh.pack_session_id = s.id) AS boxes
           FROM pack_sessions s
           JOIN fulfillments f ON f.organization_id = s.organization_id AND f.id = s.fulfillment_id
           JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
          WHERE s.organization_id = $1 AND s.status = 'completed' AND s.packer_user_id = $2 AND s.completed_at > now() - interval '24 hours'
          ORDER BY s.completed_at DESC LIMIT 10`,
        [tx.orgId, auth.userId],
      );
      const now = Date.now();
      return {
        items: rows.map((r) => ({
          fulfillmentId: r.id,
          fulfillmentNumber: r.fulfillment_number,
          status: r.status,
          type: r.fulfillment_type,
          priority: r.priority,
          dueAt: r.due_at,
          shippingMethod: r.shipping_method,
          orderNumber: r.order_number,
          warehouseCode: r.warehouse_code,
          waveNumber: r.wave_number,
          units: r.units,
          lines: r.lines,
          session: r.session_id
            ? {
                id: r.session_id,
                packerName: r.packer_name,
                mine: r.packer_user_id === auth.userId,
                expired: !!r.claim_expires_at && new Date(r.claim_expires_at).getTime() < now,
                startedAt: r.started_at,
              }
            : null,
        })),
        recent: recent.map((r) => ({
          sessionId: r.id,
          fulfillmentId: r.fulfillment_id,
          fulfillmentNumber: r.fulfillment_number,
          orderNumber: r.order_number,
          completedAt: r.completed_at,
          forced: r.forced,
          misScanCount: r.mis_scan_count,
          boxes: r.boxes,
        })),
      };
    });
  });

  /** 注文番号 / 出荷作業番号（または fulfillmentId）で梱包を開始・再開 */
  app.post('/api/pack/open', { preHandler: perm('pack.execute') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z
        .object({ code: z.string().trim().min(1).max(64).optional(), fulfillmentId: z.uuid().optional(), takeover: z.boolean().optional() })
        .refine((b) => b.code || b.fulfillmentId, 'コードを入力してください'),
      req.body,
    );
    // 作業中の他人のセッションの引継ぎは管理者のみ（期限切れは誰でも引き継げる）
    if (body.takeover && !hasPerm(auth, 'fulfillment.manage')) throw forbidden('引継ぎは管理者のみ実行できます');
    const target = body.fulfillmentId
      ? { fulfillmentId: body.fulfillmentId }
      : await orgTx(req, (tx) => resolvePackTarget(tx, body.code!, auth.warehouseIds));
    if ('choices' in target) return { choices: target.choices };
    await loadFulfillmentWarehouse(req, target.fulfillmentId);
    return orgTx(req, (tx) => openPackSession(tx, target.fulfillmentId, auth.userId, ttl(req), { takeover: body.takeover }));
  });

  app.get('/api/pack/sessions/:id', { preHandler: perm('pack.execute', 'fulfillment.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadSessionWarehouse(req, id);
    return orgTx(req, (tx) => packSessionView(tx, id, { showShipTo: hasPerm(auth, 'orders.read_ship_to'), canForce: hasPerm(auth, 'pack.force_complete') }));
  });

  app.post('/api/pack/sessions/:id/scan', { preHandler: perm('pack.execute') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({ clientEventId: z.uuid(), code: z.string().trim().min(1).max(128), qty: z.number().int().min(1).max(10000).default(1), inputMethod: InputMethod }),
      req.body,
    );
    await loadSessionWarehouse(req, id);
    const r = await orgTx(req, (tx) => packScan(tx, id, auth.userId, body, ttl(req)), { retries: 3 });
    return reply.status(r.ok ? 200 : 422).send(scanReply(r));
  });

  app.post('/api/pack/sessions/:id/correct', { preHandler: perm('pack.execute') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ clientEventId: z.uuid(), fulfillmentItemId: z.uuid(), qty: z.number().int().min(1).max(10000).default(1) }), req.body);
    await loadSessionWarehouse(req, id);
    return orgTx(req, (tx) => packCorrect(tx, id, auth.userId, body, ttl(req)), { retries: 3 });
  });

  app.post('/api/pack/sessions/:id/next-box', { preHandler: perm('pack.execute') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ clientEventId: z.uuid() }), req.body);
    await loadSessionWarehouse(req, id);
    return orgTx(req, (tx) => packNextBox(tx, id, auth.userId, body, ttl(req)));
  });

  app.post('/api/pack/sessions/:id/complete', { preHandler: perm('pack.execute') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        requestId: z.uuid(),
        force: z.boolean().optional(),
        reason: z.string().trim().max(300).optional(),
        packageType: z.string().trim().max(40).optional(),
        weightG: z.number().int().min(0).max(1_000_000).optional(),
      }),
      req.body,
    );
    await loadSessionWarehouse(req, id);
    return orgTx(
      req,
      (tx) =>
        completePack(tx, req.server.deps, id, auth.userId, body, {
          canForce: hasPerm(auth, 'pack.force_complete'),
          ttlMinutes: ttl(req),
          defaultCarrier: auth.org.settings.shipping.defaultCarrier,
        }),
      { retries: 3 },
    );
  });

  app.post('/api/pack/sessions/:id/cancel', { preHandler: perm('pack.execute', 'fulfillment.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, '理由を入力してください').max(300) }), req.body);
    await loadSessionWarehouse(req, id);
    return orgTx(req, (tx) => cancelPackSession(tx, id, auth.userId, body, hasPerm(auth, 'fulfillment.manage')));
  });

  /** 梱包済み・未出荷を再梱包できる状態へ戻す */
  app.post('/api/fulfillments/:id/unpack', { preHandler: perm('pack.execute', 'fulfillment.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, '理由を入力してください').max(300) }), req.body);
    await loadFulfillmentWarehouse(req, id);
    return orgTx(req, (tx) => unpackFulfillment(tx, id, body));
  });

  /** 納品書（Packing Slip）用データ。住所は orders.read_ship_to 保持者のみ */
  app.get('/api/fulfillments/:id/packing-slip', { preHandler: perm('pack.execute', 'fulfillment.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadFulfillmentWarehouse(req, id);
    return orgTx(req, async (tx) => {
      const f = await tx.one(
        `SELECT f.fulfillment_number, f.shipping_method, f.status, o.order_number, o.order_date, o.external_order_id, o.shipping_method AS order_shipping_method,
                o.recipient_name, o.postal_code, o.prefecture, o.city, o.address1, o.address2, c.name AS channel_name, org.name AS organization_name
           FROM fulfillments f
           JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
           JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
           JOIN organizations org ON org.id = f.organization_id
          WHERE f.organization_id = $1 AND f.id = $2`,
        [tx.orgId, id],
      );
      const items = await tx.many(
        `SELECT fi.required_qty, oi.sku, oi.product_name, oi.variant FROM fulfillment_items fi
           JOIN order_items oi ON oi.organization_id = fi.organization_id AND oi.id = fi.order_item_id
          WHERE fi.organization_id = $1 AND fi.fulfillment_id = $2 AND fi.required_qty > 0 ORDER BY oi.line_no`,
        [tx.orgId, id],
      );
      const ships = await tx.many(
        `SELECT shipment_number, box_no FROM shipments WHERE organization_id = $1 AND fulfillment_id = $2 AND status <> 'cancelled' ORDER BY box_no`,
        [tx.orgId, id],
      );
      const showShipTo = hasPerm(auth, 'orders.read_ship_to');
      return {
        organizationName: f.organization_name,
        orderNumber: f.order_number,
        externalOrderId: f.external_order_id,
        channelName: f.channel_name,
        orderDate: f.order_date,
        fulfillmentNumber: f.fulfillment_number,
        shippingMethod: f.shipping_method ?? f.order_shipping_method,
        shipTo: showShipTo
          ? { name: f.recipient_name, postalCode: f.postal_code, prefecture: f.prefecture, city: f.city, address1: f.address1, address2: f.address2 }
          : undefined,
        items: items.map((i) => ({ sku: i.sku, name: i.product_name, variant: i.variant, quantity: i.required_qty })),
        shipments: ships.map((s) => ({ shipmentNumber: s.shipment_number, boxNo: s.box_no })),
      };
    });
  });
}
