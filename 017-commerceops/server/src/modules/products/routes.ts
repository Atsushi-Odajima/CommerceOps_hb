import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import type { Tx } from '../../db/tx.js';
import { decodeCsvBuffer, parseCsvText } from '../imports/csvfile.js';
import { readUpload } from '../../lib/upload.js';

const Symbology = z.enum(['ean13', 'ean8', 'upca', 'code128', 'code39', 'itf', 'qr', 'other']);
const BarcodeInput = z.object({ code: z.string().trim().min(1).max(128), symbology: Symbology.optional() });

const ProductBody = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  variant: z.string().trim().max(100).optional().nullable(),
  groupCode: z.string().trim().max(64).optional().nullable(),
  imageUrl: z
    .string()
    .trim()
    .max(1000)
    .regex(/^https:\/\/[^\s<>"']+$/, '画像URLは https:// で始まる必要があります')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  weightG: z.number().int().min(0).max(1_000_000).optional().nullable(),
  active: z.boolean().default(true),
  barcodes: z.array(BarcodeInput).max(20).default([]),
});

/** バーコード文字列から種類を推定（JAN/EAN のチェックディジット検証付き） */
export function guessSymbology(code: string): z.infer<typeof Symbology> {
  if (/^\d{13}$/.test(code) && eanCheck(code)) return 'ean13';
  if (/^\d{8}$/.test(code) && eanCheck(code)) return 'ean8';
  if (/^\d{12}$/.test(code) && eanCheck('0' + code)) return 'upca';
  if (/^[\x20-\x7e]+$/.test(code)) return 'code128';
  return 'other';
}

export function eanCheck(code: string): boolean {
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function mapProduct(r: any) {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    variant: r.variant,
    groupCode: r.group_code,
    imageUrl: r.image_url,
    weightG: r.weight_g,
    active: r.active,
    barcodes: r.barcodes ?? undefined,
    onHand: r.on_hand ?? undefined,
    available: r.available ?? undefined,
  };
}

/** スキャンしたコードから商品を解決（バーコード → SKU の順） */
export async function resolveProductByCode(tx: Tx, code: string) {
  const c = code.trim();
  if (!c) return null;
  const byBarcode = await tx.maybeOne(
    `SELECT p.* FROM product_barcodes b JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
      WHERE b.organization_id = $1 AND b.code = $2`,
    [tx.orgId, c],
  );
  if (byBarcode) return byBarcode;
  return tx.maybeOne('SELECT * FROM products WHERE organization_id = $1 AND sku = $2', [tx.orgId, c]);
}

async function upsertBarcodes(tx: Tx, productId: string, barcodes: z.infer<typeof BarcodeInput>[]) {
  for (const b of barcodes) {
    const other = await tx.maybeOne(
      `SELECT p.sku FROM product_barcodes b JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
        WHERE b.organization_id = $1 AND b.code = $2 AND b.product_id <> $3`,
      [tx.orgId, b.code, productId],
    );
    if (other) throw conflict('BARCODE_TAKEN', `バーコード ${b.code} は既に SKU ${other.sku} に登録されています`);
    await tx.exec(
      `INSERT INTO product_barcodes (organization_id, id, product_id, code, symbology) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [tx.orgId, uuidv7(), productId, b.code, b.symbology ?? guessSymbology(b.code)],
    );
  }
}

export async function createProduct(tx: Tx, body: z.infer<typeof ProductBody>): Promise<string> {
  const dup = await tx.maybeOne('SELECT id FROM products WHERE organization_id = $1 AND sku = $2', [tx.orgId, body.sku]);
  if (dup) throw conflict('DUPLICATE_SKU', `SKU ${body.sku} は既に登録されています`);
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO products (organization_id, id, sku, name, variant, group_code, image_url, weight_g, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tx.orgId, id, body.sku, body.name, body.variant ?? null, body.groupCode ?? null, body.imageUrl ?? null, body.weightG ?? null, body.active],
  );
  await upsertBarcodes(tx, id, body.barcodes);
  return id;
}

export async function productRoutes(app: FastifyInstance) {
  app.get('/api/products', { preHandler: perm('products.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(
      zPage.extend({
        q: z.string().trim().max(100).optional(),
        active: z.enum(['true', 'false', 'all']).default('true'),
      }),
      req.query,
    );
    const withStock = hasPerm(auth, 'inventory.read');
    return orgTx(req, async (tx) => {
      const where = `p.organization_id = $1 AND ($2::text IS NULL OR p.sku ILIKE '%' || $2 || '%' OR p.name ILIKE '%' || $2 || '%'
                     OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.organization_id = p.organization_id AND b.product_id = p.id AND b.code = $2))
                     AND ($3 = 'all' OR p.active = ($3 = 'true'))`;
      const params = [tx.orgId, q.q ?? null, q.active];
      const total = (await tx.one(`SELECT count(*)::int AS n FROM products p WHERE ${where}`, params)).n;
      const rows = await tx.many(
        `SELECT p.*,
                (SELECT json_agg(json_build_object('id', b.id, 'code', b.code, 'symbology', b.symbology) ORDER BY b.code)
                   FROM product_barcodes b WHERE b.organization_id = p.organization_id AND b.product_id = p.id) AS barcodes
                ${withStock ? `, (SELECT COALESCE(SUM(ib.on_hand), 0)::int FROM inventory_balances ib JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
                                   WHERE ib.organization_id = p.organization_id AND ib.product_id = p.id AND l.kind = 'pick') AS on_hand,
                              (SELECT COALESCE(SUM(ib.on_hand - ib.allocated - ib.held), 0)::int FROM inventory_balances ib JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
                                   WHERE ib.organization_id = p.organization_id AND ib.product_id = p.id AND l.kind = 'pick' AND l.active) AS available` : ''}
           FROM products p WHERE ${where}
          ORDER BY p.sku LIMIT $4 OFFSET $5`,
        [...params, q.limit, q.offset],
      );
      return { items: rows.map(mapProduct), total };
    });
  });

  app.get('/api/products/lookup', { preHandler: perm('products.read') }, async (req) => {
    const auth = requireOrg(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(128) }), req.query);
    return orgTx(req, async (tx) => {
      const p = await resolveProductByCode(tx, code);
      if (!p) throw notFound('該当する商品');
      const locations = await tx.many(
        `SELECT l.code AS location_code, l.kind, w.code AS warehouse_code, w.name AS warehouse_name, ib.on_hand, ib.allocated, ib.held
           FROM inventory_balances ib
           JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
           JOIN warehouses w ON w.organization_id = ib.organization_id AND w.id = ib.warehouse_id
          WHERE ib.organization_id = $1 AND ib.product_id = $2 AND ib.on_hand > 0
            AND ($3::uuid[] IS NULL OR ib.warehouse_id = ANY($3))
          ORDER BY w.priority, l.pick_sequence`,
        [tx.orgId, p.id, auth.warehouseIds],
      );
      return {
        product: mapProduct(p),
        locations: locations.map((l) => ({
          warehouseCode: l.warehouse_code,
          warehouseName: l.warehouse_name,
          locationCode: l.location_code,
          kind: l.kind,
          onHand: l.on_hand,
          available: l.on_hand - l.allocated - l.held,
        })),
      };
    });
  });

  app.get('/api/products/:id', { preHandler: perm('products.read') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const p = await tx.maybeOne('SELECT * FROM products WHERE organization_id = $1 AND id = $2', [tx.orgId, id]);
      if (!p) throw notFound('商品');
      const barcodes = await tx.many('SELECT id, code, symbology FROM product_barcodes WHERE organization_id = $1 AND product_id = $2 ORDER BY code', [
        tx.orgId,
        id,
      ]);
      let balances: unknown[] = [];
      if (hasPerm(auth, 'inventory.read')) {
        balances = (
          await tx.many(
            `SELECT ib.id, ib.on_hand, ib.allocated, ib.held, l.id AS location_id, l.code AS location_code, l.kind, w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name
               FROM inventory_balances ib
               JOIN locations l ON l.organization_id = ib.organization_id AND l.id = ib.location_id
               JOIN warehouses w ON w.organization_id = ib.organization_id AND w.id = ib.warehouse_id
              WHERE ib.organization_id = $1 AND ib.product_id = $2
              ORDER BY w.priority, l.pick_sequence, l.code`,
            [tx.orgId, id],
          )
        ).map((b) => ({
          id: b.id,
          warehouseId: b.warehouse_id,
          warehouseCode: b.warehouse_code,
          warehouseName: b.warehouse_name,
          locationId: b.location_id,
          locationCode: b.location_code,
          kind: b.kind,
          onHand: b.on_hand,
          allocated: b.allocated,
          held: b.held,
          available: b.kind === 'pick' ? b.on_hand - b.allocated - b.held : 0,
        }));
      }
      return { ...mapProduct(p), barcodes, balances };
    });
  });

  app.post('/api/products', { preHandler: perm('products.manage') }, async (req) => {
    const body = parse(ProductBody, req.body);
    const id = await orgTx(req, async (tx) => {
      const newId = await createProduct(tx, body);
      await audit(tx, { action: 'product.create', entityType: 'product', entityId: newId, summary: `SKU ${body.sku}` });
      return newId;
    });
    return { id };
  });

  app.patch('/api/products/:id', { preHandler: perm('products.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(ProductBody.omit({ barcodes: true }).partial(), req.body);
    await orgTx(req, async (tx) => {
      const cur = await tx.maybeOne('SELECT * FROM products WHERE organization_id = $1 AND id = $2 FOR UPDATE', [tx.orgId, id]);
      if (!cur) throw notFound('商品');
      if (body.sku && body.sku !== cur.sku) {
        const used = await tx.one('SELECT count(*)::int AS n FROM order_items WHERE organization_id = $1 AND product_id = $2', [tx.orgId, id]);
        if (used.n > 0) throw conflict('SKU_IN_USE', '注文で使用済みの商品の SKU は変更できません');
        const dup = await tx.maybeOne('SELECT id FROM products WHERE organization_id = $1 AND sku = $2', [tx.orgId, body.sku]);
        if (dup) throw conflict('DUPLICATE_SKU', `SKU ${body.sku} は既に登録されています`);
      }
      await tx.exec(
        `UPDATE products SET sku = $3, name = $4, variant = $5, group_code = $6, image_url = $7, weight_g = $8, active = $9, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [
          tx.orgId,
          id,
          body.sku ?? cur.sku,
          body.name ?? cur.name,
          body.variant !== undefined ? body.variant : cur.variant,
          body.groupCode !== undefined ? body.groupCode : cur.group_code,
          body.imageUrl !== undefined ? body.imageUrl : cur.image_url,
          body.weightG !== undefined ? body.weightG : cur.weight_g,
          body.active ?? cur.active,
        ],
      );
      await audit(tx, { action: 'product.update', entityType: 'product', entityId: id, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  app.post('/api/products/:id/barcodes', { preHandler: perm('products.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(BarcodeInput, req.body);
    await orgTx(req, async (tx) => {
      const p = await tx.maybeOne('SELECT id FROM products WHERE organization_id = $1 AND id = $2', [tx.orgId, id]);
      if (!p) throw notFound('商品');
      await upsertBarcodes(tx, id, [body]);
      await audit(tx, { action: 'product.barcode_add', entityType: 'product', entityId: id, metadata: { code: body.code } });
    });
    return { ok: true };
  });

  app.delete('/api/products/:id/barcodes/:barcodeId', { preHandler: perm('products.manage') }, async (req) => {
    const { id, barcodeId } = parse(z.object({ id: z.uuid(), barcodeId: z.uuid() }), req.params);
    await orgTx(req, async (tx) => {
      const n = await tx.exec('DELETE FROM product_barcodes WHERE organization_id = $1 AND product_id = $2 AND id = $3', [tx.orgId, id, barcodeId]);
      if (!n) throw notFound('バーコード');
      await audit(tx, { action: 'product.barcode_remove', entityType: 'product', entityId: id });
    });
    return { ok: true };
  });

  /**
   * 商品 CSV 取込（固定テンプレート: sku,name,variant,group_code,barcodes,weight_g,image_url,active）
   * barcodes は | 区切り。dryRun=true で検証のみ。全行が正しい場合のみ 1 トランザクションで登録/更新。
   */
  app.post('/api/products/import', { preHandler: perm('products.manage') }, async (req) => {
    const up = await readUpload(req);
    const encoding = up.fields.encoding === 'shift_jis' ? 'shift_jis' : 'utf-8';
    const dryRun = up.fields.dryRun === 'true';
    const { text } = decodeCsvBuffer(up.buffer, encoding);
    const csv = parseCsvText(text, { delimiter: ',', hasHeader: true, skipRows: 0 });
    const idx = (name: string) => csv.header!.findIndex((h) => h.toLowerCase() === name);
    const col = { sku: idx('sku'), name: idx('name'), variant: idx('variant'), group: idx('group_code'), barcodes: idx('barcodes'), weight: idx('weight_g'), image: idx('image_url'), active: idx('active') };
    if (col.sku < 0 || col.name < 0) throw badRequest('TEMPLATE_MISMATCH', 'ヘッダーに sku と name の列が必要です（商品CSVテンプレートを使用してください）');
    const errors: { line: number; message: string }[] = [];
    const items: z.infer<typeof ProductBody>[] = [];
    const seen = new Set<string>();
    csv.rows.forEach((r, i) => {
      const line = csv.lineNumbers[i]!;
      const get = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
      const weight = get(col.weight);
      const candidate = {
        sku: get(col.sku),
        name: get(col.name),
        variant: get(col.variant) || null,
        groupCode: get(col.group) || null,
        imageUrl: get(col.image) || null,
        weightG: weight ? Number(weight) : null,
        active: !['0', 'false', 'no', '無効'].includes(get(col.active).toLowerCase()),
        barcodes: get(col.barcodes)
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((code) => ({ code })),
      };
      const res = ProductBody.safeParse(candidate);
      if (!res.success) {
        errors.push({ line, message: res.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join(' / ') });
        return;
      }
      if (seen.has(res.data.sku)) {
        errors.push({ line, message: `SKU ${res.data.sku} がファイル内で重複しています` });
        return;
      }
      seen.add(res.data.sku);
      items.push(res.data);
    });
    if (errors.length || dryRun) {
      return { ok: errors.length === 0, dryRun, errors: errors.slice(0, 200), errorCount: errors.length, validRows: items.length };
    }
    const result = await orgTx(req, async (tx) => {
      let created = 0;
      let updated = 0;
      for (const it of items) {
        const cur = await tx.maybeOne('SELECT id FROM products WHERE organization_id = $1 AND sku = $2', [tx.orgId, it.sku]);
        if (cur) {
          await tx.exec(
            `UPDATE products SET name = $3, variant = $4, group_code = $5, image_url = $6, weight_g = $7, active = $8, updated_at = now()
              WHERE organization_id = $1 AND id = $2`,
            [tx.orgId, cur.id, it.name, it.variant ?? null, it.groupCode ?? null, it.imageUrl ?? null, it.weightG ?? null, it.active],
          );
          await upsertBarcodes(tx, cur.id, it.barcodes);
          updated++;
        } else {
          await createProduct(tx, it);
          created++;
        }
      }
      await audit(tx, { action: 'product.import', entityType: 'product', summary: `商品CSV取込 新規${created} 更新${updated}`, metadata: { created, updated, filename: up.filename } });
      return { created, updated };
    });
    return { ok: true, dryRun: false, ...result, errors: [], errorCount: 0 };
  });
}
