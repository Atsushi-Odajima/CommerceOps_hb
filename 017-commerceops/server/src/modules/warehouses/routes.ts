import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, orgTx, perm, requireOrg } from '../../http.js';
import { notFound, conflict } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import { IdParams, parse } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import type { Tx } from '../../db/tx.js';

const TimeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時刻は HH:MM 形式で指定してください');
const BusinessHours = z
  .partialRecord(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday']), z.object({ open: TimeStr, close: TimeStr }).nullable())
  .default({});

const WarehouseBody = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/, 'コードは英数字・-・_ の20文字以内'),
  name: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().max(10).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  timezone: z.string().trim().max(60).default('Asia/Tokyo'),
  cutoffTime: TimeStr.default('15:00'),
  businessHours: BusinessHours,
  priority: z.number().int().min(1).max(9999).default(100),
  active: z.boolean().default(true),
});

const LocationBody = z.object({
  code: z.string().trim().min(1).max(40),
  barcode: z.string().trim().min(1).max(64).optional(),
  zone: z.string().trim().max(40).optional().nullable(),
  kind: z.enum(['pick', 'quarantine', 'damaged']).default('pick'),
  pickSequence: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().default(true),
});

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function mapWarehouse(r: any) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    postalCode: r.postal_code,
    address: r.address,
    timezone: r.timezone,
    cutoffTime: String(r.cutoff_time).slice(0, 5),
    businessHours: r.business_hours,
    priority: r.priority,
    active: r.active,
  };
}

export function mapLocation(r: any) {
  return {
    id: r.id,
    warehouseId: r.warehouse_id,
    code: r.code,
    barcode: r.barcode,
    zone: r.zone,
    kind: r.kind,
    pickSequence: r.pick_sequence,
    active: r.active,
  };
}

/** 倉庫作成時に既定ロケーション（DEFAULT / QUARANTINE / DAMAGED）を作る */
export async function createDefaultLocations(tx: Tx, warehouseId: string) {
  const defs = [
    { code: 'DEFAULT', kind: 'pick', seq: 999_000 },
    { code: 'QUARANTINE', kind: 'quarantine', seq: 999_900 },
    { code: 'DAMAGED', kind: 'damaged', seq: 999_950 },
  ];
  for (const d of defs) {
    await tx.exec(
      `INSERT INTO locations (organization_id, id, warehouse_id, code, barcode, kind, pick_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [tx.orgId, uuidv7(), warehouseId, d.code, d.code, d.kind, d.seq],
    );
  }
}

export async function createWarehouse(tx: Tx, body: z.infer<typeof WarehouseBody>) {
  const exists = await tx.maybeOne('SELECT id FROM warehouses WHERE organization_id = $1 AND code = $2', [tx.orgId, body.code]);
  if (exists) throw conflict('DUPLICATE_CODE', `倉庫コード ${body.code} は既に使われています`);
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO warehouses (organization_id, id, code, name, postal_code, address, timezone, cutoff_time, business_hours, priority, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      tx.orgId,
      id,
      body.code,
      body.name,
      body.postalCode ?? null,
      body.address ?? null,
      body.timezone,
      body.cutoffTime,
      JSON.stringify(body.businessHours ?? {}),
      body.priority,
      body.active,
    ],
  );
  await createDefaultLocations(tx, id);
  await audit(tx, { action: 'warehouse.create', entityType: 'warehouse', entityId: id, summary: `倉庫 ${body.code} を作成` });
  return id;
}

export async function warehouseRoutes(app: FastifyInstance) {
  app.get('/api/warehouses', async (req) => {
    const auth = requireOrg(req);
    const q = parse(z.object({ includeInactive: z.coerce.boolean().default(false) }), req.query);
    const rows = await orgTx(req, (tx) =>
      tx.many(
        `SELECT * FROM warehouses WHERE organization_id = $1 AND ($2::boolean OR active)
           AND ($3::uuid[] IS NULL OR id = ANY($3))
         ORDER BY priority, code`,
        [tx.orgId, q.includeInactive, auth.warehouseIds],
      ),
    );
    return { items: rows.map(mapWarehouse) };
  });

  app.post('/api/warehouses', { preHandler: perm('warehouses.manage') }, async (req) => {
    const body = parse(WarehouseBody, req.body);
    if (!validTimezone(body.timezone)) throw conflict('INVALID_TIMEZONE', 'タイムゾーンが不正です');
    const id = await orgTx(req, (tx) => createWarehouse(tx, body));
    return { id };
  });

  app.patch('/api/warehouses/:id', { preHandler: perm('warehouses.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(WarehouseBody.partial(), req.body);
    if (body.timezone && !validTimezone(body.timezone)) throw conflict('INVALID_TIMEZONE', 'タイムゾーンが不正です');
    await orgTx(req, async (tx) => {
      const cur = await tx.maybeOne('SELECT * FROM warehouses WHERE organization_id = $1 AND id = $2 FOR UPDATE', [tx.orgId, id]);
      if (!cur) throw notFound('倉庫');
      if (body.code && body.code !== cur.code) {
        const dup = await tx.maybeOne('SELECT id FROM warehouses WHERE organization_id = $1 AND code = $2', [tx.orgId, body.code]);
        if (dup) throw conflict('DUPLICATE_CODE', `倉庫コード ${body.code} は既に使われています`);
      }
      await tx.exec(
        `UPDATE warehouses SET code = $3, name = $4, postal_code = $5, address = $6, timezone = $7, cutoff_time = $8,
                business_hours = $9, priority = $10, active = $11, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [
          tx.orgId,
          id,
          body.code ?? cur.code,
          body.name ?? cur.name,
          body.postalCode !== undefined ? body.postalCode : cur.postal_code,
          body.address !== undefined ? body.address : cur.address,
          body.timezone ?? cur.timezone,
          body.cutoffTime ?? cur.cutoff_time,
          JSON.stringify(body.businessHours ?? cur.business_hours),
          body.priority ?? cur.priority,
          body.active ?? cur.active,
        ],
      );
      await audit(tx, { action: 'warehouse.update', entityType: 'warehouse', entityId: id, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  app.get('/api/warehouses/:id/locations', async (req) => {
    const { id } = parse(IdParams, req.params);
    assertWarehouse(req, id);
    const q = parse(
      z.object({
        kind: z.enum(['pick', 'quarantine', 'damaged']).optional(),
        q: z.string().trim().max(60).optional(),
        includeInactive: z.coerce.boolean().default(false),
      }),
      req.query,
    );
    const rows = await orgTx(req, (tx) =>
      tx.many(
        `SELECT * FROM locations
          WHERE organization_id = $1 AND warehouse_id = $2 AND ($3::text IS NULL OR kind = $3)
            AND ($4::text IS NULL OR code ILIKE '%' || $4 || '%' OR barcode = $4)
            AND ($5::boolean OR active)
          ORDER BY pick_sequence, code LIMIT 2000`,
        [tx.orgId, id, q.kind ?? null, q.q ?? null, q.includeInactive],
      ),
    );
    return { items: rows.map(mapLocation) };
  });

  app.post('/api/warehouses/:id/locations', { preHandler: perm('warehouses.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(LocationBody, req.body);
    const locId = await orgTx(req, async (tx) => {
      const wh = await tx.maybeOne('SELECT id FROM warehouses WHERE organization_id = $1 AND id = $2', [tx.orgId, id]);
      if (!wh) throw notFound('倉庫');
      const dup = await tx.maybeOne(
        `SELECT code FROM locations WHERE organization_id = $1 AND warehouse_id = $2 AND (code = $3 OR barcode = $4)`,
        [tx.orgId, id, body.code, body.barcode ?? body.code],
      );
      if (dup) throw conflict('DUPLICATE_LOCATION', `ロケーション ${body.code}（またはバーコード）は既に存在します`);
      const seq =
        body.pickSequence ??
        Number((await tx.one(`SELECT COALESCE(MAX(pick_sequence) FILTER (WHERE pick_sequence < 999000), 0) + 10 AS s FROM locations WHERE organization_id = $1 AND warehouse_id = $2`, [tx.orgId, id])).s);
      const newId = uuidv7();
      await tx.exec(
        `INSERT INTO locations (organization_id, id, warehouse_id, code, barcode, zone, kind, pick_sequence, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tx.orgId, newId, id, body.code, body.barcode ?? body.code, body.zone ?? null, body.kind, seq, body.active],
      );
      await audit(tx, { action: 'location.create', entityType: 'location', entityId: newId, summary: `ロケーション ${body.code}` });
      return newId;
    });
    return { id: locId };
  });

  /** 一括登録: 「コード[,ゾーン[,並び順]]」を1行ずつ */
  app.post('/api/warehouses/:id/locations/bulk', { preHandler: perm('warehouses.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ lines: z.array(z.string().max(200)).min(1).max(2000) }), req.body);
    const entries = body.lines
      .map((l) => l.split(/[,\t]/).map((s) => s.trim()))
      .filter((p) => p[0])
      .map((p) => ({ code: p[0]!, zone: p[1] || null, seq: p[2] ? Number(p[2]) : null }));
    const bad = entries.filter((e) => e.code.length > 40 || (e.seq !== null && !Number.isInteger(e.seq)));
    if (bad.length) throw conflict('INVALID_LINES', `不正な行があります: ${bad.slice(0, 5).map((b) => b.code).join(', ')}`);
    const created = await orgTx(req, async (tx) => {
      const wh = await tx.maybeOne('SELECT id FROM warehouses WHERE organization_id = $1 AND id = $2', [tx.orgId, id]);
      if (!wh) throw notFound('倉庫');
      let base = Number(
        (await tx.one(`SELECT COALESCE(MAX(pick_sequence) FILTER (WHERE pick_sequence < 999000), 0) AS s FROM locations WHERE organization_id = $1 AND warehouse_id = $2`, [tx.orgId, id])).s,
      );
      let n = 0;
      for (const e of entries) {
        base += 10;
        n += await tx.exec(
          `INSERT INTO locations (organization_id, id, warehouse_id, code, barcode, zone, kind, pick_sequence)
           VALUES ($1, $2, $3, $4, $4, $5, 'pick', $6) ON CONFLICT DO NOTHING`,
          [tx.orgId, uuidv7(), id, e.code, e.zone, e.seq ?? base],
        );
      }
      await audit(tx, { action: 'location.bulk_create', entityType: 'warehouse', entityId: id, metadata: { created: n, requested: entries.length } });
      return n;
    });
    return { created, skipped: entries.length - created };
  });

  app.patch('/api/locations/:id', { preHandler: perm('warehouses.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(LocationBody.partial(), req.body);
    await orgTx(req, async (tx) => {
      const cur = await tx.maybeOne('SELECT * FROM locations WHERE organization_id = $1 AND id = $2 FOR UPDATE', [tx.orgId, id]);
      if (!cur) throw notFound('ロケーション');
      if (body.kind && body.kind !== cur.kind) {
        const stock = await tx.one(
          `SELECT COALESCE(SUM(on_hand), 0)::int AS n FROM inventory_balances WHERE organization_id = $1 AND location_id = $2`,
          [tx.orgId, id],
        );
        if (stock.n > 0) throw conflict('LOCATION_HAS_STOCK', '在庫があるロケーションの種別は変更できません（先に在庫を移動してください）');
      }
      await tx.exec(
        `UPDATE locations SET code = $3, barcode = $4, zone = $5, kind = $6, pick_sequence = $7, active = $8, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [
          tx.orgId,
          id,
          body.code ?? cur.code,
          body.barcode ?? cur.barcode,
          body.zone !== undefined ? body.zone : cur.zone,
          body.kind ?? cur.kind,
          body.pickSequence ?? cur.pick_sequence,
          body.active ?? cur.active,
        ],
      );
      await audit(tx, { action: 'location.update', entityType: 'location', entityId: id, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });
}
