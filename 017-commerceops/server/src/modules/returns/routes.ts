import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, canAccessWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/hash.js';
import { readUpload } from '../../lib/upload.js';
import { uuidv7 } from '../../lib/uuid.js';
import { cappedCount } from '../../lib/pagination.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { createExchange, createReturn, DISPOSITIONS, inspectReturn, receiveReturn, RETURN_REASONS, returnableItems, transitionReturn } from './service.js';

const STATUS_GROUPS: Record<string, string[]> = {
  open: ['requested', 'authorized', 'in_transit', 'received', 'inspecting'],
  to_authorize: ['requested'],
  to_receive: ['authorized', 'in_transit'],
  to_inspect: ['received', 'inspecting'],
  done: ['completed', 'rejected', 'cancelled'],
};

/** 画像の実体（マジックバイト）で種類を判定。SVG 等は受け付けない */
function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function returnRoutes(app: FastifyInstance) {
  const readPerms = perm('returns.read', 'returns.receive', 'returns.inspect');

  /** 返品の倉庫スコープ: 倉庫未定の返品は全員に見える。倉庫が決まっていれば担当者のみ */
  async function loadReturnScope(req: FastifyRequest, id: string) {
    const auth = requireOrg(req);
    return orgTx(req, async (tx) => {
      const r = await tx.maybeOne(`SELECT id, warehouse_id, status FROM returns WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!r) throw notFound('返品');
      if (r.warehouse_id && !canAccessWarehouse(auth, r.warehouse_id)) throw forbidden('この倉庫の返品へのアクセス権限がありません');
      return r as { id: string; warehouse_id: string | null; status: string };
    });
  }

  app.get('/api/returns', { preHandler: readPerms }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(zPage.extend({ status: z.string().max(20).optional(), q: z.string().trim().max(60).optional(), warehouseId: z.uuid().optional() }), req.query);
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    const statuses = q.status ? (STATUS_GROUPS[q.status] ?? [q.status]) : null;
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, statuses, q.q?.toUpperCase() ?? null, q.warehouseId ?? null, auth.warehouseIds];
      const where = `r.organization_id = $1 AND ($2::text[] IS NULL OR r.status = ANY($2))
        AND ($3::text IS NULL OR r.return_number = $3 OR o.order_number = $3 OR upper(o.external_order_id) = $3)
        AND ($4::uuid IS NULL OR r.warehouse_id = $4) AND ($5::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($5))`;
      const { total, totalCapped } = await cappedCount(tx, `FROM returns r JOIN orders o ON o.organization_id = r.organization_id AND o.id = r.order_id WHERE ${where}`, params);
      const counts = await tx.many(
        `SELECT r.status, count(*)::int AS n FROM returns r WHERE r.organization_id = $1 AND ($2::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($2)) GROUP BY r.status`,
        [tx.orgId, auth.warehouseIds],
      );
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `SELECT r.*, o.order_number, o.external_order_id, c.name AS channel_name, w.code AS warehouse_code,
                (SELECT COALESCE(SUM(requested_qty), 0)::int FROM return_items ri WHERE ri.organization_id = r.organization_id AND ri.return_id = r.id) AS requested,
                (SELECT COALESCE(SUM(received_qty), 0)::int FROM return_items ri WHERE ri.organization_id = r.organization_id AND ri.return_id = r.id) AS received,
                (SELECT COALESCE(SUM(inspected_qty), 0)::int FROM return_items ri WHERE ri.organization_id = r.organization_id AND ri.return_id = r.id) AS inspected,
                (SELECT exchange_number FROM exchanges e WHERE e.organization_id = r.organization_id AND e.return_id = r.id AND e.status <> 'cancelled' LIMIT 1) AS exchange_number
           FROM returns r
           JOIN orders o ON o.organization_id = r.organization_id AND o.id = r.order_id
           JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
           LEFT JOIN warehouses w ON w.organization_id = r.organization_id AND w.id = r.warehouse_id
          WHERE ${where}
          ORDER BY r.created_at DESC LIMIT $6 OFFSET $7`,
        params,
      );
      const count = (keys: string[]) => counts.filter((c) => keys.includes(c.status)).reduce((s, c) => s + c.n, 0);
      return {
        total,
        totalCapped,
        counts: Object.fromEntries(Object.entries(STATUS_GROUPS).map(([k, v]) => [k, count(v)])),
        items: rows.map((r) => ({
          id: r.id,
          returnNumber: r.return_number,
          orderId: r.order_id,
          orderNumber: r.order_number,
          externalOrderId: r.external_order_id,
          channelName: r.channel_name,
          warehouseCode: r.warehouse_code,
          status: r.status,
          reasonCode: r.reason_code,
          requested: r.requested,
          received: r.received,
          inspected: r.inspected,
          exchangeNumber: r.exchange_number,
          requestedAt: r.requested_at,
          receivedAt: r.received_at,
          completedAt: r.completed_at,
        })),
      };
    });
  });

  /** 到着 scan 用: RMA コード（RT-）または注文番号から未完了の返品を探す */
  app.get('/api/returns/lookup', { preHandler: readPerms }, async (req) => {
    const auth = requireOrg(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(60) }), req.query);
    return orgTx(req, async (tx) => {
      const c = code.normalize('NFKC').toUpperCase();
      const rows = await tx.many(
        `SELECT r.id, r.return_number, r.status, o.order_number FROM returns r JOIN orders o ON o.organization_id = r.organization_id AND o.id = r.order_id
          WHERE r.organization_id = $1 AND (r.return_number = $2 OR o.order_number = $2 OR upper(o.external_order_id) = $2)
            AND ($3::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($3))
          ORDER BY (r.status IN ('completed', 'rejected', 'cancelled')), r.created_at DESC LIMIT 20`,
        [tx.orgId, c, auth.warehouseIds],
      );
      return { items: rows.map((r) => ({ id: r.id, returnNumber: r.return_number, status: r.status, orderNumber: r.order_number })) };
    });
  });

  app.get('/api/returns/:id', { preHandler: readPerms }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadReturnScope(req, id);
    return orgTx(req, async (tx) => {
      const r = await tx.one(
        `SELECT r.*, o.order_number, o.external_order_id, o.status AS order_status, c.name AS channel_name, w.code AS warehouse_code, w.name AS warehouse_name, w.postal_code AS warehouse_postal_code, w.address AS warehouse_address,
                s.shipment_number, s.tracking_number AS shipment_tracking,
                ur.name AS requested_by_name, ua.name AS authorized_by_name, urc.name AS received_by_name, urj.name AS rejected_by_name, uc.name AS cancelled_by_name
           FROM returns r
           JOIN orders o ON o.organization_id = r.organization_id AND o.id = r.order_id
           JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
           LEFT JOIN warehouses w ON w.organization_id = r.organization_id AND w.id = r.warehouse_id
           LEFT JOIN shipments s ON s.organization_id = r.organization_id AND s.id = r.shipment_id
           LEFT JOIN users ur ON ur.id = r.requested_by
           LEFT JOIN users ua ON ua.id = r.authorized_by
           LEFT JOIN users urc ON urc.id = r.received_by
           LEFT JOIN users urj ON urj.id = r.rejected_by
           LEFT JOIN users uc ON uc.id = r.cancelled_by
          WHERE r.organization_id = $1 AND r.id = $2`,
        [tx.orgId, id],
      );
      const items = await tx.many(
        `SELECT ri.*, oi.sku, oi.product_name, oi.variant, oi.shipped_qty FROM return_items ri
           JOIN order_items oi ON oi.organization_id = ri.organization_id AND oi.id = ri.order_item_id
          WHERE ri.organization_id = $1 AND ri.return_id = $2 ORDER BY oi.line_no`,
        [tx.orgId, id],
      );
      const inspections = await tx.many(
        `SELECT ins.*, l.code AS location_code, u.name AS inspector_name, oi.sku FROM return_inspections ins
           JOIN return_items ri ON ri.organization_id = ins.organization_id AND ri.id = ins.return_item_id
           JOIN order_items oi ON oi.organization_id = ri.organization_id AND oi.id = ri.order_item_id
           LEFT JOIN locations l ON l.organization_id = ins.organization_id AND l.id = ins.location_id
           LEFT JOIN users u ON u.id = ins.inspector_user_id
          WHERE ins.organization_id = $1 AND ins.return_id = $2 ORDER BY ins.inspected_at, ins.line_index`,
        [tx.orgId, id],
      );
      const exchanges = await tx.many(
        `SELECT e.*, ro.order_number AS replacement_order_number, ro.status AS replacement_status FROM exchanges e
           LEFT JOIN orders ro ON ro.organization_id = e.organization_id AND ro.id = e.replacement_order_id
          WHERE e.organization_id = $1 AND e.return_id = $2 ORDER BY e.created_at`,
        [tx.orgId, id],
      );
      const exItems = await tx.many(
        `SELECT ei.exchange_id, ei.quantity, p.sku, p.name FROM exchange_items ei JOIN products p ON p.organization_id = ei.organization_id AND p.id = ei.product_id
          WHERE ei.organization_id = $1 AND ei.exchange_id = ANY($2)`,
        [tx.orgId, exchanges.map((e) => e.id)],
      );
      const photos = await tx.many(`SELECT id, filename, content_type, created_at FROM attachments WHERE organization_id = $1 AND entity_type = 'return' AND entity_id = $2 ORDER BY created_at`, [
        tx.orgId,
        id,
      ]);
      const detailed = hasPerm(auth, 'returns.read');
      return {
        id: r.id,
        returnNumber: r.return_number,
        status: r.status,
        reasonCode: r.reason_code,
        customerNote: detailed ? r.customer_note : undefined,
        internalNote: detailed || hasPerm(auth, 'returns.inspect') ? r.internal_note : undefined,
        orderId: r.order_id,
        orderNumber: r.order_number,
        externalOrderId: r.external_order_id,
        orderStatus: r.order_status,
        channelName: r.channel_name,
        shipmentNumber: r.shipment_number,
        warehouseId: r.warehouse_id,
        warehouseCode: r.warehouse_code,
        warehouseName: r.warehouse_name,
        warehouseAddress: r.warehouse_address ? `〒${r.warehouse_postal_code ?? ''} ${r.warehouse_address}` : null,
        returnCarrier: r.return_carrier,
        returnTrackingNumber: r.return_tracking_number,
        timeline: [
          { key: 'requested', at: r.requested_at, by: r.requested_by_name },
          r.authorized_at && { key: 'authorized', at: r.authorized_at, by: r.authorized_by_name },
          r.in_transit_at && { key: 'in_transit', at: r.in_transit_at },
          r.received_at && { key: 'received', at: r.received_at, by: r.received_by_name },
          r.inspection_started_at && { key: 'inspecting', at: r.inspection_started_at },
          r.completed_at && { key: 'completed', at: r.completed_at },
          r.rejected_at && { key: 'rejected', at: r.rejected_at, by: r.rejected_by_name, note: r.reject_reason },
          r.cancelled_at && { key: 'cancelled', at: r.cancelled_at, by: r.cancelled_by_name, note: r.cancel_reason },
        ].filter(Boolean),
        items: items.map((i) => ({
          id: i.id,
          orderItemId: i.order_item_id,
          productId: i.product_id,
          sku: i.sku,
          name: i.product_name,
          variant: i.variant,
          reasonCode: i.reason_code,
          requestedQty: i.requested_qty,
          receivedQty: i.received_qty,
          inspectedQty: i.inspected_qty,
        })),
        inspections: inspections.map((x) => ({
          id: x.id,
          returnItemId: x.return_item_id,
          sku: x.sku,
          disposition: x.disposition,
          qty: x.qty,
          locationCode: x.location_code,
          inspector: x.inspector_name,
          inspectedAt: x.inspected_at,
          reason: x.reason,
          note: x.note,
          attachmentIds: x.attachment_ids,
        })),
        exchanges: exchanges.map((e) => ({
          id: e.id,
          exchangeNumber: e.exchange_number,
          status: e.status,
          note: e.note,
          replacementOrderId: e.replacement_order_id,
          replacementOrderNumber: e.replacement_order_number,
          replacementStatus: e.replacement_status,
          items: exItems.filter((x) => x.exchange_id === e.id).map((x) => ({ sku: x.sku, name: x.name, quantity: x.quantity })),
          createdAt: e.created_at,
        })),
        photos: photos.map((p) => ({ id: p.id, filename: p.filename, contentType: p.content_type, createdAt: p.created_at })),
      };
    });
  });

  app.get('/api/orders/:id/returnable', { preHandler: perm('returns.request') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const o = await tx.maybeOne(`SELECT id, order_number, status, order_type FROM orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!o) throw notFound('注文');
      const items = await returnableItems(tx, id);
      const shipments = await tx.many(
        `SELECT id, shipment_number, box_no, shipped_at FROM shipments WHERE organization_id = $1 AND order_id = $2 AND status = 'shipped' ORDER BY shipped_at`,
        [tx.orgId, id],
      );
      return {
        orderId: o.id,
        orderNumber: o.order_number,
        orderStatus: o.status,
        orderType: o.order_type,
        items: items.map((i) => ({
          orderItemId: i.id,
          sku: i.sku,
          name: i.product_name,
          variant: i.variant,
          quantity: i.quantity,
          shippedQty: i.shipped_qty,
          returnedQty: i.returned_qty,
          returnableQty: Math.max(0, i.shipped_qty - i.returned_qty),
        })),
        shipments: shipments.map((s) => ({ id: s.id, shipmentNumber: s.shipment_number, boxNo: s.box_no, shippedAt: s.shipped_at })),
      };
    });
  });

  app.post('/api/returns', { preHandler: perm('returns.request') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({
        orderId: z.uuid(),
        shipmentId: z.uuid().nullable().optional(),
        reasonCode: z.enum(RETURN_REASONS),
        customerNote: z.string().trim().max(1000).nullable().optional(),
        internalNote: z.string().trim().max(1000).nullable().optional(),
        items: z.array(z.object({ orderItemId: z.uuid(), qty: z.number().int().min(1).max(100000), reasonCode: z.enum(RETURN_REASONS).optional() })).min(1).max(200),
      }),
      req.body,
    );
    return orgTx(req, (tx) => createReturn(tx, req.server.deps, body, auth.warehouseIds));
  });

  for (const [path, action] of [
    ['authorize', 'authorize'],
    ['reject', 'reject'],
    ['cancel', 'cancel'],
    ['in-transit', 'in_transit'],
  ] as const) {
    app.post(`/api/returns/:id/${path}`, { preHandler: perm('returns.request') }, async (req) => {
      const { id } = parse(IdParams, req.params);
      const body = parse(
        z.object({ reason: z.string().trim().max(300).optional(), carrier: z.string().trim().max(40).optional(), trackingNumber: z.string().trim().max(60).optional() }),
        req.body ?? {},
      );
      await loadReturnScope(req, id);
      return orgTx(req, (tx) => transitionReturn(tx, id, action, body));
    });
  }

  app.post('/api/returns/:id/receive', { preHandler: perm('returns.receive') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        warehouseId: z.uuid(),
        items: z.array(z.object({ returnItemId: z.uuid(), receivedQty: z.number().int().min(0).max(100000) })).min(1).max(200),
        unexpected: z.string().trim().max(300).nullable().optional(),
        note: z.string().trim().max(300).nullable().optional(),
      }),
      req.body,
    );
    await loadReturnScope(req, id);
    // 到着した倉庫で受け付ける（予定と違う倉庫に届いた場合も、記録上の倉庫を到着倉庫にする）
    assertWarehouse(req, body.warehouseId);
    return orgTx(req, (tx) => receiveReturn(tx, req.server.deps, id, body));
  });

  app.post('/api/returns/:id/inspect', { preHandler: perm('returns.inspect') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        clientRequestId: z.uuid(),
        lines: z
          .array(
            z.object({
              returnItemId: z.uuid(),
              disposition: z.enum(DISPOSITIONS),
              qty: z.number().int().min(1).max(100000),
              locationId: z.uuid().nullable().optional(),
              reason: z.string().trim().max(300).nullable().optional(),
              note: z.string().trim().max(500).nullable().optional(),
            }),
          )
          .min(1)
          .max(100),
        attachmentIds: z.array(z.uuid()).max(20).optional(),
      }),
      req.body,
    );
    const r = await loadReturnScope(req, id);
    if (r.warehouse_id) assertWarehouse(req, r.warehouse_id);
    return orgTx(req, (tx) => inspectReturn(tx, id, body), { retries: 3 });
  });

  app.post('/api/returns/:id/exchange', { preHandler: perm('exchanges.create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        items: z.array(z.object({ sku: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(10000), originalOrderItemId: z.uuid().nullable().optional() })).min(1).max(100),
        note: z.string().trim().max(500).nullable().optional(),
        allocateNow: z.boolean().default(true),
      }),
      req.body,
    );
    await loadReturnScope(req, id);
    return orgTx(req, (tx) =>
      createExchange(tx, req.server.deps, id, body, {
        allowPartial: auth.org.settings.allocation.allowPartialAllocation,
        autoRelease: auth.org.settings.allocation.autoReleaseFullyAllocated,
      }),
    );
  });

  /** 検品写真のアップロード（JPEG / PNG / WebP のみ。実体で判定。外部の画像認識サービスには送らない） */
  app.post('/api/returns/:id/attachments', { preHandler: perm('returns.inspect', 'returns.receive') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const r = await loadReturnScope(req, id);
    if (['completed', 'rejected', 'cancelled'].includes(r.status)) throw conflict('RETURN_CLOSED', '完了・却下・取消済みの返品には写真を追加できません');
    const up = await readUpload(req);
    const type = sniffImage(up.buffer);
    if (!type) throw badRequest('UNSUPPORTED_FILE', '写真は JPEG / PNG / WebP のみアップロードできます');
    if (up.buffer.length > 10 * 1024 * 1024) throw badRequest('FILE_TOO_LARGE', '写真は 10MB までです');
    const attId = uuidv7();
    const key = `${auth.org.id}/${attId}`;
    const filename = up.filename.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100) || 'photo';
    await orgTx(req, async (tx) => {
      const n = await tx.one(`SELECT count(*)::int AS n FROM attachments WHERE organization_id = $1 AND entity_type = 'return' AND entity_id = $2`, [tx.orgId, id]);
      if (n.n >= 20) throw conflict('TOO_MANY_PHOTOS', '1 件の返品に添付できる写真は 20 枚までです');
    });
    await req.server.deps.storage.put(key, up.buffer, type);
    try {
      await orgTx(req, async (tx) => {
        await tx.exec(
          `INSERT INTO attachments (organization_id, id, storage_key, filename, content_type, size_bytes, sha256, entity_type, entity_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'return', $8, $9)`,
          [tx.orgId, attId, key, filename, type, up.buffer.length, sha256Hex(up.buffer), id, auth.userId],
        );
        await audit(tx, { action: 'return.photo_upload', entityType: 'return', entityId: id, metadata: { attachmentId: attId, bytes: up.buffer.length, type } });
      });
    } catch (e) {
      await req.server.deps.storage.delete(key).catch(() => undefined);
      throw e;
    }
    return { id: attId, contentType: type };
  });

  app.get('/api/attachments/:id', { preHandler: readPerms }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const a = await orgTx(req, async (tx) => {
      const row = await tx.maybeOne(
        `SELECT a.*, r.warehouse_id FROM attachments a LEFT JOIN returns r ON r.organization_id = a.organization_id AND r.id = a.entity_id AND a.entity_type = 'return'
          WHERE a.organization_id = $1 AND a.id = $2`,
        [tx.orgId, id],
      );
      if (!row) throw notFound('写真');
      if (row.warehouse_id && !canAccessWarehouse(auth, row.warehouse_id)) throw forbidden();
      return row;
    });
    const data = await req.server.deps.storage.get(a.storage_key);
    if (!data) throw notFound('写真');
    reply.header('content-type', a.content_type);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    reply.header('cache-control', 'private, max-age=300');
    reply.header('content-disposition', `inline; filename="${a.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`);
    return reply.send(data);
  });
}
