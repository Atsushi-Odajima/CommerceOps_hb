import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, canAccessWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { contentDisposition, encodeCsv, toCsv } from '../../lib/csv.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { isRole, permissionsFor } from '../../auth/permissions.js';
import { resolveProductByCode } from '../products/routes.js';
import {
  assignException,
  changeExceptionStatus,
  commentException,
  createException,
  EXCEPTION_STATUSES,
  EXCEPTION_TYPES,
  RESOLUTION_CODES,
} from './service.js';

const EXC_SELECT = `
  SELECT e.*, o.order_number, f.fulfillment_number, s.shipment_number, r.return_number, w.code AS warehouse_code, wv.wave_number,
         pt.task_number, p.sku, p.name AS product_name, loc.code AS location_code, ib.batch_number, ua.name AS assignee_name,
         ur.name AS resolved_by_name, uc.name AS created_by_name
    FROM exception_cases e
    LEFT JOIN orders o ON o.organization_id = e.organization_id AND o.id = e.order_id
    LEFT JOIN fulfillments f ON f.organization_id = e.organization_id AND f.id = e.fulfillment_id
    LEFT JOIN shipments s ON s.organization_id = e.organization_id AND s.id = e.shipment_id
    LEFT JOIN returns r ON r.organization_id = e.organization_id AND r.id = e.return_id
    LEFT JOIN warehouses w ON w.organization_id = e.organization_id AND w.id = e.warehouse_id
    LEFT JOIN waves wv ON wv.organization_id = e.organization_id AND wv.id = e.wave_id
    LEFT JOIN pick_tasks pt ON pt.organization_id = e.organization_id AND pt.id = e.pick_task_id
    LEFT JOIN products p ON p.organization_id = e.organization_id AND p.id = e.product_id
    LEFT JOIN locations loc ON loc.organization_id = e.organization_id AND loc.id = e.location_id
    LEFT JOIN import_batches ib ON ib.organization_id = e.organization_id AND ib.id = e.import_batch_id
    LEFT JOIN users ua ON ua.id = e.assignee_user_id
    LEFT JOIN users ur ON ur.id = e.resolved_by
    LEFT JOIN users uc ON uc.id = e.created_by`;

function presentException(e: any) {
  return {
    id: e.id,
    number: e.exception_number,
    type: e.type,
    status: e.status,
    severity: e.severity,
    title: e.title,
    orderId: e.order_id,
    orderNumber: e.order_number,
    fulfillmentId: e.fulfillment_id,
    fulfillmentNumber: e.fulfillment_number,
    shipmentId: e.shipment_id,
    shipmentNumber: e.shipment_number,
    returnId: e.return_id,
    returnNumber: e.return_number,
    waveId: e.wave_id,
    waveNumber: e.wave_number,
    pickTaskId: e.pick_task_id,
    pickTaskNumber: e.task_number,
    packSessionId: e.pack_session_id,
    importBatchId: e.import_batch_id,
    importBatchNumber: e.batch_number,
    productId: e.product_id,
    sku: e.sku,
    productName: e.product_name,
    locationCode: e.location_code,
    warehouseId: e.warehouse_id,
    warehouseCode: e.warehouse_code,
    balanceId: e.balance_id,
    assigneeUserId: e.assignee_user_id,
    assigneeName: e.assignee_name,
    createdBy: e.created_by_name,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    resolvedAt: e.resolved_at,
    resolvedBy: e.resolved_by_name,
    resolutionCode: e.resolution_code,
    resolutionNote: e.resolution_note,
    ignoredReason: e.ignored_reason,
  };
}

export const FIELD_REPORT_CATEGORIES = ['damaged', 'location_issue', 'barcode_unreadable', 'missing_item', 'safety', 'other'] as const;

const CATEGORY_LABEL: Record<(typeof FIELD_REPORT_CATEGORIES)[number], string> = {
  damaged: '破損品',
  location_issue: 'ロケーションの問題',
  barcode_unreadable: 'バーコード読取不可',
  missing_item: '商品が見当たらない',
  safety: '安全上の問題',
  other: 'その他',
};

export async function exceptionRoutes(app: FastifyInstance) {
  /**
   * 現場からの例外報告（Picker / Packer 等）。個人情報は入力しない前提で、メモは 500 文字まで。
   * requestId により二重送信は同じ例外にまとめる。
   */
  app.post('/api/exceptions/report', { preHandler: perm('exceptions.report') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({
        category: z.enum(FIELD_REPORT_CATEGORIES),
        note: z.string().trim().max(500).default(''),
        code: z.string().trim().max(128).optional(),
        warehouseId: z.uuid().optional(),
        pickTaskId: z.uuid().optional(),
        requestId: z.string().trim().min(8).max(64),
      }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      let warehouseId = body.warehouseId ?? null;
      let waveId: string | null = null;
      if (body.pickTaskId) {
        const t = await tx.maybeOne(`SELECT warehouse_id, wave_id FROM pick_tasks WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.pickTaskId]);
        if (!t) throw notFound('Pick タスク');
        warehouseId = t.warehouse_id;
        waveId = t.wave_id;
      }
      if (warehouseId && !canAccessWarehouse(auth, warehouseId)) throw forbidden('この倉庫へのアクセス権限がありません');
      if (warehouseId) {
        const wh = await tx.maybeOne(`SELECT 1 FROM warehouses WHERE organization_id = $1 AND id = $2`, [tx.orgId, warehouseId]);
        if (!wh) throw notFound('倉庫');
      }
      let productId: string | null = null;
      let locationId: string | null = null;
      if (body.code) {
        const p = await resolveProductByCode(tx, body.code);
        if (p) productId = p.id;
        else {
          const loc = await tx.maybeOne(
            `SELECT id, warehouse_id FROM locations WHERE organization_id = $1 AND barcode = $2 AND ($3::uuid IS NULL OR warehouse_id = $3)
              AND ($4::uuid[] IS NULL OR warehouse_id = ANY($4)) ORDER BY code LIMIT 1`,
            [tx.orgId, body.code, warehouseId, auth.warehouseIds],
          );
          if (loc) {
            locationId = loc.id;
            warehouseId ??= loc.warehouse_id;
          }
        }
      }
      const r = await createException(tx, req.server.deps, {
        type: 'field_report',
        severity: body.category === 'safety' ? 'high' : 'medium',
        title: `現場報告: ${CATEGORY_LABEL[body.category]}`,
        detail: { category: body.category, note: body.note || undefined, code: body.code, reporterRole: auth.role },
        dedupeKey: `field:${auth.userId}:${body.requestId}`,
        productId,
        locationId,
        warehouseId,
        pickTaskId: body.pickTaskId ?? null,
        waveId,
      });
      return { id: r.id, created: r.created };
    });
  });

  /** 倉庫に紐づく例外は担当倉庫のみ。倉庫なしの例外は例外閲覧権限者全員 */
  async function loadException(req: FastifyRequest, id: string) {
    const auth = requireOrg(req);
    return orgTx(req, async (tx) => {
      const e = await tx.maybeOne(`SELECT id, warehouse_id FROM exception_cases WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!e) throw notFound('例外');
      if (e.warehouse_id && !canAccessWarehouse(auth, e.warehouse_id)) throw forbidden('この倉庫の例外へのアクセス権限がありません');
      return e;
    });
  }

  const listQuery = zPage.extend({
    status: z.string().max(20).optional(),
    type: z.enum(EXCEPTION_TYPES).optional(),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    assignee: z.string().max(40).optional(),
    q: z.string().trim().max(60).optional(),
    warehouseId: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  });

  function buildWhere(auth: ReturnType<typeof requireOrg>, q: z.infer<typeof listQuery>, orgId: string) {
    const statuses = q.status === 'active' ? ['open', 'investigating'] : q.status ? [q.status] : null;
    const assignee = q.assignee === 'me' ? auth.userId : q.assignee === 'unassigned' ? null : q.assignee && /^[0-9a-f-]{36}$/.test(q.assignee) ? q.assignee : undefined;
    const params: unknown[] = [
      orgId,
      statuses,
      q.type ?? null,
      q.severity ?? null,
      q.assignee === 'unassigned',
      assignee ?? null,
      q.q ? q.q.toUpperCase() : null,
      q.q ? `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%` : null,
      q.warehouseId ?? null,
      auth.warehouseIds,
      q.from ?? null,
      q.to ?? null,
      auth.org.timezone,
    ];
    const where = `e.organization_id = $1 AND ($2::text[] IS NULL OR e.status = ANY($2)) AND ($3::text IS NULL OR e.type = $3) AND ($4::text IS NULL OR e.severity = $4)
      AND (NOT $5::boolean OR e.assignee_user_id IS NULL) AND ($6::uuid IS NULL OR e.assignee_user_id = $6)
      AND ($7::text IS NULL OR e.exception_number = $7 OR o.order_number = $7 OR e.title ILIKE $8)
      AND ($9::uuid IS NULL OR e.warehouse_id = $9) AND ($10::uuid[] IS NULL OR e.warehouse_id IS NULL OR e.warehouse_id = ANY($10))
      AND ($11::date IS NULL OR e.created_at >= ($11::date::timestamp AT TIME ZONE $13))
      AND ($12::date IS NULL OR e.created_at < (($12::date + 1)::timestamp AT TIME ZONE $13))`;
    return { where, params };
  }

  app.get('/api/exceptions', { preHandler: perm('exceptions.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(listQuery, req.query);
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    return orgTx(req, async (tx) => {
      const { where, params } = buildWhere(auth, q, tx.orgId);
      const total = (await tx.one(`SELECT count(*)::int AS n FROM exception_cases e LEFT JOIN orders o ON o.organization_id = e.organization_id AND o.id = e.order_id WHERE ${where}`, params)).n;
      const counts = await tx.many(
        `SELECT status, type, count(*)::int AS n FROM exception_cases e WHERE e.organization_id = $1 AND ($2::uuid[] IS NULL OR e.warehouse_id IS NULL OR e.warehouse_id = ANY($2))
          GROUP BY status, type`,
        [tx.orgId, auth.warehouseIds],
      );
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `${EXC_SELECT} WHERE ${where}
          ORDER BY (e.status IN ('resolved', 'ignored')), CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.created_at DESC
          LIMIT $14 OFFSET $15`,
        params,
      );
      const byStatus: Record<string, number> = {};
      const activeByType: Record<string, number> = {};
      for (const c of counts) {
        byStatus[c.status] = (byStatus[c.status] ?? 0) + c.n;
        if (c.status === 'open' || c.status === 'investigating') activeByType[c.type] = (activeByType[c.type] ?? 0) + c.n;
      }
      return { total, counts: { ...byStatus, active: (byStatus.open ?? 0) + (byStatus.investigating ?? 0) }, activeByType, items: rows.map(presentException) };
    });
  });

  app.get('/api/exceptions/export', { preHandler: perm('export.csv') }, async (req, reply) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'exceptions.read')) throw forbidden();
    const q = parse(listQuery.extend({ encoding: z.enum(['utf-8', 'shift_jis']).default('utf-8') }), req.query);
    const { text, count } = await orgTx(req, async (tx) => {
      const { where, params } = buildWhere(auth, q, tx.orgId);
      const rows = await tx.many(`${EXC_SELECT} WHERE ${where} ORDER BY e.created_at DESC LIMIT 50000`, params);
      const fmt = (d: Date | null) => (d ? new Intl.DateTimeFormat('sv-SE', { timeZone: auth.org.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d)) : '');
      const csv = toCsv(
        ['例外番号', '種類', '状態', '重要度', '件名', '注文番号', '出荷作業', '荷物', '返品', '倉庫', 'SKU', '担当', '作成日時', '解決日時', '解決方法', '解決メモ', '無視の理由'],
        rows.map((e) => [
          e.exception_number,
          e.type,
          e.status,
          e.severity,
          e.title,
          e.order_number,
          e.fulfillment_number,
          e.shipment_number,
          e.return_number,
          e.warehouse_code,
          e.sku,
          e.assignee_name,
          fmt(e.created_at),
          fmt(e.resolved_at),
          e.resolution_code,
          e.resolution_note,
          e.ignored_reason,
        ]),
      );
      await audit(tx, { action: 'export.exceptions', entityType: 'exception', summary: `例外 CSV 出力（${rows.length} 件）`, metadata: { count: rows.length, filter: { status: q.status, type: q.type } } });
      return { text: csv, count: rows.length };
    });
    reply.header('content-type', `text/csv; charset=${q.encoding === 'shift_jis' ? 'Shift_JIS' : 'utf-8'}`);
    reply.header('content-disposition', contentDisposition(`exceptions_${new Date().toISOString().slice(0, 10)}.csv`));
    reply.header('x-row-count', String(count));
    return reply.send(encodeCsv(text, q.encoding));
  });

  app.get('/api/exceptions/meta', { preHandler: perm('exceptions.read') }, async () => ({ types: EXCEPTION_TYPES, statuses: EXCEPTION_STATUSES, resolutionCodes: RESOLUTION_CODES }));

  app.get('/api/exceptions/:id', { preHandler: perm('exceptions.read') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await loadException(req, id);
    return orgTx(req, async (tx) => {
      const e = await tx.one(`${EXC_SELECT} WHERE e.organization_id = $1 AND e.id = $2`, [tx.orgId, id]);
      const events = await tx.many(
        `SELECT ev.*, u.name AS actor_name FROM exception_events ev LEFT JOIN users u ON u.id = ev.actor_user_id
          WHERE ev.organization_id = $1 AND ev.exception_id = $2 ORDER BY ev.created_at, ev.id`,
        [tx.orgId, id],
      );
      let balance = null;
      if (e.balance_id && hasPerm(auth, 'inventory.read')) {
        const b = await tx.maybeOne(
          `SELECT ib.id, ib.on_hand, ib.allocated, ib.held, l.code AS location_code, p.sku FROM inventory_balances ib
             JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
             JOIN products p ON p.organization_id = ib.organization_id AND p.id = ib.product_id
            WHERE ib.organization_id = $1 AND ib.id = $2`,
          [tx.orgId, e.balance_id],
        );
        if (b) balance = { id: b.id, onHand: b.on_hand, allocated: b.allocated, held: b.held, available: b.on_hand - b.allocated - b.held, locationCode: b.location_code, sku: b.sku };
      }
      return {
        ...presentException(e),
        detail: e.detail,
        balance,
        events: events.map((ev) => ({ id: ev.id, type: ev.event_type, from: ev.from_status, to: ev.to_status, note: ev.note, actor: ev.actor_name, at: ev.created_at })),
      };
    });
  });

  app.post('/api/exceptions/:id/status', { preHandler: perm('exceptions.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        status: z.enum(EXCEPTION_STATUSES),
        note: z.string().trim().max(500).nullable().optional(),
        resolutionCode: z.enum(RESOLUTION_CODES).nullable().optional(),
        ignoredReason: z.string().trim().max(300).nullable().optional(),
      }),
      req.body,
    );
    await loadException(req, id);
    return orgTx(req, async (tx) => {
      const r = await changeExceptionStatus(tx, id, body);
      if (!r.unchanged) {
        await audit(tx, { action: 'exception.status', entityType: 'exception', entityId: id, summary: `${r.exceptionNumber}: ${r.from} → ${r.status}`, metadata: { to: r.status, resolutionCode: body.resolutionCode ?? undefined } });
      }
      return r;
    });
  });

  app.post('/api/exceptions/:id/assign', { preHandler: perm('exceptions.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ userId: z.uuid().nullable() }), req.body);
    const e = await loadException(req, id);
    if (body.userId) {
      // 担当者は例外を処理できる（exceptions.manage）有効メンバーで、倉庫の担当範囲内であること
      const m = (await req.server.deps.pool.query(`SELECT role, warehouse_ids, status FROM memberships WHERE organization_id = $1 AND user_id = $2`, [auth.org.id, body.userId])).rows[0];
      if (!m || m.status !== 'active' || !isRole(m.role) || !permissionsFor(m.role).has('exceptions.manage')) throw badRequest('INVALID_ASSIGNEE', 'このユーザーには例外対応を割り当てられません');
      if (e.warehouse_id && m.warehouse_ids && !m.warehouse_ids.includes(e.warehouse_id)) throw badRequest('INVALID_ASSIGNEE', 'このユーザーはこの倉庫の担当ではありません');
    }
    return orgTx(req, async (tx) => {
      const r = await assignException(tx, id, body.userId);
      if (!r.unchanged) await audit(tx, { action: 'exception.assign', entityType: 'exception', entityId: id, summary: `${r.exceptionNumber} の担当者を${body.userId ? '設定' : '解除'}`, metadata: { assignee: body.userId } });
      return r;
    });
  });

  app.post('/api/exceptions/:id/comment', { preHandler: perm('exceptions.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ note: z.string().trim().min(1).max(1000) }), req.body);
    await loadException(req, id);
    await orgTx(req, (tx) => commentException(tx, id, body.note));
    return { ok: true };
  });
}
