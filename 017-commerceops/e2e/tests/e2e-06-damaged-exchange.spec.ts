import { expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, packViaApi, receive, seed, shippedOrder, shipViaApi, signupOrg, trackingNo, waveAndPick } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

const bal = async (owner: any, pid: string) => (await owner.get(`/inventory/balances?productId=${pid}`)).items as any[];

/** E2E-6: 破損返品 → 在庫に戻さず → 交換 → 交換品の出荷（通常の引当 → Pick → Pack → Ship） */
test('E2E-6: damaged return is not restocked → exchange → replacement goes through normal fulfillment and ships', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['EXC-A']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['EXC-A']!.id, 5);
  const o = await shippedOrder(owner, s, `E6-${Date.now()}`, [{ sku: 'EXC-A', quantity: 1 }]);
  const item = o.items[0];
  const r = await owner.post('/returns', { orderId: o.id, reasonCode: 'defective', items: [{ orderItemId: item.id, qty: 1 }] });
  await owner.post(`/returns/${r.id}/authorize`, {});
  const rd = await owner.get(`/returns/${r.id}`);
  await owner.post(`/returns/${r.id}/receive`, { warehouseId: s.warehouses.TKY, items: [{ returnItemId: rd.items[0].id, receivedQty: 1 }] });
  const before = await bal(owner, s.products['EXC-A']!.id);
  const manager = await inviteUser(owner, 'ops_manager');

  // PC: 破損として検品 → 交換品を手配
  const pc = await loginPage(browser, manager.email, DEVICES.pc, errors);
  await pc.page.goto(`/returns/${r.id}`);
  await pc.page.locator('select[id^="d-"]').first().selectOption('damaged');
  await pc.page.locator('input[id^="r-"]').first().fill('外箱破損・中身にキズ');
  await pc.page.getByRole('button', { name: '検品結果を確定（在庫に反映）' }).click();
  await expect.poll(async () => (await owner.get(`/returns/${r.id}`)).status).toBe('completed');
  const after = await bal(owner, s.products['EXC-A']!.id);
  const sum = (b: any[], kind: string, k: string) => b.filter((x) => x.kind === kind).reduce((n, x) => n + x[k], 0);
  expect(sum(after, 'pick', 'available')).toBe(sum(before, 'pick', 'available')); // 販売可能在庫に戻らない（R16）
  expect(sum(after, 'damaged', 'onHand')).toBe(1);
  await pc.page.getByRole('button', { name: '交換品を手配' }).click();
  await pc.page.getByRole('button', { name: '交換品の注文を作成' }).click();
  await expect.poll(async () => (await owner.get(`/returns/${r.id}`)).exchanges.length).toBe(1);
  const ex = (await owner.get(`/returns/${r.id}`)).exchanges[0];
  const rep = await owner.get(`/orders/${ex.replacementOrderId}`);
  expect(rep).toMatchObject({ orderType: 'replacement', sourceOrderId: o.id, status: 'allocated' });
  // 交換品は通常の Wave → Pick → Pack → 出荷
  await waveAndPick(owner, s.warehouses.TKY, [rep.fulfillments[0].id]);
  const [sh] = await packViaApi(owner, rep.fulfillments[0].id);
  await shipViaApi(owner, sh!.id, trackingNo());
  expect((await owner.get(`/orders/${ex.replacementOrderId}`)).status).toBe('shipped');
  await pc.page.goto(`/returns/${r.id}`);
  await expect(pc.page.getByText(/交換/).first()).toBeVisible();
  expect((await owner.get(`/returns/${r.id}`)).exchanges[0]).toMatchObject({ status: 'completed', replacementStatus: 'shipped' });
  // 元注文から交換品の注文へたどれる（画面）
  await pc.page.goto(`/orders/${o.id}`);
  await expect(pc.page.getByRole('link', { name: rep.orderNumber })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  await pc.ctx.close();
});
