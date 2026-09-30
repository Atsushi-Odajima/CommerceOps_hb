import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { forbidden } from '../../lib/errors.js';
import { contentDisposition, encodeCsv, toCsv, type CsvEncoding } from '../../lib/csv.js';
import { parse } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';

const MAX_ROWS = 100_000;
const Enc = z.enum(['utf-8', 'shift_jis']).default('utf-8');

function sendCsv(reply: FastifyReply, name: string, text: string, encoding: CsvEncoding, count: number) {
  reply.header('content-type', `text/csv; charset=${encoding === 'shift_jis' ? 'Shift_JIS' : 'utf-8'}`);
  reply.header('content-disposition', contentDisposition(name));
  reply.header('x-row-count', String(count));
  return reply.send(encodeCsv(text, encoding));
}

const fmtLocal = (d: Date | string | null, tz: string) =>
  d ? new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)) : '';

/**
 * CSV 出力（export.csv 権限 + 対象データの閲覧権限が必要）。
 * 個人情報は要求レベル（pii=none|ship_to|full）と本人の権限の小さい方まで。出力は監査ログに件数・範囲のみ記録（中身は記録しない）。
 */
export async function exportRoutes(app: FastifyInstance) {
  app.get('/api/orders/export', { preHandler: perm('export.csv') }, async (req, reply) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'orders.read')) throw forbidden();
    const q = parse(
      z.object({
        status: z.string().max(30).optional(),
        channelId: z.uuid().optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        pii: z.enum(['none', 'ship_to', 'full']).default('none'),
        encoding: Enc,
      }),
      req.query,
    );
    const max = hasPerm(auth, 'orders.read_pii') ? 'full' : hasPerm(auth, 'orders.read_ship_to') ? 'ship_to' : 'none';
    const rank = { none: 0, ship_to: 1, full: 2 } as const;
    if (rank[q.pii] > rank[max]) throw forbidden('この範囲の個人情報を出力する権限がありません');
    const tz = auth.org.timezone;
    const { text, count } = await orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT o.*, c.name AS channel_name,
                (SELECT COALESCE(SUM(quantity - cancelled_qty), 0) FROM order_items oi WHERE oi.organization_id = o.organization_id AND oi.order_id = o.id)::int AS qty,
                (SELECT COALESCE(SUM(shipped_qty), 0) FROM order_items oi WHERE oi.organization_id = o.organization_id AND oi.order_id = o.id)::int AS shipped,
                (SELECT string_agg(oi.sku || '×' || (oi.quantity - oi.cancelled_qty), ' / ' ORDER BY oi.line_no) FROM order_items oi WHERE oi.organization_id = o.organization_id AND oi.order_id = o.id) AS lines
           FROM orders o JOIN sales_channels c ON c.organization_id = o.organization_id AND c.id = o.channel_id
          WHERE o.organization_id = $1 AND ($2::text IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.channel_id = $3)
            AND ($4::date IS NULL OR o.order_date >= ($4::date::timestamp AT TIME ZONE $6)) AND ($5::date IS NULL OR o.order_date < (($5::date + 1)::timestamp AT TIME ZONE $6))
          ORDER BY o.order_date DESC LIMIT ${MAX_ROWS}`,
        [tx.orgId, q.status ?? null, q.channelId ?? null, q.from ?? null, q.to ?? null, tz],
      );
      const header = ['注文番号', 'チャネル', '外部注文番号', '種別', '注文日時', '状態', '数量', '出荷済', '配送方法', '明細'];
      if (q.pii !== 'none') header.push('送付先氏名', '郵便番号', '都道府県', '市区町村', '住所1', '住所2');
      if (q.pii === 'full') header.push('送付先電話', '購入者名', '購入者メール', '購入者電話');
      const csv = toCsv(
        header,
        rows.map((o) => {
          const r: unknown[] = [o.order_number, o.channel_name, o.external_order_id, o.order_type === 'replacement' ? '交換品' : '通常', fmtLocal(o.order_date, tz), o.status, o.qty, o.shipped, o.shipping_method, o.lines];
          if (q.pii !== 'none') r.push(o.recipient_name, o.postal_code, o.prefecture, o.city, o.address1, o.address2);
          if (q.pii === 'full') r.push(o.recipient_phone, o.customer_name, o.customer_email, o.customer_phone);
          return r;
        }),
      );
      await audit(tx, { action: 'export.orders', entityType: 'order', summary: `注文 CSV 出力（${rows.length} 件・個人情報: ${q.pii}）`, metadata: { count: rows.length, pii: q.pii, status: q.status, from: q.from, to: q.to } });
      return { text: csv, count: rows.length };
    });
    return sendCsv(reply, `orders_${new Date().toISOString().slice(0, 10)}.csv`, text, q.encoding, count);
  });

  app.get('/api/returns/export', { preHandler: perm('export.csv') }, async (req, reply) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'returns.read')) throw forbidden();
    const q = parse(z.object({ status: z.string().max(20).optional(), from: z.iso.date().optional(), to: z.iso.date().optional(), encoding: Enc }), req.query);
    const tz = auth.org.timezone;
    const { text, count } = await orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT r.*, o.order_number, w.code AS warehouse_code,
                (SELECT string_agg(oi.sku || ' 申請' || ri.requested_qty || '/到着' || ri.received_qty || '/検品' || ri.inspected_qty, ' / ' ORDER BY oi.line_no)
                   FROM return_items ri JOIN order_items oi ON oi.organization_id = ri.organization_id AND oi.id = ri.order_item_id
                  WHERE ri.organization_id = r.organization_id AND ri.return_id = r.id) AS items,
                (SELECT string_agg(ins.disposition || '×' || ins.qty, ' / ') FROM return_inspections ins WHERE ins.organization_id = r.organization_id AND ins.return_id = r.id) AS dispositions,
                (SELECT exchange_number FROM exchanges e WHERE e.organization_id = r.organization_id AND e.return_id = r.id AND e.status <> 'cancelled' LIMIT 1) AS exchange_number
           FROM returns r JOIN orders o ON o.organization_id = r.organization_id AND o.id = r.order_id
           LEFT JOIN warehouses w ON w.organization_id = r.organization_id AND w.id = r.warehouse_id
          WHERE r.organization_id = $1 AND ($2::text IS NULL OR r.status = $2)
            AND ($3::date IS NULL OR r.requested_at >= ($3::date::timestamp AT TIME ZONE $5)) AND ($4::date IS NULL OR r.requested_at < (($4::date + 1)::timestamp AT TIME ZONE $5))
            AND ($6::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($6))
          ORDER BY r.requested_at DESC LIMIT ${MAX_ROWS}`,
        [tx.orgId, q.status ?? null, q.from ?? null, q.to ?? null, tz, auth.warehouseIds],
      );
      const csv = toCsv(
        ['返品番号', '注文番号', '状態', '理由', '倉庫', '受付日時', '到着日時', '完了日時', '明細', '検品結果', '交換'],
        rows.map((r) => [r.return_number, r.order_number, r.status, r.reason_code, r.warehouse_code, fmtLocal(r.requested_at, tz), fmtLocal(r.received_at, tz), fmtLocal(r.completed_at, tz), r.items, r.dispositions, r.exchange_number]),
      );
      await audit(tx, { action: 'export.returns', entityType: 'return', summary: `返品 CSV 出力（${rows.length} 件）`, metadata: { count: rows.length } });
      return { text: csv, count: rows.length };
    });
    return sendCsv(reply, `returns_${new Date().toISOString().slice(0, 10)}.csv`, text, q.encoding, count);
  });

  app.get('/api/inventory/export', { preHandler: perm('export.csv') }, async (req, reply) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'inventory.read')) throw forbidden();
    const q = parse(z.object({ warehouseId: z.uuid().optional(), encoding: Enc }), req.query);
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    const { text, count } = await orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT w.code AS warehouse_code, l.code AS location_code, l.kind, p.sku, p.name, p.variant, ib.on_hand, ib.allocated, ib.held
           FROM inventory_balances ib
           JOIN warehouses w ON w.organization_id = ib.organization_id AND w.id = ib.warehouse_id
           JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
           JOIN products p ON p.organization_id = ib.organization_id AND p.id = ib.product_id
          WHERE ib.organization_id = $1 AND (ib.on_hand <> 0 OR ib.allocated <> 0 OR ib.held <> 0)
            AND ($2::uuid IS NULL OR ib.warehouse_id = $2) AND ($3::uuid[] IS NULL OR ib.warehouse_id = ANY($3))
          ORDER BY w.priority, w.code, l.pick_sequence, l.code, p.sku LIMIT ${MAX_ROWS}`,
        [tx.orgId, q.warehouseId ?? null, auth.warehouseIds],
      );
      const csv = toCsv(
        ['倉庫', 'ロケーション', '区分', 'SKU', '商品名', 'バリエーション', '在庫', '引当済', '調査中', '引当可能'],
        rows.map((r) => [r.warehouse_code, r.location_code, r.kind, r.sku, r.name, r.variant, r.on_hand, r.allocated, r.held, r.kind === 'pick' ? r.on_hand - r.allocated - r.held : 0]),
      );
      await audit(tx, { action: 'export.inventory', entityType: 'inventory_balance', summary: `在庫 CSV 出力（${rows.length} 行）`, metadata: { count: rows.length, warehouseId: q.warehouseId } });
      return { text: csv, count: rows.length };
    });
    return sendCsv(reply, `inventory_${new Date().toISOString().slice(0, 10)}.csv`, text, q.encoding, count);
  });
}
