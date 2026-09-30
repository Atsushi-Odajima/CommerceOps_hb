// 開発用: owner でログインして任意ページのスクリーンショットを撮る  node scripts/shot.mjs <path> <out.png> [width] [height]
import { chromium } from '@playwright/test';
const [path, out, w = '1366', h = '900'] = process.argv.slice(2);
const BASE = process.env.BASE ?? 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${BASE}/login`);
await page.fill('#email', process.env.EMAIL ?? 'owner@demo.test');
await page.fill('#password', process.env.PASSWORD ?? 'Demo-Owner-2026');
await page.click('button[type=submit]');
await page.waitForLoadState('networkidle');
await page.goto(`${BASE}${path}`);
await page.waitForTimeout(Number(process.env.WAIT ?? 1500));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
