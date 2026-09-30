// Phase 9 UI smoke: 設定 → バックアップ（ダウンロード → 検証 → 新しい組織として復元 → 切替）、監査ログ（絞り込み・対象リンク・CSV）
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT;
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => m.type() === 'error' && !/401|409|422|400/.test(m.text()) && errors.push('CONSOLE ' + m.text()));
await page.goto(`${BASE}/login`);
await page.fill('#email', 'owner@demo.test');
await page.fill('#password', 'Demo-Owner-2026');
await page.click('button[type=submit]');
await page.waitForLoadState('networkidle');
const me0 = await (await page.request.get(`${BASE}/api/auth/me`)).json();
const origOrg = me0.organization;

// 1) ダウンロード
await page.goto(`${BASE}/settings/backup`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/120-backup.png`, fullPage: true });
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'バックアップをダウンロード' }).click()]);
const file = `${out}/${dl.suggestedFilename()}`;
await dl.saveAs(file);
console.log('download', dl.suggestedFilename(), readFileSync(file).length, 'bytes');
await page.waitForTimeout(800);

// 2) 改ざんしたファイル → 検証 NG
const lines = gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
const idx = lines.findIndex((l) => JSON.parse(l).t === 'order_items');
const o = JSON.parse(lines[idx]);
o.d.quantity = o.d.quantity + 5;
lines[idx] = JSON.stringify(o);
const tampered = `${out}/tampered.ndjson.gz`;
writeFileSync(tampered, gzipSync(lines.join('\n') + '\n'));
await page.setInputFiles('#bk-file', tampered);
await page.getByRole('button', { name: 'ファイルを検証' }).click();
await page.getByText('このファイルは復元できません').waitFor();
await page.screenshot({ path: `${out}/121-backup-verify-ng.png`, fullPage: true });

// 3) 正しいファイル → 検証 OK → 復元 → 切替
await page.setInputFiles('#bk-file', file);
await page.getByRole('button', { name: 'ファイルを検証' }).click();
await page.getByText('検証 OK').waitFor();
await page.getByText('内訳を表示').click();
await page.screenshot({ path: `${out}/122-backup-verify-ok.png`, fullPage: true });
await page.fill('#bk-name', `${origOrg.name}（UI 復元テスト）`);
await page.getByLabel(/新しい組織として復元し、自分がその組織の Owner/).check();
await page.getByRole('button', { name: '新しい組織として復元' }).click();
await page.getByRole('dialog').getByRole('button', { name: '復元する' }).click();
await page.getByText(/復元しました:/).waitFor({ timeout: 120_000 });
await page.screenshot({ path: `${out}/123-backup-restored.png`, fullPage: true });
await page.getByRole('button', { name: '復元した組織に切り替える' }).click();
await page.waitForURL(`${BASE}/`);
await page.waitForTimeout(1200);
const me1 = await (await page.request.get(`${BASE}/api/auth/me`)).json();
console.log('switched to', me1.organization.name, me1.role);
await page.screenshot({ path: `${out}/124-restored-home.png`, fullPage: true });
const ordersA = await (await page.request.get(`${BASE}/api/orders?limit=1`)).json();
console.log('orders in restored org', ordersA.total);

// 4) 監査ログ
await page.goto(`${BASE}/audit`);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/125-audit.png`, fullPage: true });
await page.selectOption('#au-action', 'backup');
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/126-audit-backup.png`, fullPage: true });
await page.selectOption('#au-action', '');
await page.fill('#au-q', 'SO-');
await page.press('#au-q', 'Enter');
await page.waitForTimeout(700);
const firstHistory = page.getByRole('button', { name: 'この対象の履歴' }).first();
if (await firstHistory.count()) {
  await firstHistory.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/127-audit-entity.png`, fullPage: true });
}
await page.getByRole('button', { name: 'CSV 出力' }).click();
const [adl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ダウンロード' }).click()]);
console.log('audit download', adl.suggestedFilename());

// 5) 元の組織に戻る（組織切替）→ 注文詳細から監査ログへ
await page.request.post(`${BASE}/api/auth/switch-org`, { headers: { 'x-requested-with': 'CommerceOps', 'x-csrf-token': me1.csrfToken }, data: { organizationId: origOrg.id } });
const me2 = await (await page.request.get(`${BASE}/api/auth/me`)).json();
console.log('back to', me2.organization.name);
const anyOrder = (await (await page.request.get(`${BASE}/api/orders?limit=1`)).json()).items[0];
await page.goto(`${BASE}/orders/${anyOrder.id}`);
await page.waitForTimeout(800);
await page.getByRole('link', { name: '操作履歴（監査ログ）' }).click();
await page.waitForURL(/\/audit\?entityType=order/);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/128-order-audit.png`, fullPage: true });

// 6) スマホ幅でも崩れない（監査ログ）
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push('PAGEERROR(m) ' + e.message));
await pp.goto(`${BASE}/login`);
await pp.fill('#email', 'owner@demo.test');
await pp.fill('#password', 'Demo-Owner-2026');
await pp.click('button[type=submit]');
await pp.waitForLoadState('networkidle');
await pp.goto(`${BASE}/settings/backup`);
await pp.waitForTimeout(900);
await pp.screenshot({ path: `${out}/129-backup-phone.png`, fullPage: true });
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no page errors');
