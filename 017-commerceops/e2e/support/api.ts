import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

export const PASSWORD = 'E2e-Passw0rd-2026';
const H = { 'x-requested-with': 'CommerceOps' };

/** API クライアント（Cookie は APIRequestContext が保持、CSRF トークンはログイン応答から） */
export class Api {
  constructor(
    public readonly ctx: APIRequestContext,
    public readonly baseURL: string,
    public csrf = '',
  ) {}

  static async login(baseURL: string, email: string, password = PASSWORD, orgId?: string): Promise<Api> {
    const ctx = await pwRequest.newContext({ baseURL });
    const r = await ctx.post('/api/auth/login', { headers: H, data: { email, password } });
    if (!r.ok()) throw new Error(`login ${email} failed: ${r.status()} ${await r.text()}`);
    const body = await r.json();
    const api = new Api(ctx, baseURL, body.csrfToken);
    if (orgId && body.organization?.id !== orgId) {
      await api.post('/auth/switch-org', { organizationId: orgId });
      api.csrf = (await api.get('/auth/me')).csrfToken;
    }
    return api;
  }

  async raw(method: string, url: string, data?: unknown) {
    return this.ctx.fetch(`/api${url}`, { method, headers: { ...H, 'x-csrf-token': this.csrf }, data });
  }
  async call<T = any>(method: string, url: string, data?: unknown): Promise<T> {
    const r = await this.raw(method, url, data);
    const text = await r.text();
    if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  get<T = any>(url: string) {
    return this.call<T>('GET', url);
  }
  post<T = any>(url: string, data: unknown = {}) {
    return this.call<T>('POST', url, data);
  }
  patch<T = any>(url: string, data: unknown = {}) {
    return this.call<T>('PATCH', url, data);
  }
  put<T = any>(url: string, data: unknown = {}) {
    return this.call<T>('PUT', url, data);
  }
  async dispose() {
    await this.ctx.dispose();
  }
}

export const uniq = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 新しい組織（セルフサインアップ）+ Owner */
export async function signupOrg(baseURL: string, name = uniq('E2E 商店 ')) {
  const email = `${uniq('owner-')}@e2e.test`;
  const ctx = await pwRequest.newContext({ baseURL });
  const r = await ctx.post('/api/auth/signup', { headers: H, data: { organizationName: name, name: 'E2E オーナー', email, password: PASSWORD } });
  if (!r.ok()) throw new Error(`signup failed ${r.status()} ${await r.text()}`);
  await ctx.dispose();
  const api = await Api.login(baseURL, email);
  const me = await api.get('/auth/me');
  return { api, email, orgId: me.organization.id as string, orgName: name };
}

/** 招待 → 承諾でユーザーを作る（実際の運用と同じ経路） */
export async function inviteUser(owner: Api, role: 'ops_manager' | 'picker' | 'packer' | 'support', opts: { warehouseIds?: string[] | null } = {}) {
  const email = `${uniq(role + '-')}@e2e.test`;
  const inv = await owner.post('/users/invitations', { email, name: `${role} E2E`, role, warehouseIds: opts.warehouseIds ?? null });
  const ctx = await pwRequest.newContext({ baseURL: owner.baseURL });
  const r = await ctx.post('/api/auth/invitations/accept', { headers: H, data: { token: inv.url.split('#t=')[1], name: `${role} E2E`, password: PASSWORD } });
  if (!r.ok()) throw new Error(`accept failed ${r.status()} ${await r.text()}`);
  await ctx.dispose();
  return { email, api: await Api.login(owner.baseURL, email) };
}

/** EAN-13 のチェックデジット */
export function ean13(d12: string) {
  const s = [...d12].reduce((a, ch, i) => a + Number(ch) * (i % 2 ? 3 : 1), 0);
  return d12 + String((10 - (s % 10)) % 10);
}

export interface Seed {
  warehouses: Record<'TKY' | 'OSK', string>;
  locations: Record<'TKY' | 'OSK', Record<string, { id: string; code: string; barcode: string }>>;
  products: Record<string, { id: string; sku: string; jan: string }>;
  channels: Record<'WEB' | 'MPA' | 'MAN', string>;
  profileId: string;
}

/** 倉庫（東京・大阪）・ロケーション・商品（JAN 付き）・チャネル 3 つ・標準 CSV の Import Profile */
export async function seed(api: Api, skus: string[], janPrefix = String(Math.floor(Math.random() * 900000) + 100000)): Promise<Seed> {
  const warehouses = {} as Seed['warehouses'];
  const locations = {} as Seed['locations'];
  for (const [i, code] of (['TKY', 'OSK'] as const).entries()) {
    const id = (await api.post('/warehouses', { code, name: code === 'TKY' ? '東京倉庫' : '大阪倉庫', priority: 10 * (i + 1) })).id;
    await api.post(`/warehouses/${id}/locations/bulk`, { lines: ['A-01,A,1', 'A-02,A,2', 'A-03,A,3', 'B-01,B,4', 'B-02,B,5'] });
    warehouses[code] = id;
    const locs = (await api.get(`/warehouses/${id}/locations?kind=pick`)).items as { id: string; code: string; barcode: string }[];
    locations[code] = Object.fromEntries(locs.map((l) => [l.code, l]));
  }
  const products: Seed['products'] = {};
  for (const [i, sku] of skus.entries()) {
    const jan = ean13(`49${janPrefix}${String(i + 1).padStart(4, '0')}`);
    const id = (await api.post('/products', { sku, name: `E2E 商品 ${sku}`, barcodes: [{ code: jan }] })).id;
    products[sku] = { id, sku, jan };
  }
  const meta = await api.get('/import-profiles/meta');
  const channels = {} as Seed['channels'];
  let profileId = '';
  for (const [name, code, type] of [
    ['Web Store', 'WEB', 'own_site'],
    ['Marketplace A', 'MPA', 'amazon'],
    ['Manual', 'MAN', 'manual'],
  ] as const) {
    channels[code] = (await api.post('/channels', { name, code, type })).id;
    if (code === 'WEB') profileId = (await api.post('/import-profiles', { channelId: channels.WEB, name: '標準 CSV', mapping: meta.standardTemplate, dateFormat: 'yyyy-MM-dd HH:mm:ss' })).id;
  }
  return { warehouses, locations, products, channels, profileId };
}

export async function receive(api: Api, locationId: string, productId: string, qty: number) {
  return api.post('/inventory/receipts', { locationId, productId, qty, reason: 'E2E 初期在庫', requestId: randomUUID() });
}

export async function manualOrder(api: Api, channelId: string, ext: string, lines: { sku: string; quantity: number }[]) {
  return api.post('/orders', {
    channelId,
    order: {
      externalOrderId: ext,
      customer: { name: 'E2E 太郎', email: `${ext.toLowerCase()}@e2e.test` },
      shipTo: { name: 'E2E 太郎', postalCode: '150-0001', prefecture: '東京都', city: '渋谷区', address1: '神宮前1-1-1', phone: '090-0000-0000' },
      lines,
    },
  });
}

/** 標準テンプレート形式の注文 CSV（UTF-8 BOM） */
export function ordersCsv(rows: { ext: string; sku: string; qty: number; name?: string }[]) {
  const header = '注文番号,注文日時,購入者名,購入者メール,購入者電話,送付先氏名,郵便番号,都道府県,市区町村,住所1,住所2,送付先電話,配送方法,備考,SKU,商品名,数量,単価';
  const lines = rows.map((r) => [r.ext, '2026-09-30 09:00:00', r.name ?? '山田 花子', 'hanako@e2e.test', '090-1111-2222', r.name ?? '山田 花子', '1500001', '東京都', '渋谷区', '神宮前2-2-2', '', '090-1111-2222', '宅配便', '', r.sku, `商品 ${r.sku}`, r.qty, '1200'].join(','));
  return Buffer.from('﻿' + [header, ...lines].join('\r\n') + '\r\n', 'utf8');
}

export const DEVICES = {
  pc: { viewport: { width: 1366, height: 900 } } satisfies BrowserContextOptions,
} as const;

/** 画面でログイン（端末ごとのコンテキスト） */
export async function loginPage(browser: Browser, email: string, options: BrowserContextOptions, errors: string[], password = PASSWORD): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...options, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${email}] PAGEERROR ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (4\d\d)/.test(m.text())) errors.push(`[${email}] CONSOLE ${m.text()}`);
  });
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  await expect(page).not.toHaveURL(/\/login/);
  return { ctx, page };
}

/** 横スクロールが出ていない（スマホ・タブレットでのはみ出し検出） */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(1);
}

/** Wave を作って全タスクを API でピック（画面操作は別の端末で行うテスト用の下準備） */
export async function waveAndPick(api: Api, warehouseId: string, fulfillmentIds: string[]) {
  const w = await api.post('/waves', { warehouseId, fulfillmentIds });
  const d = await api.get(`/waves/${w.waveId}`);
  for (const t of d.tasks) {
    const v = await api.post(`/pick-tasks/${t.id}/claim`);
    for (const g of v.groups) {
      if (g.remaining > 0) await api.post(`/pick-tasks/${t.id}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: g.sku, qty: g.remaining, inputMethod: 'manual' });
    }
  }
  return w.waveId as string;
}

/** 梱包（API）→ 下書き Shipment */
export async function packViaApi(api: Api, fulfillmentId: string) {
  const { sessionId } = await api.post('/pack/open', { fulfillmentId });
  const v = await api.get(`/pack/sessions/${sessionId}`);
  for (const it of v.items) {
    if (it.remaining <= 0) continue;
    await api.post(`/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: it.sku, inputMethod: 'manual' });
    if (it.remaining > 1) await api.post(`/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: it.sku, qty: it.remaining - 1, inputMethod: 'manual' });
  }
  return (await api.post(`/pack/sessions/${sessionId}/complete`, { requestId: randomUUID() })).shipments as { id: string; shipmentNumber: string }[];
}

export async function shipViaApi(api: Api, shipmentId: string, tracking: string, carrier = 'yamato') {
  await api.patch(`/shipments/${shipmentId}`, { carrier, trackingNumber: tracking });
  return api.post(`/shipments/${shipmentId}/confirm`, {});
}

export function trackingNo() {
  return String(Date.now()).slice(-10) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
}

/** 注文 → 引当 → Wave → Pick → Pack → 出荷確定（API）。返品テストなどの前提づくり */
export async function shippedOrder(api: Api, s: Seed, ext: string, lines: { sku: string; quantity: number }[]) {
  const o = await manualOrder(api, s.channels.MAN, ext, lines);
  const a = await api.post(`/orders/${o.id}/allocate`, {});
  if (a.outcome !== 'full') throw new Error(`allocation ${a.outcome}`);
  const d = await api.get(`/orders/${o.id}`);
  const ffs = d.fulfillments.map((f: any) => f.id);
  await waveAndPick(api, d.fulfillments[0].warehouseId, ffs);
  for (const f of ffs) for (const sh of await packViaApi(api, f)) await shipViaApi(api, sh.id, trackingNo());
  return api.get(`/orders/${o.id}`);
}

/** アップロード用の一時ファイルのパス（ASCII のみ。テスト名に日本語や記号があっても安全） */
export function asciiTempPath(name: string) {
  const dir = join(tmpdir(), 'commerceops-e2e');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${name}`);
}
