// Phase 4 UI smoke: Wave 作成（PC）→ Picker がスマホ幅で Pick Mode（ロケーション→商品 scan、誤 scan、数量まとめ）→ 印刷画面
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT;
const U = Date.now().toString(36).slice(-5).toUpperCase();
const browser = await chromium.launch();
const errors = [];

async function login(ctx, email, password) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('CONSOLE ' + m.text()));
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

// ---------- owner: データ準備 ----------
const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const { page, api } = await login(desk, 'owner@demo.test', 'Demo-Owner-2026');
const wh = (await api('GET', '/warehouses')).items[0];
const locs = (await api('GET', `/warehouses/${wh.id}/locations`)).items.filter((l) => l.kind === 'pick' && l.active);
if (locs.length < 2) throw new Error('need 2 pick locations');
const ch = (await api('GET', '/channels')).items.find((c) => c.active);
const pA = await api('POST', '/products', { sku: `P4A-${U}`, name: 'スモーク商品A', barcodes: [{ code: `4A${U}01` }] });
const pB = await api('POST', '/products', { sku: `P4B-${U}`, name: 'スモーク商品B', variant: '青 / M', barcodes: [{ code: `4B${U}01` }] });
await api('POST', '/inventory/receipts', { locationId: locs[0].id, productId: pA.id, qty: 10, requestId: crypto.randomUUID() });
await api('POST', '/inventory/receipts', { locationId: locs[1].id, productId: pB.id, qty: 10, requestId: crypto.randomUUID() });
const orders = [];
for (const [i, lines] of [
  [1, [{ sku: `P4A-${U}`, quantity: 2 }, { sku: `P4B-${U}`, quantity: 1 }]],
  [2, [{ sku: `P4A-${U}`, quantity: 1 }]],
  [3, [{ sku: `P4B-${U}`, quantity: 3 }]],
]) {
  const o = await api('POST', '/orders', {
    channelId: ch.id,
    order: {
      externalOrderId: `P4-${U}-${i}`,
      customer: { name: 'スモーク 太郎' },
      shipTo: { name: 'スモーク 太郎', postalCode: '150-0001', address1: '東京都渋谷区神宮前1-1-1', phone: '090-0000-0000' },
      lines,
    },
  });
  const a = await api('POST', `/orders/${o.id}/allocate`, { warehouseId: wh.id });
  orders.push({ ...o, outcome: a.outcome });
}
console.log('orders', orders.map((o) => `${o.orderNumber}:${o.outcome}`).join(' '));

// ---------- owner: Wave 作成 UI ----------
await page.goto(`${BASE}/fulfillments`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/40-fulfillments.png` });
await page.goto(`${BASE}/waves/new`);
await page.selectOption('#wv-wh', wh.id);
await page.waitForTimeout(1000);
// 今回作った 3 件だけ選ぶ
await page.getByRole('checkbox', { name: 'すべて選択' }).uncheck().catch(() => {});
for (const o of orders) {
  const row = page.locator('tr', { hasText: o.orderNumber });
  await row.getByRole('checkbox').check();
}
await page.fill('#wv-label', `スモーク ${U}`);
await page.screenshot({ path: `${out}/41-wave-create.png`, fullPage: true });
await page.getByRole('button', { name: /Wave を作成（3 件）/ }).click();
await page.waitForURL(/\/waves\/[0-9a-f-]{36}$/, { timeout: 8000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/42-wave-detail.png`, fullPage: true });
const waveId = page.url().split('/').pop();

// Picker を招待 → 受諾
const inv = await api('POST', '/users/invitations', { email: `picker-${U.toLowerCase()}@demo.test`, name: `Picker ${U}`, role: 'picker' });
const token = inv.url.split('#t=')[1];
const acc = await browser.newContext();
const r = await acc.request.post(`${BASE}/api/auth/invitations/accept`, {
  headers: { 'x-requested-with': 'CommerceOps' },
  data: { token, name: `Picker ${U}`, password: 'Picker-Passw0rd-2026' },
});
if (!r.ok()) throw new Error('accept failed ' + (await r.text()));
await acc.close();

// ---------- picker: スマホ幅 ----------
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pk = await login(mob, `picker-${U.toLowerCase()}@demo.test`, 'Picker-Passw0rd-2026');
await pk.page.waitForURL(/\/m/, { timeout: 5000 });
await pk.page.waitForTimeout(800);
await pk.page.screenshot({ path: `${out}/43-m-home.png` });
// 住所などの個人情報が Picker のタスク API に含まれないこと
const tasks = await pk.api('GET', '/pick-tasks?scope=available');
const myTask = tasks.items.find((t) => t.waveId === waveId) ?? tasks.items[0];
const taskJson = JSON.stringify(await pk.api('GET', `/pick-tasks/${myTask.id}`).catch(() => ({})));
if (/神宮前|090-0000|スモーク 太郎/.test(taskJson)) errors.push('PII leaked in pick task');
await pk.page.goto(`${BASE}/m/tasks`);
await pk.page.waitForTimeout(600);
const card = pk.page.locator('.big-card', { hasText: myTask.taskNumber });
await card.getByRole('button', { name: 'このタスクを開始' }).click();
await pk.page.waitForURL(/\/m\/pick\//);
await pk.page.waitForTimeout(800);
await pk.page.screenshot({ path: `${out}/44-pick-location-step.png` });
const scan = async (code) => {
  await pk.page.fill('#pick-scan', code);
  await pk.page.press('#pick-scan', 'Enter');
  await pk.page.waitForTimeout(700);
};
// 誤ったロケーション
await scan('NO-SUCH-LOC');
await pk.page.screenshot({ path: `${out}/45-pick-wrong-location.png` });
// 正しいロケーション（先頭グループ）→ 誤商品 → 正商品
const detail = await pk.api('GET', `/pick-tasks/${myTask.id}`);
const g0 = detail.groups.find((g) => g.remaining > 0);
await scan(g0.locationBarcode);
const wrong = g0.sku === `P4A-${U}` ? `4B${U}01` : `4A${U}01`;
await scan(wrong);
await pk.page.screenshot({ path: `${out}/46-pick-wrong-sku.png` });
await scan(g0.barcodes[0]);
await pk.page.screenshot({ path: `${out}/47-pick-ok.png` });
// 残りは各グループ: ロケーション scan → 数量まとめ入力
for (let guard = 0; guard < 10; guard++) {
  const d = await pk.api('GET', `/pick-tasks/${myTask.id}`);
  const g = d.groups.find((x) => x.remaining > 0);
  if (!g) break;
  const label = await pk.page.locator('label[for=pick-scan]').textContent();
  if (label?.includes('ロケーション')) await scan(g.locationBarcode);
  if (g.remaining === 1) {
    await scan(g.barcodes[0]);
  } else {
    await pk.page.getByRole('button', { name: '数量をまとめて入力' }).click();
    await pk.page.getByRole('button', { name: '次へ' }).click();
    await pk.page.screenshot({ path: `${out}/48-pick-qty-confirm.png` });
    await pk.page.getByRole('button', { name: /個をピック済みにする/ }).click();
    await pk.page.waitForTimeout(800);
  }
}
await pk.page.waitForTimeout(600);
await pk.page.screenshot({ path: `${out}/49-pick-done.png` });
const final = await pk.api('GET', `/pick-tasks/${myTask.id}`);
console.log('task status', final.status, 'remaining', final.groups.reduce((s, g) => s + g.remaining, 0));

// 商品確認・例外報告
await pk.page.goto(`${BASE}/m/lookup`);
await pk.page.fill('#lookup-scan', `4A${U}01`);
await pk.page.press('#lookup-scan', 'Enter');
await pk.page.waitForTimeout(700);
await pk.page.screenshot({ path: `${out}/50-m-lookup.png` });
await pk.page.goto(`${BASE}/m/report`);
await pk.page.getByText('破損品を見つけた').click();
await pk.page.fill('#fr-note', '外箱に凹み');
await pk.page.getByRole('button', { name: '報告を送信' }).click();
await pk.page.waitForTimeout(700);
await pk.page.screenshot({ path: `${out}/51-m-report.png` });
// Picker は管理画面の注文一覧 API にアクセスできない
const denied = await pk.page.request.get(`${BASE}/api/orders`);
console.log('picker GET /api/orders ->', denied.status());

// ---------- owner: 進捗・印刷 ----------
await page.goto(`${BASE}/waves/${waveId}`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/52-wave-after-pick.png`, fullPage: true });
await page.goto(`${BASE}/print/pick-list/${waveId}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/53-print-picklist.png`, fullPage: true });
await page.goto(`${BASE}/print/order-label/${orders[0].id}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/54-print-order-label.png`, fullPage: true });

console.log('errors:', JSON.stringify(errors));
await browser.close();
