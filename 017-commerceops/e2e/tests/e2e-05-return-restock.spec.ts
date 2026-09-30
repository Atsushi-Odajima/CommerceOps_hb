import { devices, expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, receive, seed, shippedOrder, signupOrg } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

const pickAvail = (b: any) => b.items.filter((x: any) => x.kind === 'pick').reduce((n: number, x: any) => n + x.available, 0);

/** E2E-5: 出荷済み → 返品受付（PC）→ 到着 scan（スマホ）→ Restock 検品（PC）→ 在庫に戻る */
test('E2E-5: shipped order → return request → arrival scan on phone → restock → stock back', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['RET-A']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['RET-A']!.id, 10);
  const o = await shippedOrder(owner, s, `E5-${Date.now()}`, [{ sku: 'RET-A', quantity: 2 }]);
  expect(o.status).toBe('shipped');
  const before = pickAvail(await owner.get(`/inventory/balances?productId=${s.products['RET-A']!.id}`));
  expect(before).toBe(8);
  const support = await inviteUser(owner, 'support');
  const packer = await inviteUser(owner, 'packer');
  const manager = await inviteUser(owner, 'ops_manager');

  // PC（Support）: 注文から返品受付 → 承認
  const sup = await loginPage(browser, support.email, DEVICES.pc, errors);
  await sup.page.goto(`/orders/${o.id}`);
  await sup.page.getByRole('link', { name: '返品・交換受付' }).click();
  await sup.page.waitForURL(/\/returns\/new/);
  await sup.page.getByLabel('RET-A の返品数量').fill('2');
  await sup.page.selectOption('#nr-reason', 'size_issue');
  await sup.page.getByRole('button', { name: /返品を受け付ける（2 個）/ }).click();
  await sup.page.waitForURL(/\/returns\/[0-9a-f-]{36}$/);
  const retId = sup.page.url().split('/').pop()!;
  await sup.page.getByRole('button', { name: '承認' }).click();
  await expect.poll(async () => (await owner.get(`/returns/${retId}`)).status).toBe('authorized');
  // 受付・承認だけでは在庫は増えない（R14）
  expect(pickAvail(await owner.get(`/inventory/balances?productId=${s.products['RET-A']!.id}`))).toBe(before);
  const rt = await owner.get(`/returns/${retId}`);

  // スマホ（Packer）: RMA 番号を scan → 到着を登録
  const phone = await loginPage(browser, packer.email, devices['iPhone 14'], errors);
  await phone.page.goto('/m/returns');
  await phone.page.fill('#rt-scan', rt.returnNumber);
  await phone.page.press('#rt-scan', 'Enter');
  await phone.page.getByRole('button', { name: '到着を登録' }).click();
  await expect.poll(async () => (await owner.get(`/returns/${retId}`)).status).toBe('received');
  expect(pickAvail(await owner.get(`/inventory/balances?productId=${s.products['RET-A']!.id}`))).toBe(before);

  // PC（Manager）: 検品（既定は Restock）→ 在庫に反映
  const pc = await loginPage(browser, manager.email, DEVICES.pc, errors);
  await pc.page.goto(`/returns/${retId}`);
  await pc.page.getByRole('button', { name: '検品結果を確定（在庫に反映）' }).click();
  await expect.poll(async () => (await owner.get(`/returns/${retId}`)).status).toBe('completed');
  expect(pickAvail(await owner.get(`/inventory/balances?productId=${s.products['RET-A']!.id}`))).toBe(before + 2);
  // 在庫画面にも反映（画面で確認）
  await pc.page.goto('/inventory');
  await expect(pc.page.locator('tr', { hasText: 'RET-A' }).first()).toContainText('10');
  expect((await owner.get(`/orders/${o.id}`)).status).toBe('shipped');
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  for (const c of [sup, phone, pc]) await c.ctx.close();
});
