import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orgTx, perm } from '../../http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import { IdParams, parse } from '../../lib/validate.js';
import { readUpload } from '../../lib/upload.js';
import { audit } from '../audit/audit.js';
import type { Tx } from '../../db/tx.js';
import {
  MappingSchema,
  TARGET_FIELDS,
  buildHeaderIndex,
  checkMappingColumns,
  mapRow,
  validateDateFormat,
  type Mapping,
} from '../imports/mapping.js';
import { decodeCsvBuffer, looksLikeUtf8, parseCsvText } from '../imports/csvfile.js';
import { suggestMapping } from '../imports/suggest.js';

export const CHANNEL_TYPES = ['shopify', 'amazon', 'rakuten', 'base', 'stores', 'own_site', 'wholesale', 'manual', 'other'] as const;

const ChannelBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(CHANNEL_TYPES),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,16}$/, 'コードは英数字・-・_ の16文字以内'),
  connectorType: z.enum(['csv', 'manual']).default('csv'),
  active: z.boolean().default(true),
});

export const ProfileBody = z.object({
  channelId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  encoding: z.enum(['utf-8', 'shift_jis']).default('utf-8'),
  delimiter: z.enum([',', '\t']).default(','),
  hasHeader: z.boolean().default(true),
  skipRows: z.number().int().min(0).max(20).default(0),
  dateFormat: z.string().trim().max(40).default('yyyy-MM-dd HH:mm:ss'),
  timezone: z.string().trim().max(60).default('Asia/Tokyo'),
  mapping: MappingSchema,
  invalidPolicy: z.enum(['skip', 'import_as_validation_required']).default('import_as_validation_required'),
  active: z.boolean().default(true),
});

/** CommerceOps 標準 CSV テンプレート（buyer-docs/templates/orders_template.csv）用のマッピング */
export const STANDARD_TEMPLATE_MAPPING: Mapping = {
  externalOrderId: { source: { column: '注文番号' }, transforms: [] },
  orderDate: { source: { column: '注文日時' }, transforms: [] },
  customerName: { source: { column: '購入者名' }, transforms: [] },
  customerEmail: { source: { column: '購入者メール' }, transforms: [] },
  customerPhone: { source: { column: '購入者電話' }, transforms: [] },
  recipientName: { source: { column: '送付先氏名' }, transforms: [] },
  postalCode: { source: { column: '郵便番号' }, transforms: [] },
  prefecture: { source: { column: '都道府県' }, transforms: [] },
  city: { source: { column: '市区町村' }, transforms: [] },
  address1: { source: { column: '住所1' }, transforms: [] },
  address2: { source: { column: '住所2' }, transforms: [] },
  recipientPhone: { source: { column: '送付先電話' }, transforms: [] },
  shippingMethod: { source: { column: '配送方法' }, transforms: [] },
  notes: { source: { column: '備考' }, transforms: [] },
  sku: { source: { column: 'SKU' }, transforms: [] },
  productName: { source: { column: '商品名' }, transforms: [] },
  quantity: { source: { column: '数量' }, transforms: [] },
  unitPrice: { source: { column: '単価' }, transforms: [{ op: 'removeChars', chars: ',¥円' }] },
};

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateProfile(body: { dateFormat: string; timezone: string }) {
  const dfErr = validateDateFormat(body.dateFormat);
  if (dfErr) throw badRequest('INVALID_DATE_FORMAT', dfErr);
  if (!validTimezone(body.timezone)) throw badRequest('INVALID_TIMEZONE', 'タイムゾーンが不正です');
}

export function mapChannel(r: any) {
  return { id: r.id, name: r.name, type: r.type, code: r.code, connectorType: r.connector_type, active: r.active };
}

export function mapProfile(r: any) {
  return {
    id: r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    name: r.name,
    encoding: r.encoding,
    delimiter: r.delimiter,
    hasHeader: r.has_header,
    skipRows: r.skip_rows,
    dateFormat: r.date_format,
    timezone: r.timezone,
    mapping: r.mapping,
    invalidPolicy: r.invalid_policy,
    version: r.version,
    active: r.active,
    updatedAt: r.updated_at,
  };
}

export async function createChannel(tx: Tx, body: z.infer<typeof ChannelBody>) {
  const dup = await tx.maybeOne('SELECT id FROM sales_channels WHERE organization_id = $1 AND code = $2', [tx.orgId, body.code]);
  if (dup) throw conflict('DUPLICATE_CODE', `チャネルコード ${body.code} は既に使われています`);
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO sales_channels (organization_id, id, name, type, code, connector_type, active) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tx.orgId, id, body.name, body.type, body.code, body.connectorType, body.active],
  );
  await audit(tx, { action: 'channel.create', entityType: 'sales_channel', entityId: id, summary: `チャネル ${body.name}` });
  return id;
}

export async function createProfile(tx: Tx, body: z.infer<typeof ProfileBody>) {
  validateProfile(body);
  const ch = await tx.maybeOne('SELECT id FROM sales_channels WHERE organization_id = $1 AND id = $2', [tx.orgId, body.channelId]);
  if (!ch) throw notFound('販売チャネル');
  const id = uuidv7();
  await tx.exec(
    `INSERT INTO import_profiles (organization_id, id, channel_id, name, encoding, delimiter, has_header, skip_rows, date_format, timezone,
                                  mapping, invalid_policy, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      tx.orgId,
      id,
      body.channelId,
      body.name,
      body.encoding,
      body.delimiter,
      body.hasHeader,
      body.skipRows,
      body.dateFormat,
      body.timezone,
      JSON.stringify(body.mapping),
      body.invalidPolicy,
      body.active,
      tx.actor.userId,
    ],
  );
  await audit(tx, { action: 'import_profile.create', entityType: 'import_profile', entityId: id, summary: `Import Profile ${body.name}` });
  return id;
}

export async function channelRoutes(app: FastifyInstance) {
  app.get('/api/channels', { preHandler: perm('orders.read', 'orders.import', 'channels.manage', 'returns.request') }, async (req) => {
    const rows = await orgTx(req, (tx) => tx.many('SELECT * FROM sales_channels WHERE organization_id = $1 ORDER BY active DESC, name', [tx.orgId]));
    return { items: rows.map(mapChannel) };
  });

  app.post('/api/channels', { preHandler: perm('channels.manage') }, async (req) => {
    const body = parse(ChannelBody, req.body);
    const id = await orgTx(req, (tx) => createChannel(tx, body));
    return { id };
  });

  app.patch('/api/channels/:id', { preHandler: perm('channels.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(ChannelBody.partial(), req.body);
    await orgTx(req, async (tx) => {
      const cur = await tx.maybeOne('SELECT * FROM sales_channels WHERE organization_id = $1 AND id = $2 FOR UPDATE', [tx.orgId, id]);
      if (!cur) throw notFound('販売チャネル');
      if (body.code && body.code !== cur.code) {
        const dup = await tx.maybeOne('SELECT id FROM sales_channels WHERE organization_id = $1 AND code = $2', [tx.orgId, body.code]);
        if (dup) throw conflict('DUPLICATE_CODE', `チャネルコード ${body.code} は既に使われています`);
      }
      await tx.exec(
        `UPDATE sales_channels SET name = $3, type = $4, code = $5, connector_type = $6, active = $7, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [tx.orgId, id, body.name ?? cur.name, body.type ?? cur.type, body.code ?? cur.code, body.connectorType ?? cur.connector_type, body.active ?? cur.active],
      );
      await audit(tx, { action: 'channel.update', entityType: 'sales_channel', entityId: id, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  // ---------------- import profiles ----------------
  app.get('/api/import-profiles/meta', { preHandler: perm('orders.import', 'channels.manage') }, async () => ({
    fields: Object.entries(TARGET_FIELDS).map(([key, d]) => ({ key, ...d })),
    transforms: [
      { op: 'trim', label: '前後の空白を除去' },
      { op: 'nfkc', label: '全角英数を半角に' },
      { op: 'upper', label: '大文字に' },
      { op: 'lower', label: '小文字に' },
      { op: 'digitsOnly', label: '数字以外を除去' },
      { op: 'removeChars', label: '指定文字を除去', params: ['chars'] },
      { op: 'replace', label: '文字列を置換（完全一致の文字列）', params: ['from', 'to'] },
      { op: 'emptyAs', label: '空欄のときの値', params: ['value'] },
      { op: 'truncate', label: '指定文字数で切り詰め', params: ['length'] },
      { op: 'map', label: '値の対応表', params: ['table', 'fallback'] },
    ],
    dateFormats: ['yyyy-MM-dd HH:mm:ss', 'yyyy/MM/dd HH:mm:ss', 'yyyy/M/d H:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', 'yyyy年M月d日 H時mm分', 'ISO'],
    standardTemplate: STANDARD_TEMPLATE_MAPPING,
  }));

  app.get('/api/import-profiles', { preHandler: perm('orders.import', 'channels.manage') }, async (req) => {
    const q = parse(z.object({ channelId: z.uuid().optional() }), req.query);
    const rows = await orgTx(req, (tx) =>
      tx.many(
        `SELECT p.*, c.name AS channel_name FROM import_profiles p
           JOIN sales_channels c ON c.organization_id = p.organization_id AND c.id = p.channel_id
          WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR p.channel_id = $2)
          ORDER BY c.name, p.name`,
        [tx.orgId, q.channelId ?? null],
      ),
    );
    return { items: rows.map(mapProfile) };
  });

  app.get('/api/import-profiles/:id', { preHandler: perm('orders.import', 'channels.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = await orgTx(req, (tx) =>
      tx.maybeOne(
        `SELECT p.*, c.name AS channel_name FROM import_profiles p
           JOIN sales_channels c ON c.organization_id = p.organization_id AND c.id = p.channel_id
          WHERE p.organization_id = $1 AND p.id = $2`,
        [tx.orgId, id],
      ),
    );
    if (!row) throw notFound('Import Profile');
    return mapProfile(row);
  });

  app.post('/api/import-profiles', { preHandler: perm('channels.manage') }, async (req) => {
    const body = parse(ProfileBody, req.body);
    const id = await orgTx(req, (tx) => createProfile(tx, body));
    return { id };
  });

  app.patch('/api/import-profiles/:id', { preHandler: perm('channels.manage') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(ProfileBody.partial(), req.body);
    await orgTx(req, async (tx) => {
      const cur = await tx.maybeOne('SELECT * FROM import_profiles WHERE organization_id = $1 AND id = $2 FOR UPDATE', [tx.orgId, id]);
      if (!cur) throw notFound('Import Profile');
      const merged = {
        channelId: body.channelId ?? cur.channel_id,
        name: body.name ?? cur.name,
        encoding: body.encoding ?? cur.encoding,
        delimiter: body.delimiter ?? cur.delimiter,
        hasHeader: body.hasHeader ?? cur.has_header,
        skipRows: body.skipRows ?? cur.skip_rows,
        dateFormat: body.dateFormat ?? cur.date_format,
        timezone: body.timezone ?? cur.timezone,
        mapping: body.mapping ?? cur.mapping,
        invalidPolicy: body.invalidPolicy ?? cur.invalid_policy,
        active: body.active ?? cur.active,
      };
      validateProfile(merged);
      if (body.channelId) {
        const ch = await tx.maybeOne('SELECT id FROM sales_channels WHERE organization_id = $1 AND id = $2', [tx.orgId, body.channelId]);
        if (!ch) throw notFound('販売チャネル');
      }
      await tx.exec(
        `UPDATE import_profiles SET channel_id = $3, name = $4, encoding = $5, delimiter = $6, has_header = $7, skip_rows = $8,
                date_format = $9, timezone = $10, mapping = $11, invalid_policy = $12, active = $13, version = version + 1,
                updated_by = $14, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [
          tx.orgId,
          id,
          merged.channelId,
          merged.name,
          merged.encoding,
          merged.delimiter,
          merged.hasHeader,
          merged.skipRows,
          merged.dateFormat,
          merged.timezone,
          JSON.stringify(merged.mapping),
          merged.invalidPolicy,
          merged.active,
          tx.actor.userId,
        ],
      );
      await audit(tx, { action: 'import_profile.update', entityType: 'import_profile', entityId: id, metadata: { fields: Object.keys(body) } });
    });
    return { ok: true };
  });

  /** CSV のヘッダー・先頭行を確認し、マッピング候補を返す（保存しない） */
  app.post('/api/import-profiles/inspect', { preHandler: perm('orders.import', 'channels.manage') }, async (req) => {
    const up = await readUpload(req);
    const encoding = up.fields.encoding === 'shift_jis' ? 'shift_jis' : 'utf-8';
    const delimiter = up.fields.delimiter === '\t' || up.fields.delimiter === 'tab' ? '\t' : ',';
    const hasHeader = up.fields.hasHeader !== 'false';
    const skipRows = Math.min(20, Math.max(0, Number(up.fields.skipRows ?? 0) || 0));
    const hadBom = up.buffer[0] === 0xef && up.buffer[1] === 0xbb && up.buffer[2] === 0xbf;
    const utf8Valid = looksLikeUtf8(hadBom ? up.buffer.subarray(3) : up.buffer);
    const { text } = decodeCsvBuffer(up.buffer, encoding);
    const csv = parseCsvText(text, { delimiter, hasHeader, skipRows });
    const headers = csv.header ?? Array.from({ length: csv.columnCount }, (_, i) => `列${i + 1}`);
    const suggestion = csv.header ? suggestMapping(csv.header) : { mapping: {}, matched: {} };
    return {
      filename: up.filename,
      encodingInfo: { hadBom, utf8Valid, suggested: utf8Valid ? 'utf-8' : 'shift_jis' },
      headers,
      sampleRows: csv.rows.slice(0, 5),
      rowCount: csv.rows.length,
      suggestedMapping: suggestion.mapping,
      matched: suggestion.matched,
    };
  });

  /** プロファイル（保存済み or 未保存の JSON）で CSV の先頭 20 行を変換して結果を見る */
  app.post('/api/import-profiles/test', { preHandler: perm('orders.import', 'channels.manage') }, async (req) => {
    const up = await readUpload(req);
    let profile: z.infer<typeof ProfileBody>;
    try {
      profile = ProfileBody.parse(JSON.parse(up.fields.profile ?? '{}'));
    } catch (e) {
      throw badRequest('INVALID_PROFILE', 'プロファイル定義が不正です', (e as z.ZodError).issues?.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    validateProfile(profile);
    const { text } = decodeCsvBuffer(up.buffer, profile.encoding);
    const csv = parseCsvText(text, { delimiter: profile.delimiter, hasHeader: profile.hasHeader, skipRows: profile.skipRows });
    const header = buildHeaderIndex(csv.header, csv.columnCount);
    const columnProblems = checkMappingColumns(profile.mapping as Mapping, header, profile.hasHeader);
    const rows = csv.rows.slice(0, 20).map((r, i) => {
      const mapped = mapRow(r, profile.mapping as Mapping, header, { dateFormat: profile.dateFormat, timeZone: profile.timezone });
      return { line: csv.lineNumbers[i], values: mapped.values, issues: mapped.issues };
    });
    return { columnProblems, rows, rowCount: csv.rows.length };
  });
}
