import { devices, expect, test } from '@playwright/test';
import { DEVICES, expectNoHorizontalOverflow, inviteUser, loginPage, receive, seed, shippedOrder, signupOrg } from '../support/api.js';

/**
 * 端末別の表示確認（PC / iPhone / Android / iPad 縦・横）: 主要画面がページエラーなし・横はみ出しなしで表示でき、
 * PWA（マニフェスト standalone・Service Worker）が有効であること。WebKit はこの環境に無いため Chromium で端末のビューポート・タッチ・UA を再現。
 */
const MATRIX = [
  { name: 'PC 1366x900', opts: DEVICES.pc, role: 'ops_manager' as const, paths: ['/', '/orders', '/allocation', '/waves', '/shipments', '/returns', '/exceptions', '/kpi', '/audit', '/inventory'] },
  { name: 'iPhone 14', opts: devices['iPhone 14'], role: 'picker' as const, paths: ['/m', '/m/tasks', '/m/lookup', '/m/report'] },
  { name: 'Android (Pixel 7)', opts: devices['Pixel 7'], role: 'picker' as const, paths: ['/m', '/m/tasks', '/m/lookup', '/m/report'] },
  { name: 'iPhone SE（小さい画面）', opts: devices['iPhone SE'], role: 'packer' as const, paths: ['/m', '/m/returns'] },
  { name: 'iPad Pro 11 縦', opts: devices['iPad Pro 11'], role: 'packer' as const, paths: ['/pack', '/shipments'] },
  { name: 'iPad Pro 11 横', opts: devices['iPad Pro 11 landscape'], role: 'packer' as const, paths: ['/pack', '/shipments'] },
  { name: 'iPad mini（Support）', opts: devices['iPad Mini'], role: 'support' as const, paths: ['/', '/orders', '/returns'] },
];

test('device matrix: key screens render without page errors or horizontal overflow on PC / iPhone / Android / iPad', async ({ browser, baseURL }) => {
  const { api: owner } = await signupOrg(baseURL!);
  const s = await seed(owner, ['DV-A']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['DV-A']!.id, 10);
  const o = await shippedOrder(owner, s, `DV-${Date.now()}`, [{ sku: 'DV-A', quantity: 1 }]);
  const users = {
    ops_manager: await inviteUser(owner, 'ops_manager'),
    picker: await inviteUser(owner, 'picker'),
    packer: await inviteUser(owner, 'packer'),
    support: await inviteUser(owner, 'support'),
  };
  const problems: string[] = [];
  for (const d of MATRIX) {
    const errors: string[] = [];
    const { ctx, page } = await loginPage(browser, users[d.role].email, d.opts, errors);
    for (const path of [...d.paths, ...(d.role === 'support' ? [`/orders/${o.id}`] : [])]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('main, .m-shell, .pack-shell, #root').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${d.name} ${path}: 横はみ出し ${overflow}px`);
      if ((await page.getByText('アクセスできません').count()) > 0) problems.push(`${d.name} ${path}: 権限エラー表示`);
    }
    await expectNoHorizontalOverflow(page);
    for (const e of errors) problems.push(`${d.name}: ${e}`);
    await ctx.close();
  }
  expect(problems).toEqual([]);
});

test('PWA: manifest (standalone, icons) and service worker are served; API responses are not cached by the service worker', async ({ page }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await page.request.get(new URL(href!, page.url()).toString())).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
  expect(manifest.start_url).toBeTruthy();
  await expect.poll(async () => page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration())), { timeout: 15_000 }).toBe(true);
  const sw = await (await page.request.get('/sw.js')).text();
  expect(sw).toContain('precache');
  expect(sw).not.toMatch(/"\/api\//);
});
