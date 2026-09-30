import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { AddressSchema, NormalizedOrderSchema } from './normalized.js';
import { piiLevel, presentOrder, presentOrderListRow } from './present.js';
import { changeShippingAddress, createOrders, HOLD_REASONS, placeHold, releaseHold, remapOrderItem, revalidateOrderRow } from './service.js';
import { ORDER_STATUSES } from './status.js';

const ListQuery = zPage.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  statusGroup: z.enum(['open', 'all']).default('all'),
  channelId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  orderType: z.enum(['standard', 'replacement']).optional(),
  sort: z.enum(['order_date_desc', 'order_date_asc', 'priority']).default('order_date_desc'),
});

/** 関数の配列を順番に実行して結果を返す */
async function sequential<T extends unknown[]>(fns: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
  const out: unknown[] = [];
  for (const f of fns as (() => Promise<unknown>)[]) out.push(await f());
  return out as T;
}

export async function orderRoutes(app: FastifyInstance) {
  app.get('/api/orders', { preHandler: perm('orders.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(ListQuery, req.query);
    const level = piiLevel(auth);
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId];
      const where: string[] = ['o.organization_id = $1'];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.status) add('o.status = ?', q.status);
      if (q.statusGroup === 'open') where.push(`o.status NOT IN ('shipped', 'cancelled', 'closed')`);
      if (q.channelId) add('o.channel_id = ?', q.channelId);
      if (q.orderType) add('o.order_type = ?', q.orderType);
      const tz = auth.org.timezone;
      if (q.from) {
        params.push(q.from, tz);
        where.push(`o.order_date >= ($${params.length - 1}::date::timestamp AT TIME ZONE $${params.length})`);
      }
      if (q.to) {
        params.push(q.to, tz);
        where.push(`o.order_date < (($${params.length - 1}::date + 1)::timestamp AT TIME ZONE $${params.length})`);
      }
      if (q.q) {
        params.push(q.q);
        const i = params.length;
        // 個人情報での検索は read_pii 保持者のみ
        const piiClause = level === 'full' ? ` OR o.recipient_name ILIKE '%' || $${i} || '%' OR o.customer_name ILIKE '%' || $${i} || '%' OR o.postal_code = $${i}` : '';
        where.push(
          `(o.order_number = $${i} OR o.external_order_id = $${i} OR o.external_order_id ILIKE $${i} || '%'
            OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.organization_id = o.organization_id AND oi.order_id = o.id AND oi.sku = $${i})${piiClause})`,
        );
      }
      const order =
        q.sort === 'order_date_asc' ? 'o.order_date ASC, o.id ASC' : q.sort === 'priority' ? 'o.priority DESC, o.order_date ASC' : 'o.order_date DESC, o.id DESC';
      const whereSql = where.join(' AND ');
      const total = (await tx.one(`SELECT count(*)::int AS n FROM orders o WHERE ${whereSql}`, params)).n;
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `SELECT o.*, c.name AS channel_name,
                (SELECT count(*)::int FROM order_items oi WHERE oi.organization_id = o.organization_id AND oi.order_id = o.id) AS item_count
           FROM orders o JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
          WHERE ${whereSql}
          ORDER BY ${order}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { items: rows.map((r) => presentOrderListRow(r, level)), total };
    });
  });

  app.get('/api/orders/status-counts', { preHandler: perm('orders.read') }, async (req) => {
    return orgTx(req, async (tx) => {
      const rows = await tx.many(`SELECT status, count(*)::int AS n FROM orders WHERE organization_id = $1 GROUP BY status`, [tx.orgId]);
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    });
  });

  app.get('/api/orders/:id', { preHandler: perm('orders.read') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const level = piiLevel(auth);
    return orgTx(req, async (tx) => {
      const o = await tx.maybeOne(
        `SELECT o.*, c.name AS channel_name FROM orders o JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
          WHERE o.organization_id = $1 AND o.id = $2`,
        [tx.orgId, id],
      );
      if (!o) throw notFound('注文');
      // 同一トランザクションの接続でクエリを並列実行しない（pg は直列化するが非推奨）
      const [items, allocations, fulfillments, ffItems, shipments, shipmentItems, returns, holds, history, addressHistory, exceptions, related] = await sequential([
        () => tx.many(`SELECT * FROM order_items WHERE organization_id = $1 AND order_id = $2 ORDER BY line_no`, [tx.orgId, id]),
        () => tx.many(
          `SELECT a.*, w.code AS warehouse_code, l.code AS location_code FROM allocations a
             JOIN warehouses w ON w.organization_id = a.organization_id AND w.id = a.warehouse_id
             JOIN locations l ON l.organization_id = a.organization_id AND l.id = a.location_id
            WHERE a.organization_id = $1 AND a.order_id = $2 ORDER BY a.created_at`,
          [tx.orgId, id],
        ),
        () => tx.many(
          `SELECT f.*, w.code AS warehouse_code, w.name AS warehouse_name, wv.wave_number FROM fulfillments f
             JOIN warehouses w ON w.organization_id = f.organization_id AND w.id = f.warehouse_id
             LEFT JOIN waves wv ON wv.organization_id = f.organization_id AND wv.id = f.wave_id
            WHERE f.organization_id = $1 AND f.order_id = $2 ORDER BY f.created_at`,
          [tx.orgId, id],
        ),
        () => tx.many(
          `SELECT fi.* FROM fulfillment_items fi JOIN fulfillments f ON f.organization_id = fi.organization_id AND f.id = fi.fulfillment_id
            WHERE fi.organization_id = $1 AND f.order_id = $2`,
          [tx.orgId, id],
        ),
        () => tx.many(`SELECT * FROM shipments WHERE organization_id = $1 AND order_id = $2 ORDER BY created_at`, [tx.orgId, id]),
        () => tx.many(
          `SELECT si.* FROM shipment_items si JOIN shipments s ON s.organization_id = si.organization_id AND s.id = si.shipment_id
            WHERE si.organization_id = $1 AND s.order_id = $2`,
          [tx.orgId, id],
        ),
        () => tx.many(`SELECT id, return_number, status, reason_code, requested_at, completed_at FROM returns WHERE organization_id = $1 AND order_id = $2 ORDER BY requested_at`, [tx.orgId, id]),
        () => tx.many(
          `SELECT h.*, pu.name AS placed_by_name, ru.name AS released_by_name FROM holds h
             LEFT JOIN users pu ON pu.id = h.placed_by LEFT JOIN users ru ON ru.id = h.released_by
            WHERE h.organization_id = $1 AND h.order_id = $2 ORDER BY h.placed_at`,
          [tx.orgId, id],
        ),
        () => tx.many(
          `SELECT h.*, u.name AS actor_name FROM order_status_history h LEFT JOIN users u ON u.id = h.actor_user_id
            WHERE h.organization_id = $1 AND h.order_id = $2 ORDER BY h.created_at, h.id`,
          [tx.orgId, id],
        ),
        level === 'full'
          ? () => tx.many(
              `SELECT h.*, u.name AS actor_name FROM order_address_history h LEFT JOIN users u ON u.id = h.changed_by
                WHERE h.organization_id = $1 AND h.order_id = $2 ORDER BY h.created_at`,
              [tx.orgId, id],
            )
          : () => Promise.resolve([]),
        hasPerm(auth, 'exceptions.read')
          ? () => tx.many(`SELECT id, exception_number, type, status, title, created_at FROM exception_cases WHERE organization_id = $1 AND order_id = $2 ORDER BY created_at DESC`, [tx.orgId, id])
          : () => Promise.resolve([]),
        () => tx.many(
          `SELECT id, order_number, order_type, status FROM orders WHERE organization_id = $1 AND (source_order_id = $2 OR id = $3) AND id <> $2`,
          [tx.orgId, id, o.source_order_id],
        ),
      ]);
      return {
        ...presentOrder(o, level),
        items: items.map((i) => ({
          id: i.id,
          lineNo: i.line_no,
          sku: i.sku,
          productId: i.product_id,
          productName: i.product_name,
          variant: i.variant,
          quantity: i.quantity,
          cancelledQty: i.cancelled_qty,
          allocatedQty: i.allocated_qty,
          shippedQty: i.shipped_qty,
          unitPrice: i.unit_price,
          allocationStatus: i.allocation_status,
        })),
        allocations: allocations.map((a) => ({
          id: a.id,
          orderItemId: a.order_item_id,
          warehouseCode: a.warehouse_code,
          locationCode: a.location_code,
          quantity: a.quantity,
          shippedQty: a.shipped_qty,
          releasedQty: a.released_qty,
          status: a.status,
          reason: a.reason,
          fulfillmentId: a.fulfillment_id,
          createdAt: a.created_at,
          releaseReason: a.release_reason,
        })),
        fulfillments: fulfillments.map((f) => ({
          id: f.id,
          fulfillmentNumber: f.fulfillment_number,
          warehouseId: f.warehouse_id,
          warehouseCode: f.warehouse_code,
          warehouseName: f.warehouse_name,
          type: f.fulfillment_type,
          status: f.status,
          onHold: f.on_hold,
          hasShort: f.has_short,
          waveId: f.wave_id,
          waveNumber: f.wave_number,
          dueAt: f.due_at,
          createdAt: f.created_at,
          items: ffItems
            .filter((x) => x.fulfillment_id === f.id)
            .map((x) => ({
              id: x.id,
              orderItemId: x.order_item_id,
              requiredQty: x.required_qty,
              pickedQty: x.picked_qty,
              shortQty: x.short_qty,
              packedQty: x.packed_qty,
              shippedQty: x.shipped_qty,
            })),
        })),
        shipments: shipments.map((s) => ({
          id: s.id,
          shipmentNumber: s.shipment_number,
          fulfillmentId: s.fulfillment_id,
          boxNo: s.box_no,
          carrier: s.carrier,
          service: s.service,
          trackingNumber: s.tracking_number,
          noTracking: s.no_tracking,
          status: s.status,
          shippedAt: s.shipped_at,
          items: shipmentItems.filter((x) => x.shipment_id === s.id).map((x) => ({ orderItemId: x.order_item_id, quantity: x.quantity })),
        })),
        returns: returns.map((r) => ({ id: r.id, returnNumber: r.return_number, status: r.status, reasonCode: r.reason_code, requestedAt: r.requested_at, completedAt: r.completed_at })),
        holds: holds.map((h) => ({
          id: h.id,
          reasonCode: h.reason_code,
          note: h.note,
          placedBy: h.placed_by_name,
          placedAt: h.placed_at,
          releasedBy: h.released_by_name,
          releasedAt: h.released_at,
          releaseNote: h.release_note,
        })),
        statusHistory: history.map((h) => ({ from: h.from_status, to: h.to_status, reason: h.reason, actor: h.actor_name, at: h.created_at })),
        addressHistory: addressHistory.map((h) => ({ oldValue: h.old_value, newValue: h.new_value, reason: h.reason, actor: h.actor_name, at: h.created_at })),
        exceptions: exceptions.map((e) => ({ id: e.id, number: e.exception_number, type: e.type, status: e.status, title: e.title, createdAt: e.created_at })),
        relatedOrders: related.map((r) => ({ id: r.id, orderNumber: r.order_number, orderType: r.order_type, status: r.status })),
      };
    });
  });

  // 手動注文（電話・卸・手動チャネル）
  app.post('/api/orders', { preHandler: perm('orders.import') }, async (req) => {
    const body = parse(
      z.object({
        channelId: z.uuid(),
        order: NormalizedOrderSchema.omit({ cancelFlag: true }).extend({ orderDate: z.string().optional() }),
      }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      const ch = await tx.maybeOne(`SELECT id, active FROM sales_channels WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.channelId]);
      if (!ch) throw notFound('販売チャネル');
      if (!ch.active) throw conflict('CHANNEL_INACTIVE', 'このチャネルは無効です');
      const dup = await tx.maybeOne(`SELECT order_number FROM orders WHERE organization_id = $1 AND channel_id = $2 AND external_order_id = $3`, [
        tx.orgId,
        body.channelId,
        body.order.externalOrderId,
      ]);
      if (dup) throw conflict('DUPLICATE_ORDER', `外部注文番号 ${body.order.externalOrderId} は既に登録されています（${dup.order_number}）`);
      const orderDate = body.order.orderDate ? new Date(body.order.orderDate) : new Date();
      if (Number.isNaN(orderDate.getTime())) throw conflict('INVALID_DATE', '注文日時が不正です');
      const [created] = await createOrders(tx, req.server.deps, [
        { normalized: { ...body.order, orderDate: orderDate.toISOString(), cancelFlag: false }, channelId: body.channelId },
      ]);
      await audit(tx, { action: 'order.create_manual', entityType: 'order', entityId: created!.id, summary: `${created!.orderNumber} を手動作成` });
      return created;
    });
  });

  app.patch('/api/orders/:id', { preHandler: perm('orders.edit') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        priority: z.number().int().min(0).max(9).optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
        dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
      }),
      req.body,
    );
    await orgTx(req, async (tx) => {
      const o = await tx.maybeOne(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, id]);
      if (!o) throw notFound('注文');
      await tx.exec(
        `UPDATE orders SET priority = $3, notes = $4, due_at = $5, updated_at = now(), version = version + 1 WHERE organization_id = $1 AND id = $2`,
        [tx.orgId, id, body.priority ?? o.priority, body.notes !== undefined ? body.notes : o.notes, body.dueAt !== undefined ? body.dueAt : o.due_at],
      );
      if (body.priority !== undefined || body.dueAt !== undefined) {
        await tx.exec(
          `UPDATE fulfillments SET priority = $3, due_at = COALESCE($4, due_at), updated_at = now()
            WHERE organization_id = $1 AND order_id = $2 AND status NOT IN ('shipped', 'cancelled')`,
          [tx.orgId, id, body.priority ?? o.priority, body.dueAt ?? null],
        );
      }
      await audit(tx, { action: 'order.update', entityType: 'order', entityId: id, summary: `${o.order_number} を更新`, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  app.put('/api/orders/:id/address', { preHandler: perm('orders.edit') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(AddressSchema.extend({ reason: z.string().trim().min(1, '変更理由を入力してください').max(300) }), req.body);
    const { reason, ...addr } = body;
    return orgTx(req, (tx) => changeShippingAddress(tx, id, addr, reason));
  });

  app.post('/api/orders/:id/items/:itemId/remap', { preHandler: perm('orders.edit') }, async (req) => {
    const { id, itemId } = parse(z.object({ id: z.uuid(), itemId: z.uuid() }), req.params);
    const { productId } = parse(z.object({ productId: z.uuid() }), req.body);
    await orgTx(req, (tx) => remapOrderItem(tx, id, itemId, productId));
    return { ok: true };
  });

  app.post('/api/orders/:id/revalidate', { preHandler: perm('orders.edit') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, (tx) => revalidateOrderRow(tx, id));
  });

  app.post('/api/orders/:id/holds', { preHandler: perm('orders.hold') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({ reasonCode: z.enum(HOLD_REASONS), note: z.string().trim().max(500).optional().nullable(), confirm: z.boolean().default(false) }),
      req.body,
    );
    return orgTx(req, (tx) => placeHold(tx, id, body));
  });

  app.post('/api/orders/:id/holds/:holdId/release', { preHandler: perm('orders.hold') }, async (req) => {
    const { id, holdId } = parse(z.object({ id: z.uuid(), holdId: z.uuid() }), req.params);
    const body = parse(z.object({ note: z.string().trim().max(500).optional().nullable() }), req.body ?? {});
    return orgTx(req, (tx) => releaseHold(tx, id, holdId, body.note));
  });

  // ---------------- customers ----------------
  app.get('/api/customers/:id', { preHandler: perm('customers.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const c = await tx.maybeOne(`SELECT * FROM customers WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!c) throw notFound('顧客');
      const orders = await tx.many(
        `SELECT id, order_number, order_date, status FROM orders WHERE organization_id = $1 AND customer_id = $2 ORDER BY order_date DESC LIMIT 50`,
        [tx.orgId, id],
      );
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        postalCode: c.postal_code,
        prefecture: c.prefecture,
        city: c.city,
        address1: c.address1,
        address2: c.address2,
        note: c.note,
        orders: orders.map((o) => ({ id: o.id, orderNumber: o.order_number, orderDate: o.order_date, status: o.status })),
      };
    });
  });

  app.patch('/api/customers/:id', { preHandler: perm('customers.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().max(100).nullable().optional(),
        email: z.string().trim().max(254).nullable().optional(),
        phone: z.string().trim().max(30).nullable().optional(),
        postalCode: z.string().trim().max(10).nullable().optional(),
        prefecture: z.string().trim().max(20).nullable().optional(),
        city: z.string().trim().max(100).nullable().optional(),
        address1: z.string().trim().max(200).nullable().optional(),
        address2: z.string().trim().max(200).nullable().optional(),
        note: z.string().trim().max(1000).nullable().optional(),
      }),
      req.body,
    );
    await orgTx(req, async (tx) => {
      const c = await tx.maybeOne(`SELECT * FROM customers WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, id]);
      if (!c) throw notFound('顧客');
      const v = (k: keyof typeof body, col: string) => (body[k] !== undefined ? body[k] : c[col]);
      // 顧客マスターのみ更新。過去注文のスナップショット（orders.* の顧客/送付先列）は変更しない
      await tx.exec(
        `UPDATE customers SET name = $3, email = $4, phone = $5, postal_code = $6, prefecture = $7, city = $8, address1 = $9, address2 = $10, note = $11, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [tx.orgId, id, v('name', 'name'), v('email', 'email'), v('phone', 'phone'), v('postalCode', 'postal_code'), v('prefecture', 'prefecture'), v('city', 'city'), v('address1', 'address1'), v('address2', 'address2'), v('note', 'note')],
      );
      await audit(tx, { action: 'customer.update', entityType: 'customer', entityId: id, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });
}
