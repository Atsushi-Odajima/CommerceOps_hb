import { AxeBuilder } from '@axe-core/playwright';
import { devices, expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, receive, seed, shippedOrder, signupOrg } from '../support/api.js';

/**
 * アクセシビリティ: axe-core（WCAG 2.1 A/AA のルール）で主要画面を検査し、重大（critical）・深刻（serious）な違反がないこと。
 * あわせてキーボードだけでログインできることを確認する。
 */
test('accessibility: no critical/serious axe violations on key screens (PC, phone, tablet)', async ({ browser, baseURL }) => {
  const { api: owner, email: ownerEmail } = await signupOrg(baseURL!);
  const s = await seed(owner, ['AX-A']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['AX-A']!.id, 10);
  const o = await shippedOrder(owner, s, `AX-${Date.now()}`, [{ sku: 'AX-A', quantity: 1 }]);
  const ret = await owner.post('/returns', { orderId: o.id, reasonCode: 'defective', items: [{ orderItemId: o.items[0].id, qty: 1 }] });
  const picker = await inviteUser(owner, 'picker');
  const packer = await inviteUser(owner, 'packer');
  const plan: { email: string; opts: object; paths: string[] }[] = [
    { email: ownerEmail, opts: DEVICES.pc, paths: ['/', '/orders', `/orders/${o.id}`, '/imports/new', '/allocation', '/waves', '/waves/new', '/shipments', '/returns', `/returns/${ret.id}`, '/returns/new', '/exceptions', '/assignments', '/kpi', '/search?q=AX', '/inventory', '/settings/organization', '/settings/users', '/settings/backup', '/audit'] },
    { email: picker.email, opts: devices['iPhone 14'], paths: ['/m', '/m/tasks', '/m/lookup', '/m/report'] },
    { email: packer.email, opts: devices['iPad Pro 11'], paths: ['/pack', '/m/returns'] },
  ];
  const report: string[] = [];
  const errors: string[] = [];
  for (const p of plan) {
    const { ctx, page } = await loginPage(browser, p.email, p.opts, errors);
    for (const path of p.paths) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of r.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) {
        report.push(`${path} [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
      }
    }
    await ctx.close();
  }
  expect(report, report.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});

test('accessibility: login works with the keyboard only, focus is visible', async ({ page, baseURL }) => {
  const { email } = await signupOrg(baseURL!);
  const axe = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  await page.goto('/login');
  expect(await axe()).toEqual([]);
  await page.keyboard.press('Tab');
  await expect(page.locator('#email')).toBeFocused();
  const outline = await page.locator('#email').evaluate((el) => getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).boxShadow);
  expect(outline).not.toBe('none none');
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.locator('#password')).toBeFocused();
  await page.keyboard.type('E2e-Passw0rd-2026');
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
});
