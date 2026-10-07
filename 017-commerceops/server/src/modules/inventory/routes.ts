import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { cappedCount } from '../../lib/pagination.js';
import { parse, zPage } from '../../lib/validate.js';
import { readUpload } from '../../lib/upload.js';
import { audit } from '../audit/audit.js';
import { decodeCsvBuffer, parseCsvText } from '../imports/csvfile.js';
import { adjustStock, receiveStock, resolveHeld, reverseMovement, transferStock } from './service.js';
import { uuidv7 } from '../../lib/uuid.js';

const Req = z.uuid().optional();

export async function inventoryRoutes(app: FastifyInstance) {
  /** 倉庫 × 商品の在庫サマリ（販売可能ロケーションの合計と、返品保留・破損の数量） */
  app.get('/api/inventory', { preHandler: perm('inventory.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(
      zPage.extend({
        warehouseId: z.uuid().optional(),
        q: z.string().trim().max(100).optional(),
        filter: z.enum(['all', 'available', 'shortage', 'held', 'nonsellable']).default('all'),
      }),
      req.query,
    );
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, q.warehouseId ?? null, q.q ?? null, auth.warehouseIds];
      // 未引当の需要は、引当待ちの注文（全体のごく一部）だけを 1 回集計して商品ごとに結合する（商品ごとに全明細を数えない）
      const base = `
        WITH demand AS (
          SELECT oi.product_id, SUM(oi.quantity - oi.cancelled_qty - oi.shipped_qty - oi.allocated_qty)::int AS qty
            FROM orders o JOIN order_items oi ON oi.organization_id = o.organization_id AND oi.order_id = o.id
           WHERE o.organization_id = $1 AND o.status IN ('ready_for_allocation', 'partially_allocated', 'partially_shipped') AND oi.product_id IS NOT NULL
           GROUP BY oi.product_id
        )
        SELECT p.id AS product_id, p.sku, p.name, p.variant, w.id AS warehouse_id, w.code AS warehouse_code,
               COALESCE(SUM(ib.on_hand) FILTER (WHERE l.kind = 'pick'), 0)::int AS on_hand,
               COALESCE(SUM(ib.allocated) FILTER (WHERE l.kind = 'pick'), 0)::int AS allocated,
               COALESCE(SUM(ib.held) FILTER (WHERE l.kind = 'pick'), 0)::int AS held,
               COALESCE(SUM(ib.on_hand - ib.allocated - ib.held) FILTER (WHERE l.kind = 'pick' AND l.active), 0)::int AS available,
               COALESCE(SUM(ib.on_hand) FILTER (WHERE l.kind = 'quarantine'), 0)::int AS quarantine,
               COALESCE(SUM(ib.on_hand) FILTER (WHERE l.kind = 'damaged'), 0)::int AS damaged,
               COALESCE(MAX(d.qty), 0)::int AS unallocated_demand
          FROM inventory_balances ib
          JOIN products p ON p.organization_id = ib.organization_id AND p.id = ib.product_id
          JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
          JOIN warehouses w ON w.organization_id = ib.organization_id AND w.id = ib.warehouse_id
          LEFT JOIN demand d ON d.product_id = p.id
         WHERE ib.organization_id = $1 AND ($2::uuid IS NULL OR ib.warehouse_id = $2)
           AND ($3::text IS NULL OR p.sku ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%')
           AND ($4::uuid[] IS NULL OR ib.warehouse_id = ANY($4))
         GROUP BY p.organization_id, p.id, p.sku, p.name, p.variant, w.id, w.code`;
      const having =
        q.filter === 'available' ? 'WHERE available > 0' : q.filter === 'shortage' ? 'WHERE unallocated_demand > 0' : q.filter === 'held' ? 'WHERE held > 0' : q.filter === 'nonsellable' ? 'WHERE quarantine + damaged > 0' : '';
      const total = (await tx.one(`SELECT count(*)::int AS n FROM (${base}) x ${having}`, params)).n;
      params.push(q.limit, q.offset);
      const rows = await tx.many(`SELECT * FROM (${base}) x ${having} ORDER BY sku, warehouse_code LIMIT $5 OFFSET $6`, params);
      return {
        total,
        items: rows.map((r) => ({
          productId: r.product_id,
          sku: r.sku,
          name: r.name,
          variant: r.variant,
          warehouseId: r.warehouse_id,
          warehouseCode: r.warehouse_code,
          onHand: r.on_hand,
          allocated: r.allocated,
          held: r.held,
          available: r.available,
          quarantine: r.quarantine,
          damaged: r.damaged,
          unallocatedDemand: r.unallocated_demand,
        })),
      };
    });
  });

  app.get('/api/inventory/balances', { preHandler: perm('inventory.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(z.object({ productId: z.uuid(), warehouseId: z.uuid().optional() }), req.query);
    return orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT ib.*, l.code AS location_code, l.kind, l.active AS location_active, w.code AS warehouse_code
           FROM inventory_balances ib
           JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
           JOIN warehouses w ON w.organization_id = ib.organization_id AND w.id = ib.warehouse_id
          WHERE ib.organization_id = $1 AND ib.product_id = $2 AND ($3::uuid IS NULL OR ib.warehouse_id = $3)
            AND ($4::uuid[] IS NULL OR ib.warehouse_id = ANY($4))
          ORDER BY w.priority, l.pick_sequence, l.code`,
        [tx.orgId, q.productId, q.warehouseId ?? null, auth.warehouseIds],
      );
      return {
        items: rows.map((b) => ({
          id: b.id,
          warehouseId: b.warehouse_id,
          warehouseCode: b.warehouse_code,
          locationId: b.location_id,
          locationCode: b.location_code,
          kind: b.kind,
          onHand: b.on_hand,
          allocated: b.allocated,
          held: b.held,
          available: b.kind === 'pick' && b.location_active ? b.on_hand - b.allocated - b.held : 0,
        })),
      };
    });
  });

  app.get('/api/inventory/movements', { preHandler: perm('inventory.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(zPage.extend({ productId: z.uuid().optional(), warehouseId: z.uuid().optional(), type: z.string().max(30).optional() }), req.query);
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, q.productId ?? null, q.warehouseId ?? null, q.type ?? null, auth.warehouseIds];
      const where = `m.organization_id = $1 AND ($2::uuid IS NULL OR m.product_id = $2) AND ($3::uuid IS NULL OR m.warehouse_id = $3)
                     AND ($4::text IS NULL OR m.movement_type = $4) AND ($5::uuid[] IS NULL OR m.warehouse_id = ANY($5))`;
      const { total, totalCapped } = await cappedCount(tx, `FROM inventory_movements m WHERE ${where}`, params);
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `SELECT m.*, p.sku, l.code AS location_code, w.code AS warehouse_code, u.name AS actor_name,
                EXISTS (SELECT 1 FROM inventory_movements r WHERE r.organization_id = m.organization_id AND r.reversal_of_movement_id = m.id) AS reversed
           FROM inventory_movements m
           JOIN products p ON p.organization_id = m.organization_id AND p.id = m.product_id
           JOIN locations l ON l.organization_id = m.organization_id AND l.id = m.location_id
           JOIN warehouses w ON w.organization_id = m.organization_id AND w.id = m.warehouse_id
           LEFT JOIN users u ON u.id = m.actor_user_id
          WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $6 OFFSET $7`,
        params,
      );
      return {
        total,
        totalCapped,
        items: rows.map((m) => ({
          id: m.id,
          type: m.movement_type,
          sku: m.sku,
          warehouseCode: m.warehouse_code,
          locationCode: m.location_code,
          onHandDelta: m.on_hand_delta,
          heldDelta: m.held_delta,
          referenceType: m.reference_type,
          referenceId: m.reference_id,
          reason: m.reason,
          actor: m.actor_name,
          createdAt: m.created_at,
          reversalOfMovementId: m.reversal_of_movement_id,
          reversed: m.reversed,
          reversible: !m.reversed && ['receipt', 'adjust', 'transfer_out', 'transfer_in'].includes(m.movement_type) && m.reference_type !== 'stocktake',
        })),
      };
    });
  });

  app.post('/api/inventory/receipts', { preHandler: perm('inventory.adjust') }, async (req) => {
    const body = parse(
      z.object({ locationId: z.uuid(), productId: z.uuid(), qty: z.number().int().min(1).max(1_000_000), reason: z.string().trim().max(300).optional(), requestId: Req }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      const loc = await tx.maybeOne(`SELECT warehouse_id FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.locationId]);
      if (!loc) throw notFound('ロケーション');
      assertWarehouse(req, loc.warehouse_id);
      const r = await receiveStock(tx, { ...body, reason: body.reason ?? '入荷' });
      await audit(tx, { action: 'inventory.receipt', entityType: 'inventory_balance', entityId: r.balance.id, summary: `入荷 +${body.qty}`, metadata: { qty: body.qty, applied: r.applied } });
      return { applied: r.applied, balance: r.balance };
    });
  });

  app.post('/api/inventory/adjustments', { preHandler: perm('inventory.adjust') }, async (req) => {
    const body = parse(
      z.object({
        locationId: z.uuid(),
        productId: z.uuid(),
        mode: z.enum(['set', 'delta']),
        qty: z.number().int().min(-1_000_000).max(1_000_000),
        reason: z.string().trim().min(1, '調整理由を入力してください').max(300),
        requestId: Req,
      }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      const loc = await tx.maybeOne(`SELECT warehouse_id FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.locationId]);
      if (!loc) throw notFound('ロケーション');
      assertWarehouse(req, loc.warehouse_id);
      const r = await adjustStock(tx, body);
      await audit(tx, {
        action: 'inventory.adjust',
        entityType: 'inventory_balance',
        entityId: r.balance.id,
        summary: `在庫調整（${body.mode === 'set' ? `=${body.qty}` : `${body.qty > 0 ? '+' : ''}${body.qty}`}）`,
        metadata: { mode: body.mode, qty: body.qty, applied: r.applied },
      });
      return { applied: r.applied, balance: r.balance };
    });
  });

  app.post('/api/inventory/transfers', { preHandler: perm('inventory.adjust') }, async (req) => {
    const body = parse(
      z.object({ fromLocationId: z.uuid(), toLocationId: z.uuid(), productId: z.uuid(), qty: z.number().int().min(1).max(1_000_000), reason: z.string().trim().max(300).optional(), requestId: Req }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      const loc = await tx.maybeOne(`SELECT warehouse_id FROM locations WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.fromLocationId]);
      if (!loc) throw notFound('ロケーション');
      assertWarehouse(req, loc.warehouse_id);
      const r = await transferStock(tx, body);
      await audit(tx, {
        action: 'inventory.transfer',
        entityType: 'product',
        entityId: body.productId,
        summary: `ロケーション移動 ${body.qty}${r.fromKind !== r.toKind ? `（${r.fromKind} → ${r.toKind}）` : ''}`,
        metadata: { qty: body.qty, fromKind: r.fromKind, toKind: r.toKind }, // 理由の本文は在庫移動の行に残す（監査ログには自由記述を入れない）
      });
      return r;
    });
  });

  // 誤登録の取消（StockPilot から統合）。移動は相手側も、発注入荷は発注明細の入荷済み数量も戻す
  app.post('/api/inventory/movements/:id/reverse', { preHandler: perm('inventory.adjust') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(1, '取消の理由を入力してください').max(300), requestId: Req }), req.body);
    return orgTx(req, async (tx) => {
      const m = await tx.maybeOne(`SELECT warehouse_id, product_id FROM inventory_movements WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!m) throw notFound('在庫の履歴');
      assertWarehouse(req, m.warehouse_id);
      const r = await reverseMovement(tx, { movementId: id, reason: body.reason, requestId: body.requestId ?? null });
      await audit(tx, { action: 'inventory.reverse', entityType: 'inventory_movement', entityId: id, summary: '在庫の誤登録を取消', metadata: { reversed: r.reversed, applied: r.applied } });
      return r;
    });
  });

  app.post('/api/inventory/held/resolve', { preHandler: perm('inventory.adjust') }, async (req) => {
    const body = parse(
      z.object({ balanceId: z.uuid(), qty: z.number().int().min(1), resolution: z.enum(['loss', 'found']), reason: z.string().trim().max(300).optional(), requestId: Req }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      const b = await tx.maybeOne(`SELECT warehouse_id FROM inventory_balances WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.balanceId]);
      if (!b) throw notFound('在庫');
      assertWarehouse(req, b.warehouse_id);
      const r = await resolveHeld(tx, body);
      await audit(tx, { action: `inventory.held_${body.resolution}`, entityType: 'inventory_balance', entityId: body.balanceId, summary: `調査中在庫 ${body.qty} 個を${body.resolution === 'loss' ? '紛失確定' : '発見'}` });
      return { applied: r.applied, balance: r.balance };
    });
  });

  /**
   * 在庫 CSV 取込（初期在庫・一括調整）: warehouse_code,location_code,sku,qty（mode=set は実数、add は加算）
   * 全行を検証してから 1 トランザクションで反映。
   */
  app.post('/api/inventory/import', { preHandler: perm('inventory.adjust') }, async (req) => {
    const auth = requireOrg(req);
    const up = await readUpload(req);
    const mode = up.fields.mode === 'add' ? 'add' : 'set';
    const dryRun = up.fields.dryRun === 'true';
    const { text } = decodeCsvBuffer(up.buffer, up.fields.encoding === 'shift_jis' ? 'shift_jis' : 'utf-8');
    const csv = parseCsvText(text, { delimiter: ',', hasHeader: true, skipRows: 0 });
    const h = (n: string) => csv.header!.findIndex((x) => x.toLowerCase() === n);
    const col = { wh: h('warehouse_code'), loc: h('location_code'), sku: h('sku'), qty: h('qty') };
    if (Object.values(col).some((i) => i < 0)) throw badRequest('TEMPLATE_MISMATCH', 'ヘッダーに warehouse_code,location_code,sku,qty が必要です');
    return orgTx(req, async (tx) => {
      const whs = await tx.many(`SELECT id, code FROM warehouses WHERE organization_id = $1`, [tx.orgId]);
      const locs = await tx.many(`SELECT id, code, warehouse_id FROM locations WHERE organization_id = $1`, [tx.orgId]);
      const prods = await tx.many(`SELECT id, sku FROM products WHERE organization_id = $1`, [tx.orgId]);
      const whByCode = new Map(whs.map((w) => [w.code, w.id]));
      const locByKey = new Map(locs.map((l) => [`${l.warehouse_id}:${l.code}`, l.id]));
      const prodBySku = new Map(prods.map((p) => [p.sku, p.id]));
      const errors: { line: number; message: string }[] = [];
      const ops: { locationId: string; productId: string; qty: number }[] = [];
      csv.rows.forEach((r, i) => {
        const line = csv.lineNumbers[i]!;
        const whId = whByCode.get((r[col.wh] ?? '').trim());
        if (!whId) return errors.push({ line, message: `倉庫コード ${r[col.wh]} がありません` });
        if (auth.warehouseIds && !auth.warehouseIds.includes(whId)) return errors.push({ line, message: `倉庫 ${r[col.wh]} の権限がありません` });
        const locId = locByKey.get(`${whId}:${(r[col.loc] ?? '').trim()}`);
        if (!locId) return errors.push({ line, message: `ロケーション ${r[col.loc]} がありません` });
        const pid = prodBySku.get((r[col.sku] ?? '').trim());
        if (!pid) return errors.push({ line, message: `SKU ${r[col.sku]} がありません` });
        const qty = Number((r[col.qty] ?? '').trim());
        if (!Number.isInteger(qty) || qty < 0 || (mode === 'add' && qty === 0)) return errors.push({ line, message: `数量 ${r[col.qty]} が不正です` });
        ops.push({ locationId: locId, productId: pid, qty });
        return undefined;
      });
      if (errors.length || dryRun) return { ok: errors.length === 0, dryRun, errors: errors.slice(0, 200), errorCount: errors.length, rows: ops.length };
      const batchKey = uuidv7();
      let changed = 0;
      for (const [i, op] of ops.entries()) {
        const r =
          mode === 'set'
            ? await adjustStock(tx, { ...op, mode: 'set', reason: '在庫CSV取込（実数）', requestId: null })
            : await receiveStock(tx, { ...op, reason: '在庫CSV取込（加算）', requestId: `${batchKey}-${i}` });
        if (r.applied) changed++;
      }
      await audit(tx, { action: 'inventory.import', entityType: 'inventory', summary: `在庫CSV取込（${mode}）${changed}件`, metadata: { mode, rows: ops.length, changed, filename: up.filename } });
      return { ok: true, dryRun: false, rows: ops.length, changed, errors: [], errorCount: 0 };
    });
  });
}
