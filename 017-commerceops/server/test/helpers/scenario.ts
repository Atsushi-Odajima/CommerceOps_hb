import { randomUUID } from 'node:crypto';
import { expectStatus, TestClient, type TestEnv } from './env.js';
import { createOrg, type TestUser } from './factory.js';
import { STANDARD_TEMPLATE_MAPPING } from '../../src/modules/channels/routes.js';

export const STD_HEADERS = [
  '注文番号', '注文日時', '購入者名', '購入者メール', '購入者電話', '送付先氏名', '郵便番号', '都道府県', '市区町村', '住所1', '住所2',
  '送付先電話', '配送方法', '備考', 'SKU', '商品名', '数量', '単価',
] as const;

export type StdRow = Partial<Record<(typeof STD_HEADERS)[number], string | number>>;

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 標準テンプレート形式の注文 CSV（UTF-8 BOM 付き） */
export function stdCsv(rows: StdRow[], opts: { bom?: boolean } = {}): Buffer {
  const lines = [STD_HEADERS.join(','), ...rows.map((r) => STD_HEADERS.map((h) => csvCell(r[h])).join(','))];
  const body = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  return opts.bom === false ? body : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}

export function orderRow(ext: string, sku: string, qty: number, extra: StdRow = {}): StdRow {
  return {
    注文番号: ext,
    注文日時: '2026-09-30 10:00:00',
    購入者名: '山田 太郎',
    購入者メール: 'taro@example.test',
    購入者電話: '090-1111-2222',
    送付先氏名: '山田 太郎',
    郵便番号: '1500001',
    住所1: '東京都渋谷区神宮前1-2-3',
    住所2: 'テストビル5F',
    送付先電話: '090-1111-2222',
    配送方法: '宅配便',
    SKU: sku,
    商品名: `商品 ${sku}`,
    数量: qty,
    単価: '1,200',
    ...extra,
  };
}

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = '----co' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`));
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadFile(client: TestClient, url: string, fields: Record<string, string>, content: Buffer, name = 'orders.csv') {
  const mp = multipart(fields, { name, content });
  const res = await client.app.inject({
    method: 'POST',
    url,
    payload: mp.body,
    headers: { 'content-type': mp.contentType, 'x-requested-with': 'CommerceOps', 'x-csrf-token': client.csrf, cookie: client.cookie },
  });
  const body = String(res.headers['content-type'] ?? '').includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body, text: res.body };
}

export interface BasicOrg {
  orgId: string;
  owner: TestUser;
  channelId: string;
  profileId: string;
  warehouseId: string;
  warehouseCode: string;
  /** sku -> productId */
  products: Record<string, string>;
}

/** 組織 + チャネル(標準CSV Profile) + 倉庫(ロケーション A-01..A-05) + 商品 */
export async function setupBasicOrg(env: TestEnv, opts: { skus?: string[]; warehouses?: string[] } = {}): Promise<BasicOrg & { warehouses: Record<string, string> }> {
  const { orgId, owner } = await createOrg(env);
  const c = owner.client;
  const channelId = expectStatus(await c.post('/api/channels', { name: 'Web Store', type: 'own_site', code: 'WEB' }), 200).body.id;
  const profileId = expectStatus(
    await c.post('/api/import-profiles', { channelId, name: '標準CSV', mapping: STANDARD_TEMPLATE_MAPPING, dateFormat: 'yyyy-MM-dd HH:mm:ss' }),
    200,
  ).body.id;
  const warehouses: Record<string, string> = {};
  for (const [i, code] of (opts.warehouses ?? ['TKY']).entries()) {
    const id = expectStatus(await c.post('/api/warehouses', { code, name: `${code} 倉庫`, priority: 10 * (i + 1) }), 200).body.id;
    expectStatus(await c.post(`/api/warehouses/${id}/locations/bulk`, { lines: ['A-01', 'A-02', 'A-03', 'A-04', 'A-05'] }), 200);
    warehouses[code] = id;
  }
  const products: Record<string, string> = {};
  for (const sku of opts.skus ?? ['SKU-A', 'SKU-B', 'SKU-C']) {
    products[sku] = expectStatus(await c.post('/api/products', { sku, name: `商品 ${sku}`, barcodes: [{ code: `JAN-${sku}` }] }), 200).body.id;
  }
  const warehouseCode = Object.keys(warehouses)[0]!;
  return { orgId, owner, channelId, profileId, warehouseId: warehouses[warehouseCode]!, warehouseCode, products, warehouses };
}

export async function importCsv(client: TestClient, profileId: string, csv: Buffer, applyUpdateIds: string[] = []) {
  const pv = await uploadFile(client, '/api/imports/preview', { profileId }, csv);
  if (pv.status !== 200) throw new Error(`preview failed ${pv.status} ${pv.text}`);
  const cm = expectStatus(await client.post(`/api/imports/${pv.body.batchId}/commit`, { applyUpdateIds }), 200);
  return { preview: pv.body, commit: cm.body };
}

export async function locationsOf(client: TestClient, warehouseId: string): Promise<Record<string, string>> {
  const r = expectStatus(await client.get(`/api/warehouses/${warehouseId}/locations`), 200).body.items as { id: string; code: string }[];
  return Object.fromEntries(r.map((l) => [l.code, l.id]));
}

export async function receive(client: TestClient, locationId: string, productId: string, qty: number) {
  return expectStatus(await client.post('/api/inventory/receipts', { locationId, productId, qty, reason: 'test' }), 200).body;
}

export async function manualOrder(
  client: TestClient,
  channelId: string,
  ext: string,
  lines: { sku: string; quantity: number }[],
  extra: Record<string, unknown> = {},
): Promise<{ id: string; orderNumber: string; status: string }> {
  return expectStatus(
    await client.post('/api/orders', {
      channelId,
      order: {
        externalOrderId: ext,
        customer: { name: '顧客 太郎', email: `${ext.toLowerCase()}@example.test` },
        shipTo: { name: '顧客 太郎', postalCode: '150-0001', address1: '東京都渋谷区神宮前1-1-1', phone: '090-0000-0000' },
        lines,
        ...extra,
      },
    }),
    200,
  ).body;
}

export async function availability(client: TestClient, productId: string, warehouseId?: string) {
  const r = expectStatus(await client.get(`/api/inventory/balances?productId=${productId}${warehouseId ? `&warehouseId=${warehouseId}` : ''}`), 200).body.items as any[];
  const pick = r.filter((b) => b.kind === 'pick');
  return {
    onHand: pick.reduce((s, b) => s + b.onHand, 0),
    allocated: pick.reduce((s, b) => s + b.allocated, 0),
    held: pick.reduce((s, b) => s + b.held, 0),
    available: pick.reduce((s, b) => s + b.available, 0),
    balances: r,
  };
}

/** 手動注文を作成して引当（全量引当なら Fulfillment 化まで） */
export async function allocatedOrder(
  client: TestClient,
  channelId: string,
  ext: string,
  lines: { sku: string; quantity: number }[],
  opts: { warehouseId?: string; expect?: 'full' | 'partial' | 'none' } = {},
) {
  const o = await manualOrder(client, channelId, ext, lines);
  const r = expectStatus(await client.post(`/api/orders/${o.id}/allocate`, opts.warehouseId ? { warehouseId: opts.warehouseId } : {}), 200).body;
  if ((opts.expect ?? 'full') !== r.outcome) throw new Error(`allocation outcome ${r.outcome} (expected ${opts.expect ?? 'full'})`);
  return { ...o, allocation: r };
}

/** Wave を作成（省略時は倉庫の Wave 待ち全件）し、全タスクを全数ピックする */
export async function waveAndPickAll(client: TestClient, warehouseId: string, fulfillmentIds?: string[]) {
  const pv = expectStatus(await client.post('/api/waves/preview', { warehouseId }), 200).body;
  const ids: string[] = fulfillmentIds ?? pv.fulfillments.map((f: any) => f.id);
  const w = expectStatus(await client.post('/api/waves', { warehouseId, fulfillmentIds: ids }), 200).body;
  const detail = expectStatus(await client.get(`/api/waves/${w.waveId}`), 200).body;
  for (const t of detail.tasks) {
    const v = expectStatus(await client.post(`/api/pick-tasks/${t.id}/claim`), 200).body;
    for (const g of v.groups) {
      if (g.remaining > 0) {
        expectStatus(
          await client.post(`/api/pick-tasks/${t.id}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: g.sku, qty: g.remaining, inputMethod: 'manual' }),
          200,
        );
      }
    }
  }
  return { waveId: w.waveId as string, fulfillmentIds: ids };
}

export async function orderDetail(client: TestClient, orderId: string) {
  return expectStatus(await client.get(`/api/orders/${orderId}`), 200).body;
}

/** Fulfillment を梱包完了まで進める（1 箱）。下書き Shipment を返す */
export async function packFulfillment(client: TestClient, fulfillmentId: string) {
  const sid = expectStatus(await client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
  const v = expectStatus(await client.get(`/api/pack/sessions/${sid}`), 200).body;
  for (const it of v.items) {
    if (it.remaining <= 0) continue;
    expectStatus(await client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code: it.sku, inputMethod: 'manual' }), 200);
    if (it.remaining > 1) {
      expectStatus(await client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code: it.sku, qty: it.remaining - 1, inputMethod: 'manual' }), 200);
    }
  }
  const done = expectStatus(await client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() }), 200).body;
  return { sessionId: sid as string, shipments: done.shipments as { id: string; shipmentNumber: string; boxNo: number; items: { sku: string; quantity: number }[] }[] };
}

/** 注文 → 引当 → Wave → ピック → 梱包まで。下書き Shipment を返す */
export async function shipReadyOrder(
  s: { owner: TestUser; channelId: string; warehouseId: string },
  ext: string,
  lines: { sku: string; quantity: number }[],
) {
  const o = await allocatedOrder(s.owner.client, s.channelId, ext, lines);
  const d0 = await orderDetail(s.owner.client, o.id);
  const ffIds = d0.fulfillments.filter((f: any) => f.status === 'ready').map((f: any) => f.id);
  await waveAndPickAll(s.owner.client, s.warehouseId, ffIds);
  const packed = [];
  for (const id of ffIds) packed.push(await packFulfillment(s.owner.client, id));
  return { order: o, fulfillmentIds: ffIds as string[], shipments: packed.flatMap((p) => p.shipments) };
}
