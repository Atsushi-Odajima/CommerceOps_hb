import { expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, manualOrder, packViaApi, receive, seed, shipViaApi, signupOrg, trackingNo, waveAndPick } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

/** E2E-3: 3 SKU 中 1 つが欠品 → 揃った 2 SKU を先行出荷 → 後日入荷 → 残りを引当 → 2 回目の出荷 → 完了 */
test('E2E-3: 1 of 3 SKUs short → ship 2 SKUs first → restock later → second shipment → order shipped', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['SKU-A', 'SKU-B', 'SKU-C']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['SKU-A']!.id, 5);
  await receive(owner, s.locations.TKY['A-02']!.id, s.products['SKU-B']!.id, 5);
  const o = await manualOrder(owner, s.channels.WEB, `E3-${Date.now()}`, [
    { sku: 'SKU-A', quantity: 1 },
    { sku: 'SKU-B', quantity: 2 },
    { sku: 'SKU-C', quantity: 1 },
  ]);
  const manager = await inviteUser(owner, 'ops_manager');
  const pc = await loginPage(browser, manager.email, DEVICES.pc, errors);
  await pc.page.goto(`/orders/${o.id}`);
  await pc.page.getByRole('button', { name: 'ルールで引当' }).click();
  await expect(pc.page.getByText(/一部引当しました（3個・不足 1個）/)).toBeVisible();
  await expect(pc.page.getByText('一部引当').first()).toBeVisible();
  // 揃った分を先行出荷（画面）→ ピック・梱包・出荷
  await pc.page.getByRole('button', { name: '揃った分を先行出荷' }).click();
  await expect(pc.page.getByText('揃った分で先行出荷の作業を作成しました')).toBeVisible();
  let d = await owner.get(`/orders/${o.id}`);
  const ff1 = d.fulfillments.find((f: any) => f.status === 'ready');
  await waveAndPick(owner, s.warehouses.TKY, [ff1.id]);
  const [sh1] = await packViaApi(owner, ff1.id);
  expect(sh1).toBeTruthy();
  await shipViaApi(owner, sh1!.id, trackingNo());
  await pc.page.reload();
  await expect(pc.page.getByText('一部出荷').first()).toBeVisible();
  // 後日 SKU-C が入荷 → 残りを引当（画面）→ 2 回目の出荷
  await receive(owner, s.locations.TKY['A-03']!.id, s.products['SKU-C']!.id, 3);
  await pc.page.reload();
  await pc.page.getByRole('button', { name: 'ルールで引当' }).click();
  await expect(pc.page.getByText(/全量引当しました（1個）/)).toBeVisible();
  d = await owner.get(`/orders/${o.id}`);
  const ff2 = d.fulfillments.find((f: any) => f.status === 'ready');
  await waveAndPick(owner, s.warehouses.TKY, [ff2.id]);
  const [sh2] = await packViaApi(owner, ff2.id);
  await shipViaApi(owner, sh2!.id, trackingNo(), 'sagawa');
  await pc.page.reload();
  await expect(pc.page.getByText('出荷済').first()).toBeVisible();
  d = await owner.get(`/orders/${o.id}`);
  expect(d.status).toBe('shipped');
  expect(d.shipments.filter((x: any) => x.status === 'shipped')).toHaveLength(2);
  expect(d.items.every((i: any) => i.shippedQty === i.quantity)).toBe(true);
  // 2 回目の荷物には SKU-C だけ
  const sh2d = await owner.get(`/shipments/${sh2!.id}`);
  expect(sh2d.items.map((i: any) => [i.sku, i.quantity])).toEqual([['SKU-C', 1]]);
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  await pc.ctx.close();
});
