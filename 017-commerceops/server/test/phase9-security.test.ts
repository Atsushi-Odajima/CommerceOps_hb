import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, TestClient, type TestEnv } from './helpers/env.js';
import { addMember, createOrg, createUserRow, TEST_PASSWORD, type TestUser } from './helpers/factory.js';
import { uploadFile } from './helpers/scenario.js';
import { PNG_1PX, richOrg, type RichOrg } from './helpers/rich.js';
import { expectIntegrity } from './helpers/integrity.js';
import { withSystem } from '../src/db/tx.js';
import { upsertMembership } from '../src/modules/orgs/service.js';
import { BACKUP_TABLES, PRIMARY_KEYS } from '../src/modules/backup/format.js';
import { serializeError } from '../src/app.js';
import { purgeOperationalData } from '../src/jobs/retention.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

/** Fastify のルート一覧（printRoutes の木構造を展開） */
function listRoutes(app: FastifyInstance): { method: string; url: string }[] {
  const out: { method: string; url: string }[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([│ ]*)[├└]── (.+?)(?: \(([^)]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    const full = (depth ? stack[depth - 1]! : '') + m[2]!;
    stack[depth] = full;
    stack.length = depth + 1;
    for (const meth of (m[3] ?? '').split(', ').filter(Boolean)) if (meth !== 'HEAD') out.push({ method: meth, url: full });
  }
  return out;
}

/** 組織の全業務テーブルの内容（変更検知用） */
async function fingerprint(orgId: string) {
  return env.tx(orgId, async (tx) => {
    const r: Record<string, string> = {};
    for (const t of BACKUP_TABLES) {
      r[t] = (await tx.one(`SELECT count(*)::int || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY ${PRIMARY_KEYS[t].map((k) => `x.${k}`).join(', ')})), '') AS h FROM ${t} x WHERE organization_id = $1`, [orgId])).h;
    }
    return r;
  });
}

describe('Phase9 tenant isolation sweep (R22) and security', () => {
  let a: RichOrg;
  let b: { orgId: string; owner: TestUser };
  beforeAll(async () => {
    a = await richOrg(env, 'IDORA');
    b = await createOrg(env);
    // B 側にも最低限のマスター（B の正当な ID と組み合わせた攻撃も試す）
    expectStatus(await b.owner.client.post('/api/warehouses', { code: 'BWH', name: 'B 倉庫' }), 200);
  });

  it('R22: every route with an id parameter rejects another organization’s ids (no 2xx, no 5xx, no data), and organization A is unchanged', async () => {
    const before = await fingerprint(a.orgId);
    const ids = a.ids;
    const idFor = (url: string, param: string): string => {
      if (param === 'itemId') return ids.orderItemId!;
      if (param === 'holdId') return ids.holdId!;
      if (param === 'barcodeId') return ids.barcodeId!;
      if (param === 'userId') return ids.userId!;
      if (param === 'lineId') return ids.stocktakeLineId!;
      const seg = url.split('/:' + param)[0]!.split('/').pop()!;
      const map: Record<string, string> = {
        orders: ids.orderId!,
        invitations: ids.invitationId!,
        warehouses: ids.warehouseId!,
        waves: ids.waveId!,
        locations: ids.locationId!,
        products: ids.productId!,
        'pick-tasks': ids.pickTaskId!,
        sessions: ids.packSessionId!,
        channels: ids.channelId!,
        customers: ids.customerId!,
        'import-profiles': ids.profileId!,
        imports: ids.importBatchId!,
        fulfillments: ids.fulfillmentId!,
        exceptions: ids.exceptionId!,
        shipments: ids.shipmentId!,
        returns: ids.returnId!,
        attachments: ids.attachmentId!,
        suppliers: ids.supplierId!,
        'purchase-orders': ids.purchaseOrderId!,
        stocktakes: ids.stocktakeId!,
        movements: ids.movementId!,
        jobs: '1',
      };
      if (!map[seg]) throw new Error(`no id mapping for ${url} (:${param})`);
      return map[seg]!;
    };
    const body = (url: string): Record<string, unknown> => {
      const last = url.split('/').pop()!;
      const uuid = randomUUID();
      const b2: Record<string, Record<string, unknown>> = {
        cancel: { reason: 'x', confirm: true },
        'cancel-lines': { lines: [{ itemId: ids.orderItemId, qty: 1 }], reason: 'x' },
        holds: { reasonCode: 'customer_confirm', note: 'x' },
        remap: { productId: ids.productId },
        address: { name: 'x', postalCode: '100-0001', address1: 'x', phone: '0', reason: 'x' },
        reject: { reason: 'x' },
        receive: { warehouseId: ids.warehouseId, items: [{ returnItemId: ids.returnItemId, receivedQty: 1 }] },
        'in-transit': { carrier: 'yamato', trackingNumber: '1234' },
        inspect: { clientRequestId: uuid, lines: [{ returnItemId: ids.returnItemId, disposition: 'restock', qty: 1 }] },
        exchange: { items: [{ sku: 'SKU-A', quantity: 1 }] },
        pick: { clientEventId: uuid, locationId: ids.locationId, code: 'SKU-A', qty: 1, inputMethod: 'manual' },
        short: { clientEventId: uuid, locationId: ids.locationId, productId: ids.productId, reasonCode: 'not_found' },
        correct: url.includes('/pack/') ? { clientEventId: uuid, fulfillmentItemId: uuid, qty: 1 } : { clientEventId: uuid, pickEventId: uuid, qty: 1 },
        assign: { userId: b.owner.userId },
        'scan-location': { clientEventId: uuid, code: 'A-01', expectedLocationId: ids.locationId, inputMethod: 'manual' },
        deallocate: { reason: 'x' },
        'next-box': { clientEventId: uuid },
        scan: { clientEventId: uuid, code: 'SKU-A', inputMethod: 'manual' },
        complete: { requestId: uuid },
        status: { status: 'investigating' },
        comment: { note: 'x' },
        'resolve-short': { action: 'backlog' },
        unpack: { reason: 'x' },
        commit: { applyUpdateIds: [] },
        barcodes: { code: 'IDOR-NEW' },
        locations: { code: 'Z-99' },
        bulk: { lines: ['Z-98'] },
        'password-reset': {},
      };
      // StockPilot 統合分（同じ末尾の別ルートと区別する）
      if (url.startsWith('/api/purchase-orders/') && last === 'receive') return { requestId: uuid, lines: [{ lineId: uuid, qty: 1 }] };
      if (url.startsWith('/api/purchase-orders/') && last === 'close') return { reason: 'x' };
      if (url === '/api/purchase-orders/:id') return { lines: [{ productId: ids.productId, qty: 1 }] };
      if (url === '/api/suppliers/:id') return { code: 'IDOR', name: 'IDOR' };
      if (last === 'replenishment') return { settings: null };
      if (last === 'reverse') return { reason: 'x', requestId: uuid };
      if (url.endsWith('/lines/:lineId')) return { countedQty: 1, version: 1 };
      if (b2[last]) return b2[last]!;
      if (/\/:id$|\/:userId$/.test(url)) {
        if (url.startsWith('/api/shipments')) return { carrier: 'yamato', trackingNumber: '1111' };
        if (url.startsWith('/api/users')) return { role: 'picker' };
        if (url.startsWith('/api/orders')) return { notes: 'x' };
        return { name: 'IDOR' };
      }
      return {};
    };
    const routes = listRoutes(env.app).filter((r) => r.url.includes('/:') && r.url.startsWith('/api/'));
    expect(routes.length).toBeGreaterThan(60);
    const results: { method: string; url: string; statuses: number[] }[] = [];
    const leaks: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:(\w+)/g, (_, p: string) => idFor(r.url, p));
      const statuses: number[] = [];
      const bodies = r.method === 'GET' || r.method === 'DELETE' ? [undefined] : [body(r.url), {}];
      for (const bd of bodies) {
        const res = await b.owner.client.request(r.method as 'GET', url, bd);
        statuses.push(res.status);
        if (res.text.includes('IDORA') || res.text.includes(a.orgId)) leaks.push(`${r.method} ${r.url}`);
      }
      results.push({ ...r, statuses });
    }
    const allowed = new Set([400, 403, 404, 409, 413, 415]);
    const bad = results.filter((x) => x.statuses.some((s) => !allowed.has(s)));
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    expect(leaks).toEqual([]);
    // 参照系（GET）は例外なく 404（存在自体を明かさない）
    const getNot404 = results.filter((x) => x.method === 'GET' && x.statuses[0] !== 404 && !x.url.startsWith('/api/jobs'));
    expect(getNot404, JSON.stringify(getNot404)).toEqual([]);
    // すべてのルートで ID の確認まで到達している（入力検証の 400 だけで終わったルートがない）
    const unreached = results.filter((x) => x.statuses.every((s) => s === 400)).map((x) => `${x.method} ${x.url}`);
    expect(unreached).toEqual([]);
    // マルチパート（写真）でも同じ
    expect((await uploadFile(b.owner.client, `/api/returns/${ids.returnId}/attachments`, {}, PNG_1PX, 'x.png')).status).toBe(404);
    expect(await fingerprint(a.orgId)).toEqual(before);
    await expectIntegrity(env, a.orgId);
  });

  it('warehouse scope: a manager limited to Osaka cannot read or operate Tokyo waves, tasks, pack sessions, fulfillments, shipments, returns, exceptions or locations', async () => {
    const oskManager = await addMember(env, a.orgId, 'ops_manager', { warehouseIds: [a.warehouses.OSK!] });
    const ids = a.ids;
    // 東京倉庫に紐づく例外（欠品例外は倉庫に紐づかない組織全体の例外なので、倉庫限定のマネージャーにも見える）
    const tkyException = expectStatus(await a.owner.client.post('/api/exceptions/report', { category: 'location_issue', note: '棚番ラベル剥がれ', warehouseId: a.warehouses.TKY, requestId: randomUUID() }), 200).body;
    const before = await fingerprint(a.orgId);
    const targets: Record<string, string> = {
      waves: ids.waveId!,
      'pick-tasks': ids.pickTaskId!,
      sessions: ids.packSessionId!,
      fulfillments: ids.fulfillmentId!,
      shipments: ids.shipmentId!,
      returns: ids.returnId!,
      exceptions: tkyException.id ?? tkyException.exceptionId,
      warehouses: ids.warehouseId!,
      locations: ids.locationId!,
    };
    expect(targets.exceptions).toBeTruthy();
    const routes = listRoutes(env.app).filter((r) => {
      const m = /^\/api\/(?:pack\/)?([a-z-]+)\/:id(\/|$)/.exec(r.url);
      return m && targets[m[1]!] && !r.url.includes(':itemId');
    });
    expect(routes.length).toBeGreaterThan(35);
    const bad: string[] = [];
    for (const r of routes) {
      const seg = /^\/api\/(?:pack\/)?([a-z-]+)\//.exec(r.url)![1]!;
      const url = r.url.replace(':id', targets[seg]!);
      const res = await oskManager.client.request(r.method as 'GET', url, r.method === 'GET' ? undefined : {});
      if (![400, 403, 404, 409].includes(res.status) || (r.method === 'GET' && ![403, 404].includes(res.status))) bad.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(bad).toEqual([]);
    // 一覧にも東京のデータは出ない
    for (const url of ['/api/waves', '/api/pick-tasks', '/api/shipments', '/api/returns', '/api/exceptions', '/api/fulfillments']) {
      const r = expectStatus(await oskManager.client.get(url), 200).body;
      const items = (r.items ?? []) as any[];
      expect(items.every((x) => !x.warehouseId || x.warehouseId === a.warehouses.OSK), url).toBe(true);
      expect(JSON.stringify(items), url).not.toContain(ids.waveId);
    }
    expect(await fingerprint(a.orgId)).toEqual(before);
  });

  it('R22: ids of organization A inside request bodies, filters, search and exports are never honored or revealed', async () => {
    const before = await fingerprint(a.orgId);
    const c = b.owner.client;
    const ids = a.ids;
    const reject = async (method: 'POST' | 'GET', url: string, bd?: unknown) => {
      const r = await c.request(method, url, bd);
      expect([400, 403, 404, 409], `${method} ${url} → ${r.status} ${r.text.slice(0, 200)}`).toContain(r.status);
      expect(r.text).not.toContain('IDORA');
    };
    await reject('POST', '/api/pack/open', { fulfillmentId: ids.fulfillmentId });
    await reject('POST', '/api/returns', { orderId: ids.orderId, reasonCode: 'defective', items: [{ orderItemId: ids.orderItemId, qty: 1 }] });
    await reject('POST', '/api/waves', { warehouseId: ids.warehouseId, fulfillmentIds: [ids.fulfillmentId] });
    await reject('POST', '/api/waves/preview', { warehouseId: ids.warehouseId });
    await reject('POST', '/api/inventory/receipts', { locationId: ids.locationId, productId: ids.productId, qty: 5, reason: 'x' });
    await reject('POST', '/api/inventory/adjustments', { locationId: ids.locationId, productId: ids.productId, mode: 'delta', qty: 5, reason: 'x', requestId: randomUUID() });
    await reject('POST', '/api/inventory/transfers', { fromLocationId: ids.locationId, toLocationId: ids.locationId, productId: ids.productId, qty: 1, requestId: randomUUID() });
    await reject('POST', '/api/orders', { channelId: ids.channelId, order: { externalOrderId: 'X', customer: { name: 'x' }, shipTo: { name: 'x', postalCode: '1', address1: 'x', phone: '0' }, lines: [{ sku: 'SKU-A', quantity: 1 }] } });
    await reject('POST', '/api/import-profiles', { channelId: ids.channelId, name: 'x', mapping: {} });
    await reject('POST', '/api/exceptions/report', { category: 'other', note: 'x', pickTaskId: ids.pickTaskId, requestId: randomUUID() });
    await reject('POST', '/api/users/invitations', { email: 'x@example.test', role: 'picker', warehouseIds: [ids.warehouseId] });
    await reject('POST', '/api/shipments/scan-confirm', { shipmentCode: 'SH-000001' });
    // 一括系は 200 でも A の対象には何もしない
    const bulk = expectStatus(await c.post('/api/shipments/bulk-confirm', { shipmentIds: [ids.shipmentId] }), 200).body;
    expect(bulk.results.every((r: any) => r.ok === false)).toBe(true);
    const run = expectStatus(await c.post('/api/allocation/run-now', { orderIds: [ids.holdOrderId] }), 200).body;
    expect(JSON.stringify(run)).not.toContain(ids.holdOrderId);
    // 絞り込み・検索・CSV 出力に A のデータが混ざらない
    for (const url of [
      `/api/orders?q=IDORA`,
      `/api/orders?warehouseId=${ids.warehouseId}`,
      `/api/search?q=IDORA`,
      `/api/search?q=FULL-1`,
      `/api/inventory/balances?productId=${ids.productId}`,
      `/api/inventory/movements?productId=${ids.productId}`,
      `/api/audit?entityId=${ids.orderId}`,
      `/api/returns/lookup?code=RT-000001`,
      `/api/products/lookup?code=JAN-SKU-A`,
      `/api/exceptions?q=IDORA`,
      `/api/orders/export?pii=full`,
      `/api/returns/export`,
      `/api/inventory/export`,
      `/api/shipments/export?type=all`,
      `/api/exceptions/export`,
      `/api/audit/export`,
      `/api/kpi?from=2026-01-01&to=2026-12-31`,
      `/api/dashboard/home`,
      `/api/assignments`,
      `/api/users`,
    ]) {
      const r = await c.get(url);
      expect([200, 400, 404], url).toContain(r.status);
      // 検索語そのもののエコー（"q"）は除いて確認
      const text = r.text.replace(/"q":"[^"]*"/, '');
      expect(text, url).not.toContain('IDORA');
      expect(text, url).not.toContain(ids.orderId);
      expect(text, url).not.toContain(a.owner.email);
    }
    expect(await fingerprint(a.orgId)).toEqual(before);
  });

  it('audit log: append-only at the DB level, filterable, role-restricted, CSV formula-safe, and free of personal data', async () => {
    const c = a.owner.client;
    // DB トリガーで UPDATE / DELETE を拒否（アプリの DB ロールでも）
    await expect(env.tx(a.orgId, (tx) => tx.exec(`UPDATE audit_logs SET summary = 'x' WHERE organization_id = $1`, [a.orgId]))).rejects.toThrow();
    await expect(env.tx(a.orgId, (tx) => tx.exec(`DELETE FROM audit_logs WHERE organization_id = $1`, [a.orgId]))).rejects.toThrow();
    const all = expectStatus(await c.get('/api/audit?limit=200'), 200).body;
    expect(all.total).toBeGreaterThan(20);
    expect(all.prefixes).toEqual(expect.arrayContaining(['order', 'return', 'shipment', 'inventory', 'user']));
    const byEntity = expectStatus(await c.get(`/api/audit?entityId=${a.ids.returnId}`), 200).body.items;
    expect(byEntity.length).toBeGreaterThan(2);
    expect(byEntity.every((x: any) => x.entityId === a.ids.returnId)).toBe(true);
    expect(byEntity.map((x: any) => x.action)).toEqual(expect.arrayContaining(['return.create', 'return.authorize', 'return.receive', 'return.inspect']));
    const byActor = expectStatus(await c.get(`/api/audit?actorId=${a.support.userId}&action=return`), 200).body.items;
    expect(byActor.length).toBeGreaterThan(0);
    expect(byActor.every((x: any) => x.actorUserId === a.support.userId && x.action.startsWith('return'))).toBe(true);
    // LIKE のワイルドカードは文字として扱う
    expect(expectStatus(await c.get('/api/audit?action=%25'), 200).body.total).toBe(0);
    // 権限: Manager は閲覧可、Picker / Packer / Support は不可
    expectStatus(await a.manager.client.get('/api/audit'), 200);
    for (const u of [a.picker, a.packer, a.support]) {
      expect((await u.client.get('/api/audit')).status).toBe(403);
      expect((await u.client.get('/api/audit/export')).status).toBe(403);
    }
    // CSV 出力（数式インジェクション対策）
    await env.tx(a.orgId, (tx) =>
      tx.exec(`INSERT INTO audit_logs (organization_id, id, actor_type, action, summary, metadata) VALUES ($1, $2, 'system', 'test.formula', '=HYPERLINK("http://evil")', '{}')`, [a.orgId, randomUUID()]),
    );
    const csv = await c.get('/api/audit/export?action=test');
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-disposition'])).toMatch(/audit_\d{4}-\d{2}-\d{2}\.csv/);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(expectStatus(await c.get('/api/audit?action=export.audit'), 200).body.total).toBe(1);
    // 個人情報（氏名・メール・電話・住所）が監査ログに入っていない
    const rows = await env.tx(a.orgId, (tx) => tx.many(`SELECT action, coalesce(summary, '') || ' ' || metadata::text AS t FROM audit_logs WHERE organization_id = $1`, [a.orgId]));
    const hits = rows.filter((r) => [a.pii.name, a.pii.email, a.pii.phone, a.pii.address, 'IDORA', '090-9876-5432'].some((p) => r.t.includes(p)));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('personal data minimization: Picker sees no customer name/address/phone; Packer sees ship-to only; exports bound PII by permission', async () => {
    const pickTaskList = expectStatus(await a.picker.client.get('/api/pick-tasks'), 200);
    expect(pickTaskList.text).not.toContain('IDORA');
    const task = await a.picker.client.get(`/api/pick-tasks/${a.ids.pickTaskId}`);
    expect([200, 403, 404]).toContain(task.status);
    expect(task.text).not.toContain('IDORA');
    expect(task.text).not.toContain('090-9876-5432');
    expect((await a.picker.client.get(`/api/orders/${a.ids.orderId}`)).status).toBe(403);
    expect((await a.picker.client.get('/api/orders/export')).status).toBe(403);
    // Packer: 送付先は見える（梱包に必要）が購入者のメール・電話は出さない
    const slip = await a.packer.client.get(`/api/fulfillments/${a.ids.fulfillmentId}/packing-slip`);
    expect(slip.status).toBe(200);
    expect(slip.text).not.toContain(a.pii.email);
    // Support は PII 付き出力可、Manager の既定出力は PII なし
    const mgr = await a.manager.client.get('/api/orders/export');
    expect(mgr.status).toBe(200);
    expect(mgr.text).not.toContain(a.pii.email);
  });

  it('account takeover guards: invitation cannot set a password on an unclaimed account that belongs to another organization; disabled accounts stay disabled; reset links only for users you fully manage', async () => {
    const x = await createOrg(env);
    const y = await createOrg(env);
    // X に所属する、パスワード未設定の招待中アカウント（例: 復元で作られたユーザー）
    const email = `unclaimed-${randomUUID().slice(0, 8)}@example.test`;
    const uid = randomUUID();
    await env.deps.pool.query(`INSERT INTO users (id, email, name, password_hash, status) VALUES ($1, $2, 'U', NULL, 'invited')`, [uid, email]);
    await withSystem(env.deps.pool, (cl) => upsertMembership(cl, x.orgId, uid, 'ops_manager', null));
    // Y の Owner がそのメールアドレスを招待し、自分で承諾してパスワードを設定しようとする
    const inv = expectStatus(await y.owner.client.post('/api/users/invitations', { email, role: 'picker' }), 200).body;
    const token = /#t=(.+)$/.exec(inv.url)![1]!;
    const anon = new TestClient(env.app);
    const acc = await anon.post('/api/auth/invitations/accept', { token, password: 'Attacker-Pass-2026' });
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe('ACCOUNT_NEEDS_RESET');
    expect((await env.deps.pool.query('SELECT password_hash FROM users WHERE id = $1', [uid])).rows[0].password_hash).toBeNull();
    // 無効化されたアカウントは招待の承諾で復活しない
    const email2 = `disabled-${randomUUID().slice(0, 8)}@example.test`;
    const uid2 = await createUserRow(env, email2, 'D');
    await env.deps.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [uid2]);
    const inv2 = expectStatus(await y.owner.client.post('/api/users/invitations', { email: email2, role: 'picker' }), 200).body;
    const acc2 = await anon.post('/api/auth/invitations/accept', { token: /#t=(.+)$/.exec(inv2.url)![1], password: 'Attacker-Pass-2026' });
    expect(acc2.status).toBe(403);
    expect(acc2.body.error.code).toBe('ACCOUNT_DISABLED');
    // 既存の有効アカウントは本人のパスワードが必要（パスワード未設定の有効アカウントも常に不一致）
    const email3 = `nopw-${randomUUID().slice(0, 8)}@example.test`;
    await env.deps.pool.query(`INSERT INTO users (id, email, name, password_hash, status) VALUES ($1, $2, 'N', NULL, 'active')`, [randomUUID(), email3]);
    const inv3 = expectStatus(await y.owner.client.post('/api/users/invitations', { email: email3, role: 'picker' }), 200).body;
    expect((await anon.post('/api/auth/invitations/accept', { token: /#t=(.+)$/.exec(inv3.url)![1], password: 'Attacker-Pass-2026' })).body.error.code).toBe('INVALID_PASSWORD');
    // パスワード再設定リンク: 両方の組織に所属するユーザーは、片方の Owner からは発行できない
    const shared = await addMember(env, x.orgId, 'picker');
    await withSystem(env.deps.pool, (cl) => upsertMembership(cl, y.orgId, shared.userId, 'picker', null));
    expect((await x.owner.client.post(`/api/users/${shared.userId}/password-reset`, {})).body.error.code).toBe('USER_IN_OTHER_ORGANIZATION');
    expect((await y.owner.client.post(`/api/users/${shared.userId}/password-reset`, {})).body.error.code).toBe('USER_IN_OTHER_ORGANIZATION');
    // 別の組織での所属が無効化中でも同じ（後で有効に戻されると乗っ取りになる）
    const disabledElsewhere = await addMember(env, x.orgId, 'packer');
    await withSystem(env.deps.pool, (cl) => upsertMembership(cl, y.orgId, disabledElsewhere.userId, 'packer', null));
    await env.deps.pool.query(`UPDATE memberships SET status = 'disabled' WHERE organization_id = $1 AND user_id = $2`, [y.orgId, disabledElsewhere.userId]);
    expect((await x.owner.client.post(`/api/users/${disabledElsewhere.userId}/password-reset`, {})).body.error.code).toBe('USER_IN_OTHER_ORGANIZATION');
    // 両方の組織の Owner なら発行できる／片方だけに所属するユーザーは発行できる
    await withSystem(env.deps.pool, (cl) => upsertMembership(cl, y.orgId, x.owner.userId, 'owner', null));
    expectStatus(await x.owner.client.post(`/api/users/${shared.userId}/password-reset`, {}), 200);
    const onlyX = await addMember(env, x.orgId, 'packer');
    expectStatus(await x.owner.client.post(`/api/users/${onlyX.userId}/password-reset`, {}), 200);
    // 他組織のユーザーには発行できない（存在も明かさない）
    expect((await y.owner.client.post(`/api/users/${onlyX.userId}/password-reset`, {})).status).toBe(404);
  });

  it('HTTP hardening: security headers, CSRF, session rotation and logout, generic errors, injection-shaped input, payload limits', async () => {
    const anon = new TestClient(env.app);
    // セキュリティヘッダー
    const h = (await anon.get('/api/auth/me')).headers;
    const csp = String(h['content-security-policy']);
    for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp).toContain(d);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(String(h['permissions-policy'])).toContain('geolocation=()');
    expect(h['x-powered-by']).toBeUndefined();
    // CSRF: カスタムヘッダー / トークンなしの変更系は拒否
    const u = await addMember(env, b.orgId, 'ops_manager');
    const noHeader = await env.app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: u.client.cookie, 'x-csrf-token': u.client.csrf }, payload: {} });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe('CSRF_HEADER_MISSING');
    const badToken = await u.client.request('POST', '/api/orders', {}, { 'x-csrf-token': 'x'.repeat(43) });
    expect(badToken.status).toBe(403);
    expect(badToken.body.error.code).toBe('CSRF_TOKEN_INVALID');
    // セッション: ログインごとに新しいセッション ID（固定化対策）、ログアウトで無効化、Cookie は HttpOnly + SameSite
    const s1 = new TestClient(env.app);
    const login = await s1.post('/api/auth/login', { email: u.email, password: TEST_PASSWORD });
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    s1.csrf = login.body.csrfToken;
    const first = s1.cookie;
    const s2 = new TestClient(env.app);
    s2.cookie = first; // 攻撃者が同じ Cookie を持っていても
    await s1.post('/api/auth/logout', {});
    expect((await s2.get('/api/auth/me')).status).toBe(401);
    await s1.login(u.email, TEST_PASSWORD);
    expect(s1.cookie).not.toBe(first);
    // パスワード誤りは存在の有無を区別しない
    const wrong = await anon.post('/api/auth/login', { email: u.email, password: 'Wrong-Password-1' });
    const none = await anon.post('/api/auth/login', { email: 'nobody@example.test', password: 'Wrong-Password-1' });
    expect([wrong.status, none.status]).toEqual([401, 401]);
    expect(wrong.body.error).toEqual(none.body.error);
    // エラー応答は一般的な文言のみ（スタック・SQL を出さない）
    const badJson = await env.app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: u.client.cookie, 'x-csrf-token': u.client.csrf, 'x-requested-with': 'CommerceOps', 'content-type': 'application/json' }, payload: '{"broken"' });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.body).not.toMatch(/at \w+ \(|node_modules|SELECT|stack/i);
    const badUuid = await u.client.get('/api/orders/not-a-uuid');
    expect(badUuid.status).toBe(400);
    expect(badUuid.text).not.toMatch(/invalid input syntax|stack/i);
    // SQL インジェクション風の入力は値として扱われる
    for (const q of ["' OR '1'='1", "%' OR 1=1 --", "'); DROP TABLE orders; --", '\\', '_%']) {
      const r = await u.client.get(`/api/orders?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual([]);
      const sr = await u.client.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(sr.status).toBe(200);
    }
    expect(Number((await env.deps.pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'orders'`)).rows[0].n)).toBe(1);
    // 本文サイズの上限
    const big = await u.client.request('POST', '/api/orders', { pad: 'x'.repeat(3 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const bigFile = await uploadFile(a.owner.client, '/api/products/import', {}, Buffer.alloc(21 * 1024 * 1024, 0x41), 'big.csv');
    expect(bigFile.status).toBe(413);
    expect(bigFile.body.error.code).toBe('FILE_TOO_LARGE');
    // 未知の API は 404（SPA の index.html を返さない）
    expect((await u.client.get('/api/does-not-exist')).status).toBe(404);
  });

  it('logs never contain row values from database errors (PostgreSQL detail) — error serializer', () => {
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_uq"'), {
      code: '23505',
      detail: 'Key (lower(email))=(hanako@example.test) already exists.',
      where: 'SQL statement "INSERT ..."',
      constraint: 'users_email_uq',
      table: 'users',
    });
    const s = serializeError(pgErr);
    expect(JSON.stringify(s)).not.toContain('hanako@example.test');
    expect(s).toMatchObject({ code: '23505', constraint: 'users_email_uq', table: 'users', type: 'Error' });
    expect(s).not.toHaveProperty('detail');
    expect(s).not.toHaveProperty('where');
  });

  it('retention: finished jobs, old security events and used reset tokens are purged; queued/running jobs and recent rows are kept', async () => {
    const pool = env.deps.pool;
    const tag = `ret-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO jobs (type, status, payload, created_at, finished_at) VALUES
         ($1, 'succeeded', '{}', now() - interval '10 days', now() - interval '10 days'),
         ($1, 'succeeded', '{}', now() - interval '1 day', now() - interval '1 day'),
         ($1, 'dead', '{}', now() - interval '40 days', now() - interval '40 days'),
         ($1, 'dead', '{}', now() - interval '10 days', now() - interval '10 days'),
         ($1, 'queued', '{}', now() - interval '60 days', NULL)`,
      [tag],
    );
    const uid = await createUserRow(env, `${tag}@example.test`, 'R');
    await pool.query(`INSERT INTO security_events (id, user_id, event_type, created_at) VALUES ($1, $3, 'login_success', now() - interval '400 days'), ($2, $3, 'login_success', now())`, [randomUUID(), randomUUID(), uid]);
    await pool.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at) VALUES
         (decode(md5($2 || 'a'), 'hex'), $1, now() - interval '40 days', now() - interval '41 days', now() - interval '41 days'),
         (decode(md5($2 || 'b'), 'hex'), $1, now() + interval '1 day', NULL, now())`,
      [uid, tag],
    );
    const r = await purgeOperationalData(env.deps);
    expect(r.jobs).toBeGreaterThanOrEqual(2);
    const left = (await pool.query(`SELECT status, finished_at IS NULL AS open FROM jobs WHERE type = $1 ORDER BY status, created_at`, [tag])).rows;
    expect(left).toEqual([
      { status: 'dead', open: false },
      { status: 'queued', open: true },
      { status: 'succeeded', open: false },
    ]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM security_events WHERE user_id = $1`, [uid])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1`, [uid])).rows[0].n).toBe(1);
  });

  it('login rate limit applies per IP outside of test mode', async () => {
    const e2 = await createTestEnv({ NODE_ENV: 'development', LOGIN_RATE_LIMIT_MAX: '3', RATE_LIMIT_MAX: '1000' });
    try {
      const c = new TestClient(e2.app);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login', { email: 'nobody@example.test', password: 'Wrong-Password-1' })).status);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await e2.close();
    }
  });
});
