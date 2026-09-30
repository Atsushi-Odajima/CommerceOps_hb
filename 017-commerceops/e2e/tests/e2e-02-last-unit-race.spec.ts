import { expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, manualOrder, receive, seed, signupOrg } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

/** E2E-2: 2 チャネルの注文が最後の 1 個を同時に要求 → 片方だけ引当 → もう片方は欠品例外 */
test('E2E-2: two channels race for the last unit from two PCs → exactly one allocated, the other becomes a shortage exception', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['LAST-ONE']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['LAST-ONE']!.id, 1);
  const web = await manualOrder(owner, s.channels.WEB, `WEB-${Date.now()}`, [{ sku: 'LAST-ONE', quantity: 1 }]);
  const mpa = await manualOrder(owner, s.channels.MPA, `MPA-${Date.now()}`, [{ sku: 'LAST-ONE', quantity: 1 }]);
  const m1 = await inviteUser(owner, 'ops_manager');
  const m2 = await inviteUser(owner, 'ops_manager');
  const a = await loginPage(browser, m1.email, DEVICES.pc, errors);
  const b = await loginPage(browser, m2.email, DEVICES.pc, errors);
  await a.page.goto(`/orders/${web.id}`);
  await b.page.goto(`/orders/${mpa.id}`);
  const btnA = a.page.getByRole('button', { name: 'ルールで引当' });
  const btnB = b.page.getByRole('button', { name: 'ルールで引当' });
  await Promise.all([btnA.waitFor(), btnB.waitFor()]);
  // 2 台の PC で同時にクリック
  await Promise.all([btnA.click(), btnB.click()]);
  const toastA = a.page.getByText(/全量引当しました|引当可能な在庫がありません/).first();
  const toastB = b.page.getByText(/全量引当しました|引当可能な在庫がありません/).first();
  await Promise.all([toastA.waitFor(), toastB.waitFor()]);
  const texts = [await toastA.textContent(), await toastB.textContent()];
  expect(texts.filter((t) => t?.includes('全量引当しました')).length).toBe(1);
  expect(texts.filter((t) => t?.includes('引当可能な在庫がありません')).length).toBe(1);
  const statuses = await Promise.all([owner.get(`/orders/${web.id}`), owner.get(`/orders/${mpa.id}`)]);
  expect(statuses.map((o) => o.status).sort()).toEqual(['allocated', 'ready_for_allocation']);
  const loser = statuses.find((o) => o.status === 'ready_for_allocation')!;
  // 欠品例外が例外キュー（画面）に出る
  await a.page.goto('/exceptions?status=active');
  await expect(a.page.getByRole('link', { name: new RegExp(`欠品: ${loser.orderNumber}`) })).toBeVisible();
  const bal = await owner.get(`/inventory/balances?productId=${s.products['LAST-ONE']!.id}`);
  const pick = bal.items.filter((x: any) => x.kind === 'pick');
  expect(pick.reduce((n: number, x: any) => n + x.allocated, 0)).toBe(1);
  expect(pick.reduce((n: number, x: any) => n + x.available, 0)).toBe(0);
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  await a.ctx.close();
  await b.ctx.close();
});
