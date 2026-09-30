// Docker で起動したアプリ（docker compose）に実ブラウザ（Chromium）でログインして主要画面を開く確認。
//   node scripts/docker-smoke.mjs http://localhost:3300 owner@example.com 'パスワード'
import { chromium } from '@playwright/test';

const [base = 'http://localhost:3300', email, password] = process.argv.slice(2);
const browser = await chromium.launch();
const errors = [];
try {
  for (const [label, opts] of [
    ['PC', { viewport: { width: 1366, height: 900 } }],
    ['iPhone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ]) {
    const ctx = await browser.newContext({ ...opts, baseURL: base, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label} ${e.message}`));
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    for (const path of ['/', '/orders', '/waves', '/shipments', '/returns', '/exceptions', '/settings/backup']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const denied = await page.getByText('アクセスできません').count();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`${label.padEnd(6)} ${path.padEnd(18)} ${denied ? 'DENIED' : 'ok'}${overflow > 1 ? ` overflow ${overflow}px` : ''}`);
    }
    const sw = await page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration()));
    console.log(`${label.padEnd(6)} service worker: ${sw ? 'registered' : 'none (HTTP 以外 / localhost 以外では登録されない場合あり)'}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'page errors: none');
if (errors.length) process.exitCode = 1;
