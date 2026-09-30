// Phase 5 UI smoke: Packer が iPad 幅で Packing Station（誤 scan 警告 → 全数 scan → 完了 → 納品書）、管理者が PC で引継ぎ → 強制完了
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT;
const U = Date.now().toString(36).slice(-5).toUpperCase();
const browser = await chromium.launch();
const errors = [];

async function login(ctx, email, password) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/401|422|409/.test(m.text()) && errors.push('CONSOLE ' + m.text()));
  await page.goto(`${BASE}/login`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  const me = await (await page.request.get(`${BASE}/api/auth/me`)).json();
  const H = { 'x-requested-with': 'CommerceOps', 'x-csrf-token': me.csrfToken };
  const api = async (method, url, data) => {
    const r = await page.request.fetch(`${BASE}/api${url}`, { method, headers: H, data });
    const j = await r.json().catch(() => ({}));
    if (!r.ok()) throw new Error(`${method} ${url} ${r.status()} ${JSON.stringify(j)}`);
    return j;
  };
  return { page, api };
}

// ---------- owner: データ準備（2 注文を同じ Wave でピック完了まで） ----------
const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const { page, api } = await login(desk, 'owner@demo.test', 'Demo-Owner-2026');
const wh = (await api('GET', '/warehouses')).items[0];
const locs = (await api('GET', `/warehouses/${wh.id}/locations`)).items.filter((l) => l.kind === 'pick' && l.active);
const ch = (await api('GET', '/channels')).items.find((c) => c.active);
const pA = await api('POST', '/products', { sku: `P5A-${U}`, name: '梱包テスト マグカップ', barcodes: [{ code: `5A${U}01` }] });
const pB = await api('POST', '/products', { sku: `P5B-${U}`, name: '梱包テスト Tシャツ', variant: '赤 / M', groupCode: `TS${U}`, barcodes: [{ code: `5B${U}01` }] });
const pB2 = await api('POST', '/products', { sku: `P5B2-${U}`, name: '梱包テスト Tシャツ', variant: '赤 / L', groupCode: `TS${U}`, barcodes: [{ code: `5C${U}01` }] });
for (const [i, p] of [pA, pB, pB2].entries()) await api('POST', '/inventory/receipts', { locationId: locs[i % locs.length].id, productId: p.id, qty: 20, requestId: crypto.randomUUID() });
const mk = async (ext, lines) => {
  const o = await api('POST', '/orders', {
    channelId: ch.id,
    order: {
      externalOrderId: ext,
      customer: { name: '梱包 花子' },
      shipTo: { name: '梱包 花子', postalCode: '530-0001', address1: '大阪府大阪市北区梅田1-1-1', address2: 'テストマンション101', phone: '090-9999-0000' },
      lines,
      notes: 'ギフト包装希望',
    },
  });
  await api('POST', `/orders/${o.id}/allocate`, { warehouseId: wh.id });
  return o;
};
const oX = await mk(`P5-${U}-X`, [{ sku: `P5A-${U}`, quantity: 2 }, { sku: `P5B-${U}`, quantity: 1 }]);
const oY = await mk(`P5-${U}-Y`, [{ sku: `P5B2-${U}`, quantity: 3 }]);
const pv = await api('POST', '/waves/preview', { warehouseId: wh.id });
const ffIds = pv.fulfillments.filter((f) => [oX.orderNumber, oY.orderNumber].includes(f.orderNumber)).map((f) => f.id);
const w = await api('POST', '/waves', { warehouseId: wh.id, fulfillmentIds: ffIds, label: `梱包スモーク ${U}` });
const wd = await api('GET', `/waves/${w.waveId}`);
for (const t of wd.tasks) {
  const v = await api('POST', `/pick-tasks/${t.id}/claim`);
  for (const g of v.groups) if (g.remaining > 0) await api('POST', `/pick-tasks/${t.id}/pick`, { clientEventId: crypto.randomUUID(), locationId: g.locationId, code: g.sku, qty: g.remaining, inputMethod: 'manual' });
}
// Packer 招待
const inv = await api('POST', '/users/invitations', { email: `packer-${U.toLowerCase()}@demo.test`, name: `Packer ${U}`, role: 'packer' });
const acc = await browser.newContext();
const r = await acc.request.post(`${BASE}/api/auth/invitations/accept`, { headers: { 'x-requested-with': 'CommerceOps' }, data: { token: inv.url.split('#t=')[1], name: `Packer ${U}`, password: 'Packer-Passw0rd-2026' } });
if (!r.ok()) throw new Error('accept failed ' + (await r.text()));
await acc.close();

// ---------- packer: iPad 縦（820x1180） ----------
const ipad = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 });
const pk = await login(ipad, `packer-${U.toLowerCase()}@demo.test`, 'Packer-Passw0rd-2026');
await pk.page.waitForURL(/\/pack$/, { timeout: 5000 });
await pk.page.waitForTimeout(700);
await pk.page.screenshot({ path: `${out}/60-pack-home-ipad.png`, fullPage: true });
await pk.page.fill('#pack-open', oX.orderNumber);
await pk.page.press('#pack-open', 'Enter');
await pk.page.waitForURL(/\/pack\/[0-9a-f-]{36}$/, { timeout: 5000 });
await pk.page.waitForTimeout(700);
await pk.page.screenshot({ path: `${out}/61-pack-station-ipad.png`, fullPage: true });
const scan = async (code) => {
  await pk.page.fill('#pack-scan', code);
  await pk.page.press('#pack-scan', 'Enter');
  await pk.page.waitForTimeout(600);
};
await scan(`5C${U}01`); // 別注文（同じ Wave の Y）かつ別 variant
await pk.page.screenshot({ path: `${out}/62-pack-misscan-ipad.png`, fullPage: true });
await scan(`5A${U}01`);
await scan(`5B${U}01`);
await scan(`5B${U}01`); // 数量過多
await pk.page.screenshot({ path: `${out}/63-pack-over-ipad.png` });
await scan(`5A${U}01`);
await pk.page.screenshot({ path: `${out}/64-pack-allpacked-ipad.png`, fullPage: true });
await pk.page.getByRole('button', { name: '梱包完了', exact: true }).click();
await pk.page.waitForTimeout(900);
await pk.page.screenshot({ path: `${out}/65-pack-completed-ipad.png`, fullPage: true });
// Y を開いて 1 個だけ scan したまま（管理者が引継ぎ → 強制完了）
await pk.page.goto(`${BASE}/pack`);
await pk.page.fill('#pack-open', oY.orderNumber);
await pk.page.press('#pack-open', 'Enter');
await pk.page.waitForURL(/\/pack\/[0-9a-f-]{36}$/);
await scan(`5C${U}01`);

// ---------- owner: PC で引継ぎ → 強制完了 ----------
await page.goto(`${BASE}/pack`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/66-pack-home-desktop.png`, fullPage: true });
const row = page.locator('tr', { hasText: oY.orderNumber });
await row.getByRole('button', { name: '管理者として引き継ぐ' }).click();
await page.waitForURL(/\/pack\/[0-9a-f-]{36}$/);
await page.waitForTimeout(700);
await page.getByRole('button', { name: '強制完了（管理者）' }).click();
await page.fill('#confirm-reason', 'ラベル破損のため目視で数量確認');
await page.screenshot({ path: `${out}/67-pack-force-dialog.png` });
await page.getByRole('button', { name: '未検品のまま完了する' }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/68-pack-forced-done.png`, fullPage: true });
// 納品書
const fx = (await api('GET', `/orders/${oX.id}`)).fulfillments[0];
await page.goto(`${BASE}/print/packing-slip/${fx.id}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/69-packing-slip.png`, fullPage: true });
const ex = await api('GET', `/orders/${oY.id}`);
console.log('X status', (await api('GET', `/orders/${oX.id}`)).status, 'Y status', ex.status, 'Y exceptions', ex.exceptions.map((e) => e.type).join(','));
console.log('errors:', JSON.stringify(errors));
await browser.close();
