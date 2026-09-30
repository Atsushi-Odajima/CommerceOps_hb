// Phase 6 UI smoke: 出荷画面（インライン追跡番号入力 → 出荷確定、scan 出荷、追跡番号 CSV 取込、出荷済み一覧、詳細、作業票）
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT;
const U = Date.now().toString(36).slice(-5).toUpperCase();
const browser = await chromium.launch();
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => m.type() === 'error' && !/401|409|422/.test(m.text()) && errors.push('CONSOLE ' + m.text()));
await page.goto(`${BASE}/login`);
await page.fill('#email', 'owner@demo.test');
await page.fill('#password', 'Demo-Owner-2026');
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
// 3 注文を梱包完了まで
const wh = (await api('GET', '/warehouses')).items[0];
const locs = (await api('GET', `/warehouses/${wh.id}/locations`)).items.filter((l) => l.kind === 'pick' && l.active);
const ch = (await api('GET', '/channels')).items.find((c) => c.active);
const p = await api('POST', '/products', { sku: `P6-${U}`, name: '出荷テスト商品', barcodes: [{ code: `6A${U}01` }] });
await api('POST', '/inventory/receipts', { locationId: locs[0].id, productId: p.id, qty: 30, requestId: crypto.randomUUID() });
const orders = [];
for (const i of [1, 2, 3]) {
  const o = await api('POST', '/orders', {
    channelId: ch.id,
    order: { externalOrderId: `P6-${U}-${i}`, customer: { name: '出荷 次郎' }, shipTo: { name: '出荷 次郎', postalCode: '460-0001', address1: '愛知県名古屋市中区1-1', phone: '090-2222-3333' }, lines: [{ sku: `P6-${U}`, quantity: i }] },
  });
  await api('POST', `/orders/${o.id}/allocate`, { warehouseId: wh.id });
  orders.push(o);
}
const pv = await api('POST', '/waves/preview', { warehouseId: wh.id });
const ffIds = pv.fulfillments.filter((f) => orders.some((o) => o.orderNumber === f.orderNumber)).map((f) => f.id);
const w = await api('POST', '/waves', { warehouseId: wh.id, fulfillmentIds: ffIds });
for (const t of (await api('GET', `/waves/${w.waveId}`)).tasks) {
  const v = await api('POST', `/pick-tasks/${t.id}/claim`);
  for (const g of v.groups) if (g.remaining > 0) await api('POST', `/pick-tasks/${t.id}/pick`, { clientEventId: crypto.randomUUID(), locationId: g.locationId, code: g.sku, qty: g.remaining, inputMethod: 'manual' });
}
const shipments = [];
for (const ff of ffIds) {
  const sid = (await api('POST', '/pack/open', { fulfillmentId: ff })).sessionId;
  const v = await api('GET', `/pack/sessions/${sid}`);
  for (const it of v.items) {
    await api('POST', `/pack/sessions/${sid}/scan`, { clientEventId: crypto.randomUUID(), code: it.sku });
    if (it.remaining > 1) await api('POST', `/pack/sessions/${sid}/scan`, { clientEventId: crypto.randomUUID(), code: it.sku, qty: it.remaining - 1, inputMethod: 'manual' });
  }
  const done = await api('POST', `/pack/sessions/${sid}/complete`, { requestId: crypto.randomUUID() });
  shipments.push(done.shipments[0]);
}
console.log('shipments', shipments.map((s) => s.shipmentNumber).join(' '));

// 出荷待ち一覧
await page.goto(`${BASE}/shipments?status=draft`);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/70-shipments-draft.png`, fullPage: true });
// 1) インライン入力 → 出荷確定
const row1 = page.locator('tr', { hasText: shipments[0].shipmentNumber });
await row1.getByLabel(`${shipments[0].shipmentNumber} の配送会社`).selectOption('yamato');
await row1.getByLabel(`${shipments[0].shipmentNumber} の追跡番号`).fill('1111-2222-' + String(Date.now()).slice(-4));
await row1.getByRole('button', { name: '出荷確定' }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/71-shipments-inline-confirmed.png`, fullPage: true });
// 2) scan 出荷
await page.getByRole('button', { name: /scan で出荷確定/ }).click();
await page.selectOption('#scan-carrier', 'sagawa');
await page.fill('#scan-ship', shipments[1].shipmentNumber);
await page.press('#scan-ship', 'Enter');
await page.waitForTimeout(300);
await page.fill('#scan-ship', '5555' + String(Date.now()).slice(-8));
await page.press('#scan-ship', 'Enter');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/72-shipments-scan-confirmed.png`, fullPage: true });
// 3) 追跡番号 CSV 取込（検証 → 取込）
const csvPath = `${out}/tracking-${U}.csv`;
writeFileSync(csvPath, '﻿' + ['出荷番号,配送会社,追跡番号', `${shipments[2].shipmentNumber},日本郵便,7777${String(Date.now()).slice(-8)}`, `SH-999999,日本郵便,88889999`].join('\r\n'));
await page.getByRole('button', { name: '追跡番号 CSV 取込' }).click();
await page.setInputFiles('#ti-file', csvPath);
await page.getByRole('button', { name: '検証する' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/73-tracking-import-dryrun.png` });
await page.getByRole('button', { name: /取り込む（1 件）/ }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/74-tracking-import-applied.png` });
await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).last().click();
// 出荷済み一覧
await page.getByRole('tab', { name: /出荷済み/ }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/75-shipments-shipped.png`, fullPage: true });
// 詳細・作業票
const s0 = shipments[0];
await page.goto(`${BASE}/shipments/${s0.id}`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/76-shipment-detail.png`, fullPage: true });
await page.goto(`${BASE}/print/shipment/${s0.id}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/77-shipment-sheet.png`, fullPage: true });
// CSV 出力
for (const type of ['pending', 'shipped']) {
  const r = await page.request.get(`${BASE}/api/shipments/export?type=${type}`);
  console.log(`export ${type}`, r.status(), r.headers()['x-row-count']);
}
const statuses = [];
for (const o of orders) statuses.push((await api('GET', `/orders/${o.id}`)).status);
console.log('order statuses', statuses.join(','));
console.log('errors:', JSON.stringify(errors));
await browser.close();
