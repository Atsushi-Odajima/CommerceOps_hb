import { devices, expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, manualOrder, packViaApi, receive, seed, shipViaApi, signupOrg, trackingNo, waveAndPick } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

/** E2E-4: Pick で現物不足 → Short Pick（スマホ）→ Manager（PC）が別倉庫へ再割当 → Pick / Pack / 出荷 */
test('E2E-4: short pick on the phone → manager reallocates to another warehouse on PC → pick/pack/ship', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['SHORT-X']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['SHORT-X']!.id, 2);
  await receive(owner, s.locations.OSK['A-01']!.id, s.products['SHORT-X']!.id, 5);
  const o = await manualOrder(owner, s.channels.WEB, `E4-${Date.now()}`, [{ sku: 'SHORT-X', quantity: 2 }]);
  expect((await owner.post(`/orders/${o.id}/allocate`, { warehouseId: s.warehouses.TKY })).outcome).toBe('full');
  const d0 = await owner.get(`/orders/${o.id}`);
  const w = await owner.post('/waves', { warehouseId: s.warehouses.TKY, fulfillmentIds: [d0.fulfillments[0].id] });
  const taskId = (await owner.get(`/waves/${w.waveId}`)).tasks[0].id;
  const picker = await inviteUser(owner, 'picker');
  const manager = await inviteUser(owner, 'ops_manager');

  // スマホ（Android）: ロケーション scan → 棚にない（Short）
  const phone = await loginPage(browser, picker.email, devices['Pixel 7'], errors);
  await phone.page.goto('/m/tasks');
  await phone.page.getByRole('button', { name: 'このタスクを開始' }).first().click();
  await phone.page.waitForURL(/\/m\/pick\//);
  await phone.page.fill('#pick-scan', s.locations.TKY['A-01']!.barcode);
  await phone.page.press('#pick-scan', 'Enter');
  await phone.page.getByRole('button', { name: '棚にない（Short）' }).click();
  await phone.page.getByRole('button', { name: 'Short を報告' }).click();
  await expect(phone.page.getByText(/Short 2 個を管理者に報告しました/)).toBeVisible();
  let d = await owner.get(`/orders/${o.id}`);
  expect(d.status).not.toBe('cancelled');
  expect(d.exceptions.map((e: any) => e.type)).toContain('short_pick');

  // PC（Manager）: Fulfillment 一覧 → Short を解決 → 大阪へ再割当
  const pc = await loginPage(browser, manager.email, DEVICES.pc, errors);
  await pc.page.goto('/fulfillments');
  await pc.page.getByRole('button', { name: 'Short を解決' }).first().click();
  await pc.page.getByLabel(/別の倉庫/).check();
  await pc.page.selectOption('#rs-wh', s.warehouses.OSK);
  await pc.page.getByRole('button', { name: '実行' }).click();
  await expect(pc.page.getByText(/Short 2 個のうち 2 個を再割当しました/)).toBeVisible();
  d = await owner.get(`/orders/${o.id}`);
  const osk = d.fulfillments.find((f: any) => f.warehouseCode === 'OSK' && f.status === 'ready');
  expect(osk).toBeTruthy();
  expect(d.exceptions.find((e: any) => e.type === 'short_pick').status).toBe('resolved');
  // 大阪で Pick / Pack / 出荷
  await waveAndPick(owner, s.warehouses.OSK, [osk.id]);
  const [sh] = await packViaApi(owner, osk.id);
  await shipViaApi(owner, sh!.id, trackingNo());
  d = await owner.get(`/orders/${o.id}`);
  expect(d.status).toBe('shipped');
  // 東京の現物不足分は「調査中（held）」で販売可能在庫に含まれない
  const bal = await owner.get(`/inventory/balances?productId=${s.products['SHORT-X']!.id}&warehouseId=${s.warehouses.TKY}`);
  const tky = bal.items.filter((b: any) => b.kind === 'pick');
  expect(tky.reduce((n: number, b: any) => n + b.held, 0)).toBe(2);
  expect(tky.reduce((n: number, b: any) => n + b.available, 0)).toBe(0);
  void taskId;
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  await phone.ctx.close();
  await pc.ctx.close();
});
