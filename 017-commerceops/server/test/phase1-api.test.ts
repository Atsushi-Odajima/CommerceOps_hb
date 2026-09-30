import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, TestClient, type TestEnv } from './helpers/env.js';
import { addMember, createOrg } from './helpers/factory.js';
import { STANDARD_TEMPLATE_MAPPING } from '../src/modules/channels/routes.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer | string }) {
  const boundary = '----co' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`),
  );
  parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(client: TestClient, url: string, fields: Record<string, string>, file: { name: string; content: Buffer | string }) {
  const mp = multipart(fields, file);
  const res = await client.app.inject({
    method: 'POST',
    url,
    payload: mp.body,
    headers: {
      'content-type': mp.contentType,
      'x-requested-with': 'CommerceOps',
      'x-csrf-token': client.csrf,
      cookie: client.cookie,
    },
  });
  return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body };
}

describe('warehouses & locations', () => {
  it('owner creates a warehouse with default locations; duplicate code rejected', async () => {
    const { owner } = await createOrg(env);
    const r = expectStatus(await owner.client.post('/api/warehouses', { code: 'TKY', name: '東京倉庫', cutoffTime: '14:00' }), 200);
    const locs = expectStatus(await owner.client.get(`/api/warehouses/${r.body.id}/locations`), 200).body.items;
    expect(locs.map((l: any) => l.code).sort()).toEqual(['DAMAGED', 'DEFAULT', 'QUARANTINE']);
    expect(locs.find((l: any) => l.code === 'DAMAGED').kind).toBe('damaged');
    expect((await owner.client.post('/api/warehouses', { code: 'TKY', name: 'dup' })).status).toBe(409);
    // ロケーション一括登録
    const bulk = expectStatus(await owner.client.post(`/api/warehouses/${r.body.id}/locations/bulk`, { lines: ['A-01-01,A', 'A-01-02,A', 'B-01-01,B'] }), 200);
    expect(bulk.body.created).toBe(3);
    const wl = expectStatus(await owner.client.get('/api/warehouses'), 200).body.items;
    expect(wl[0].cutoffTime).toBe('14:00');
  });

  it('ops manager cannot create warehouses (owner-only setting); picker cannot either', async () => {
    const { orgId } = await createOrg(env);
    const mgr = await addMember(env, orgId, 'ops_manager');
    const picker = await addMember(env, orgId, 'picker');
    expect((await mgr.client.post('/api/warehouses', { code: 'X', name: 'x' })).status).toBe(403);
    expect((await picker.client.post('/api/warehouses', { code: 'X', name: 'x' })).status).toBe(403);
  });

  it('warehouse-scoped user only sees their warehouses', async () => {
    const { orgId, owner } = await createOrg(env);
    const a = expectStatus(await owner.client.post('/api/warehouses', { code: 'A', name: 'A' }), 200).body.id;
    const b = expectStatus(await owner.client.post('/api/warehouses', { code: 'B', name: 'B' }), 200).body.id;
    const picker = await addMember(env, orgId, 'picker', { warehouseIds: [a] });
    const list = expectStatus(await picker.client.get('/api/warehouses'), 200).body.items;
    expect(list.map((w: any) => w.id)).toEqual([a]);
    expect((await picker.client.get(`/api/warehouses/${b}/locations`)).status).toBe(403);
  });
});

describe('products & barcodes', () => {
  it('create product with JAN, lookup by barcode and SKU, barcode uniqueness', async () => {
    const { owner } = await createOrg(env);
    const p = expectStatus(
      await owner.client.post('/api/products', { sku: 'TS-RED-M', name: 'Tシャツ', variant: 'Red / M', groupCode: 'TS', barcodes: [{ code: '4901234567894' }] }),
      200,
    );
    const detail = expectStatus(await owner.client.get(`/api/products/${p.body.id}`), 200).body;
    expect(detail.barcodes[0]).toMatchObject({ code: '4901234567894', symbology: 'ean13' });
    expect(expectStatus(await owner.client.get('/api/products/lookup?code=4901234567894'), 200).body.product.sku).toBe('TS-RED-M');
    expect(expectStatus(await owner.client.get('/api/products/lookup?code=TS-RED-M'), 200).body.product.sku).toBe('TS-RED-M');
    const p2 = expectStatus(await owner.client.post('/api/products', { sku: 'TS-BLU-M', name: 'Tシャツ' }), 200);
    expect((await owner.client.post(`/api/products/${p2.body.id}/barcodes`, { code: '4901234567894' })).status).toBe(409);
    expect((await owner.client.post('/api/products', { sku: 'TS-RED-M', name: 'dup' })).status).toBe(409);
    // http 画像 URL は拒否（XSS/混在コンテンツ対策）
    expect((await owner.client.post('/api/products', { sku: 'IMG', name: 'x', imageUrl: 'javascript:alert(1)' })).status).toBe(400);
  });

  it('product CSV import validates all rows first (dry run), then upserts', async () => {
    const { owner } = await createOrg(env);
    const bad = 'sku,name,variant,group_code,barcodes,weight_g,image_url,active\nA-1,商品A,,,4901234567894,100,,1\n,名前なし,,,,,,1\n';
    const r1 = await upload(owner.client, '/api/products/import', {}, { name: 'p.csv', content: bad });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(false);
    expect(r1.body.errorCount).toBe(1);
    const list0 = expectStatus(await owner.client.get('/api/products'), 200).body;
    expect(list0.total).toBe(0);
    const good = 'sku,name,variant,group_code,barcodes,weight_g,image_url,active\nA-1,商品A,,,4901234567894,100,,1\nA-2,商品B,,,4901234567900|A2-INT,,,1\n';
    const r2 = await upload(owner.client, '/api/products/import', {}, { name: 'p.csv', content: good });
    expect(r2.body).toMatchObject({ ok: true, created: 2, updated: 0 });
    const r3 = await upload(owner.client, '/api/products/import', {}, { name: 'p.csv', content: good });
    expect(r3.body).toMatchObject({ ok: true, created: 0, updated: 2 });
    expect(expectStatus(await owner.client.get('/api/products/lookup?code=A2-INT'), 200).body.product.sku).toBe('A-2');
  });

  it('support can read products but cannot create them', async () => {
    const { orgId } = await createOrg(env);
    const support = await addMember(env, orgId, 'support');
    expect((await support.client.get('/api/products')).status).toBe(200);
    expect((await support.client.post('/api/products', { sku: 'X', name: 'x' })).status).toBe(403);
  });
});

describe('channels & import profiles', () => {
  it('create channel + profile from the standard template; invalid date format rejected', async () => {
    const { owner } = await createOrg(env);
    const ch = expectStatus(await owner.client.post('/api/channels', { name: 'Web Store', type: 'own_site', code: 'WEB' }), 200);
    const prof = await owner.client.post('/api/import-profiles', {
      channelId: ch.body.id,
      name: '標準CSV',
      mapping: STANDARD_TEMPLATE_MAPPING,
    });
    expectStatus(prof, 200);
    const got = expectStatus(await owner.client.get(`/api/import-profiles/${prof.body.id}`), 200).body;
    expect(got.version).toBe(1);
    expectStatus(await owner.client.patch(`/api/import-profiles/${prof.body.id}`, { dateFormat: 'yyyy/MM/dd HH:mm:ss' }), 200);
    expect(expectStatus(await owner.client.get(`/api/import-profiles/${prof.body.id}`), 200).body.version).toBe(2);
    const bad = await owner.client.patch(`/api/import-profiles/${prof.body.id}`, { dateFormat: 'HH:mm' });
    expect(bad.status).toBe(400);
    // 任意コード・正規表現の変換は受け付けない
    const evil = await owner.client.post('/api/import-profiles', {
      channelId: ch.body.id,
      name: 'evil',
      mapping: { ...STANDARD_TEMPLATE_MAPPING, notes: { source: { column: '備考' }, transforms: [{ op: 'eval', code: 'x' }] } },
    });
    expect(evil.status).toBe(400);
  });

  it('inspect suggests mapping; test endpoint maps sample rows', async () => {
    const { owner } = await createOrg(env);
    const ch = expectStatus(await owner.client.post('/api/channels', { name: 'MP-A', type: 'other', code: 'MPA' }), 200);
    const csv = 'Order ID,Order Date,SKU,Qty,Recipient Name,Postal Code,Address1\nMP-1,2026-09-30 10:00:00,S-1,2,山田 太郎,1500001,東京都渋谷区1-1\n';
    const ins = await upload(owner.client, '/api/import-profiles/inspect', { encoding: 'utf-8' }, { name: 'o.csv', content: csv });
    expect(ins.status).toBe(200);
    expect(ins.body.matched.externalOrderId).toBe('Order ID');
    expect(ins.body.matched.quantity).toBe('Qty');
    const profile = {
      channelId: ch.body.id,
      name: 'MP-A',
      mapping: ins.body.suggestedMapping,
    };
    const test = await upload(owner.client, '/api/import-profiles/test', { profile: JSON.stringify(profile) }, { name: 'o.csv', content: csv });
    expect(test.status).toBe(200);
    expect(test.body.columnProblems).toEqual([]);
    expect(test.body.rows[0].values.postalCode).toBe('150-0001');
    expect(test.body.rows[0].issues).toEqual([]);
  });

  it('ops manager can use profiles (read) but not edit them', async () => {
    const { orgId, owner } = await createOrg(env);
    const ch = expectStatus(await owner.client.post('/api/channels', { name: 'W', type: 'own_site', code: 'W' }), 200);
    const prof = expectStatus(await owner.client.post('/api/import-profiles', { channelId: ch.body.id, name: 'p', mapping: STANDARD_TEMPLATE_MAPPING }), 200);
    const mgr = await addMember(env, orgId, 'ops_manager');
    expect((await mgr.client.get('/api/import-profiles')).status).toBe(200);
    expect((await mgr.client.patch(`/api/import-profiles/${prof.body.id}`, { name: 'x' })).status).toBe(403);
  });
});

describe('users, invitations, roles', () => {
  it('owner invites a picker → accept → login shows picker permissions only', async () => {
    const { owner } = await createOrg(env);
    const inv = expectStatus(await owner.client.post('/api/users/invitations', { email: 'new.picker@example.test', role: 'picker' }), 200);
    const token = /#t=(.+)$/.exec(inv.body.url)![1]!;
    const anon = new TestClient(env.app);
    const preview = expectStatus(await anon.post('/api/auth/invitations/preview', { token }), 200);
    expect(preview.body.role).toBe('picker');
    // 弱いパスワードは拒否
    expect((await anon.post('/api/auth/invitations/accept', { token, name: 'P', password: 'short' })).status).toBe(400);
    expectStatus(await anon.post('/api/auth/invitations/accept', { token, name: 'ピッカー', password: 'Picker-Pass-2026' }), 200);
    const me = expectStatus(await anon.get('/api/auth/me'), 200).body;
    expect(me.role).toBe('picker');
    expect(me.permissions).not.toContain('orders.read');
    // 招待は 1 回限り
    expect((await new TestClient(env.app).post('/api/auth/invitations/accept', { token, name: 'x', password: 'Another-Pass-2026' })).status).toBe(404);
  });

  it('cannot demote or disable the last owner', async () => {
    const { owner } = await createOrg(env);
    const r = await owner.client.patch(`/api/users/${owner.userId}`, { role: 'ops_manager' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('LAST_OWNER');
  });

  it('disabling a member revokes their session immediately', async () => {
    const { orgId, owner } = await createOrg(env);
    const picker = await addMember(env, orgId, 'picker');
    expect((await picker.client.get('/api/auth/me')).status).toBe(200);
    expectStatus(await owner.client.patch(`/api/users/${picker.userId}`, { status: 'disabled' }), 200);
    const me = await picker.client.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('password reset link issued by owner works once', async () => {
    const { orgId, owner } = await createOrg(env);
    const packer = await addMember(env, orgId, 'packer');
    const rs = expectStatus(await owner.client.post(`/api/users/${packer.userId}/password-reset`), 200);
    const token = /#t=(.+)$/.exec(rs.body.url)![1]!;
    const anon = new TestClient(env.app);
    expectStatus(await anon.post('/api/auth/password-reset', { token, newPassword: 'Brand-New-Pass-2026' }), 200);
    expect((await anon.post('/api/auth/password-reset', { token, newPassword: 'Brand-New-Pass-2027' })).status).toBe(404);
    await new TestClient(env.app).login(packer.email, 'Brand-New-Pass-2026');
  });

  it('non-owner cannot list users or invite', async () => {
    const { orgId } = await createOrg(env);
    const mgr = await addMember(env, orgId, 'ops_manager');
    expect((await mgr.client.get('/api/users')).status).toBe(403);
    expect((await mgr.client.post('/api/users/invitations', { email: 'x@example.test', role: 'owner' })).status).toBe(403);
  });
});
