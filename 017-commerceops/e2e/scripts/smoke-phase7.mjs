// Phase 7 UI smoke: Support が PC で返品受付 → 承認 → 受領票、Packer がスマホで到着登録、管理者が PC で分割検品 + 写真、交換手配、スマホ検品
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT;
const U = Date.now().toString(36).slice(-5).toUpperCase();
const browser = await chromium.launch();
const errors = [];

async function login(ctx, email, password) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/401|409|422/.test(m.text()) && errors.push('CONSOLE ' + m.text()));
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

const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const owner = await login(desk, 'owner@demo.test', 'Demo-Owner-2026');
const { api } = owner;
// 出荷済みの注文を 3 件作る
const wh = (await api('GET', '/warehouses')).items[0];
const locs = (await api('GET', `/warehouses/${wh.id}/locations`)).items.filter((l) => l.kind === 'pick' && l.active);
const ch = (await api('GET', '/channels')).items.find((c) => c.active);
const p = await api('POST', '/products', { sku: `P7-${U}`, name: '返品テスト ジャケット', variant: '黒 / M', barcodes: [{ code: `7A${U}01` }] });
await api('POST', '/inventory/receipts', { locationId: locs[0].id, productId: p.id, qty: 30, requestId: crypto.randomUUID() });
const shipped = [];
for (const i of [1, 2, 3]) {
  const o = await api('POST', '/orders', { channelId: ch.id, order: { externalOrderId: `P7-${U}-${i}`, customer: { name: '返品 三郎' }, shipTo: { name: '返品 三郎', postalCode: '810-0001', address1: '福岡県福岡市中央区天神1-1', phone: '090-3333-4444' }, lines: [{ sku: `P7-${U}`, quantity: 2 }] } });
  await api('POST', `/orders/${o.id}/allocate`, { warehouseId: wh.id });
  const ff = (await api('GET', `/orders/${o.id}`)).fulfillments[0].id;
  const w = await api('POST', '/waves', { warehouseId: wh.id, fulfillmentIds: [ff] });
  for (const t of (await api('GET', `/waves/${w.waveId}`)).tasks) {
    const v = await api('POST', `/pick-tasks/${t.id}/claim`);
    for (const g of v.groups) await api('POST', `/pick-tasks/${t.id}/pick`, { clientEventId: crypto.randomUUID(), locationId: g.locationId, code: g.sku, qty: g.remaining, inputMethod: 'manual' });
  }
  const sid = (await api('POST', '/pack/open', { fulfillmentId: ff })).sessionId;
  await api('POST', `/pack/sessions/${sid}/scan`, { clientEventId: crypto.randomUUID(), code: `P7-${U}` });
  await api('POST', `/pack/sessions/${sid}/scan`, { clientEventId: crypto.randomUUID(), code: `P7-${U}`, qty: 1, inputMethod: 'manual' });
  const done = await api('POST', `/pack/sessions/${sid}/complete`, { requestId: crypto.randomUUID() });
  await api('PATCH', `/shipments/${done.shipments[0].id}`, { carrier: 'yamato', trackingNumber: `7${U}${i}000`.replace(/[^A-Z0-9]/g, '0') });
  await api('POST', `/shipments/${done.shipments[0].id}/confirm`, {});
  shipped.push(o);
}
// Support / Packer を招待
const invite = async (role) => {
  const email = `${role}-${U.toLowerCase()}@demo.test`;
  const inv = await api('POST', '/users/invitations', { email, name: `${role} ${U}`, role });
  const acc = await browser.newContext();
  const r = await acc.request.post(`${BASE}/api/auth/invitations/accept`, { headers: { 'x-requested-with': 'CommerceOps' }, data: { token: inv.url.split('#t=')[1], name: `${role} ${U}`, password: 'Role-Passw0rd-2026' } });
  if (!r.ok()) throw new Error('accept failed ' + (await r.text()));
  await acc.close();
  return email;
};
const supportEmail = await invite('support');
const packerEmail = await invite('packer');

// ---------- Support: PC で返品受付 ----------
const supCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const sup = await login(supCtx, supportEmail, 'Role-Passw0rd-2026');
await sup.page.goto(`${BASE}/orders/${shipped[0].id}`);
await sup.page.getByRole('link', { name: '返品・交換受付' }).click();
await sup.page.waitForURL(/\/returns\/new/);
await sup.page.waitForTimeout(700);
await sup.page.getByLabel(`P7-${U} の返品数量`).fill('2');
await sup.page.selectOption('#nr-reason', 'size_issue');
await sup.page.fill('#nr-cnote', 'サイズが合わないため交換希望');
await sup.page.screenshot({ path: `${out}/80-return-new.png`, fullPage: true });
await sup.page.getByRole('button', { name: /返品を受け付ける（2 個）/ }).click();
await sup.page.waitForURL(/\/returns\/[0-9a-f-]{36}$/);
await sup.page.getByRole('button', { name: '承認' }).click();
await sup.page.waitForTimeout(800);
await sup.page.screenshot({ path: `${out}/81-return-authorized.png`, fullPage: true });
const ret1 = sup.page.url().split('/').pop();
const rt1 = await sup.api('GET', `/returns/${ret1}`);
await sup.page.goto(`${BASE}/print/return/${ret1}`);
await sup.page.waitForTimeout(1500);
await sup.page.screenshot({ path: `${out}/82-return-slip.png`, fullPage: true });

// ---------- Packer: スマホで到着登録 ----------
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pk = await login(phone, packerEmail, 'Role-Passw0rd-2026');
await pk.page.goto(`${BASE}/m/returns`);
await pk.page.fill('#rt-scan', rt1.returnNumber);
await pk.page.press('#rt-scan', 'Enter');
await pk.page.waitForTimeout(900);
await pk.page.getByRole('button', { name: '1 減らす' }).click(); // 1 個しか届かなかった
await pk.page.fill('#mr-unexp', '付属のベルトが入っていない');
await pk.page.screenshot({ path: `${out}/83-m-return-receive.png`, fullPage: true });
await pk.page.getByRole('button', { name: '到着を登録' }).click();
await pk.page.waitForTimeout(900);
await pk.page.screenshot({ path: `${out}/84-m-return-received.png`, fullPage: true });

// ---------- 管理者: PC で検品（写真付き） ----------
const before = await api('GET', `/inventory/balances?productId=${p.id}`);
await owner.page.goto(`${BASE}/returns/${ret1}`);
await owner.page.waitForTimeout(900);
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
const pngPath = `${out}/photo-${U}.png`;
writeFileSync(pngPath, png);
await owner.page.setInputFiles(`#photo-${ret1}`, pngPath);
await owner.page.waitForTimeout(900);
await owner.page.screenshot({ path: `${out}/85-return-inspect-form.png`, fullPage: true });
await owner.page.getByRole('button', { name: '検品結果を確定（在庫に反映）' }).click();
await owner.page.waitForTimeout(1000);
await owner.page.screenshot({ path: `${out}/86-return-inspected.png`, fullPage: true });
const after = await api('GET', `/inventory/balances?productId=${p.id}`);
const avail = (x) => x.items.filter((b) => b.kind === 'pick').reduce((s, b) => s + b.available, 0);
console.log('available before/after restock', avail(before), avail(after));

// ---------- 2 件目: 破損 → 交換 ----------
const r2 = await api('POST', '/returns', { orderId: shipped[1].id, reasonCode: 'defective', items: [{ orderItemId: (await api('GET', `/orders/${shipped[1].id}`)).items[0].id, qty: 1 }] });
await api('POST', `/returns/${r2.id}/authorize`, {});
const r2d = await api('GET', `/returns/${r2.id}`);
await api('POST', `/returns/${r2.id}/receive`, { warehouseId: wh.id, items: [{ returnItemId: r2d.items[0].id, receivedQty: 1 }] });
await owner.page.goto(`${BASE}/returns/${r2.id}`);
await owner.page.waitForTimeout(800);
await owner.page.selectOption(`select[id^="d-"]`, 'damaged');
await owner.page.fill(`input[id^="r-"]`, '縫製不良');
await owner.page.getByRole('button', { name: '検品結果を確定（在庫に反映）' }).click();
await owner.page.waitForTimeout(900);
await owner.page.getByRole('button', { name: '交換品を手配' }).click();
await owner.page.waitForTimeout(400);
await owner.page.screenshot({ path: `${out}/87-exchange-modal.png` });
await owner.page.getByRole('button', { name: '交換品の注文を作成' }).click();
await owner.page.waitForTimeout(1000);
await owner.page.screenshot({ path: `${out}/88-return-exchange.png`, fullPage: true });
const ex = (await api('GET', `/returns/${r2.id}`)).exchanges[0];
await owner.page.goto(`${BASE}/orders/${ex.replacementOrderId}`);
await owner.page.waitForTimeout(900);
await owner.page.screenshot({ path: `${out}/89-replacement-order.png`, fullPage: true });

// ---------- 3 件目: 管理者がスマホで検品 ----------
const r3 = await api('POST', '/returns', { orderId: shipped[2].id, reasonCode: 'changed_mind', items: [{ orderItemId: (await api('GET', `/orders/${shipped[2].id}`)).items[0].id, qty: 2 }] });
await api('POST', `/returns/${r3.id}/authorize`, {});
const r3d = await api('GET', `/returns/${r3.id}`);
await api('POST', `/returns/${r3.id}/receive`, { warehouseId: wh.id, items: [{ returnItemId: r3d.items[0].id, receivedQty: 2 }] });
const ownerPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const op = await login(ownerPhone, 'owner@demo.test', 'Demo-Owner-2026');
await op.page.goto(`${BASE}/m/returns`);
await op.page.fill('#rt-scan', r3d.returnNumber);
await op.page.press('#rt-scan', 'Enter');
await op.page.waitForTimeout(900);
await op.page.screenshot({ path: `${out}/90-m-return-inspect.png`, fullPage: true });
await op.page.getByRole('button', { name: '検品結果を確定' }).click();
await op.page.waitForTimeout(900);
await op.page.screenshot({ path: `${out}/91-m-return-inspected.png`, fullPage: true });
const statuses = [];
for (const id of [ret1, r2.id, r3.id]) statuses.push((await api('GET', `/returns/${id}`)).status);
console.log('return statuses', statuses.join(','));
console.log('errors:', JSON.stringify(errors));
await browser.close();
