import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const out = process.env.OUT;
const U = Date.now().toString(36).slice(-5).toUpperCase();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto('http://localhost:3000/login');
await page.fill('#email', 'owner@demo.test');
await page.fill('#password', 'Demo-Owner-2026');
await page.click('button[type=submit]');
await page.waitForURL('http://localhost:3000/');
const me = await (await page.request.get('http://localhost:3000/api/auth/me')).json();
const H = { 'x-requested-with': 'CommerceOps', 'x-csrf-token': me.csrfToken };
const api = async (method, url, data) => {
  const r = await page.request.fetch('http://localhost:3000/api' + url, { method, headers: H, data });
  const j = await r.json(); if (!r.ok()) throw new Error(url + ' ' + JSON.stringify(j)); return j;
};
const ch = await api('POST', '/channels', { name: 'MP ' + U, type: 'amazon', code: 'M' + U });
const meta = await api('GET', '/import-profiles/meta');
const prof = await api('POST', '/import-profiles', { channelId: ch.id, name: '標準 ' + U, mapping: meta.standardTemplate });
for (const sku of ['TS-RED-M', 'TS-BLU-L', 'MUG-01']) { try { await api('POST', '/products', { sku: sku + '-' + U, name: '商品 ' + sku }); } catch {} }
const hdr = '注文番号,注文日時,購入者名,購入者メール,購入者電話,送付先氏名,郵便番号,都道府県,市区町村,住所1,住所2,送付先電話,配送方法,備考,SKU,商品名,数量,単価';
const rows = [
  `A${U}-1,2026-09-30 09:12:00,佐藤 花子,hanako@example.test,090-1234-5678,佐藤 花子,1500001,,,東京都渋谷区神宮前1-1-1,,090-1234-5678,宅配便,,TS-RED-M-${U},Tシャツ 赤 M,2,"2,980"`,
  `A${U}-1,2026-09-30 09:12:00,佐藤 花子,hanako@example.test,090-1234-5678,佐藤 花子,1500001,,,東京都渋谷区神宮前1-1-1,,090-1234-5678,宅配便,,MUG-01-${U},マグカップ,1,1500`,
  `A${U}-2,2026-09-30 09:30:00,鈴木 一郎,,,鈴木 一郎,5300001,,,大阪府大阪市北区梅田2-2-2,,,ネコポス,,UNKNOWN-SKU,謎の商品,1,500`,
  `A${U}-3,2026-09-30 10:00:00,高橋 次郎,,,高橋 次郎,12345,,,愛知県名古屋市中区1-1,,,宅配便,,TS-BLU-L-${U},Tシャツ 青 L,0,2980`,
];
writeFileSync('/tmp/claude-0/-home-user-hanbai17/7f73d487-3233-5388-8341-de3e7a89ab10/scratchpad/sample.csv', '﻿' + [hdr, ...rows].join('\r\n'));
await page.goto('http://localhost:3000/imports/new');
await page.selectOption('#imp-profile', prof.id);
await page.setInputFiles('#imp-file', '/tmp/claude-0/-home-user-hanbai17/7f73d487-3233-5388-8341-de3e7a89ab10/scratchpad/sample.csv');
await page.getByRole('button', { name: 'プレビュー' }).click();
await page.waitForURL(/\/imports\/[0-9a-f-]+$/, { timeout: 8000 }).catch(async (e) => { await page.screenshot({ path: `${out}/10-import-error.png`, fullPage: true }); throw e; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/10-import-preview.png`, fullPage: true });
await page.getByRole('button', { name: '確定する' }).first().click();
await page.getByRole('dialog').getByRole('button', { name: '確定する' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/11-import-committed.png`, fullPage: true });
await page.goto('http://localhost:3000/orders');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/12-orders.png` });
await page.getByRole('link', { name: /SO-/ }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/13-order-detail.png`, fullPage: true });
console.log('errors:', JSON.stringify(errors));
await browser.close();
