import { devices, expect, test } from '@playwright/test';
import { DEVICES, inviteUser, loginPage, manualOrder, receive, seed, signupOrg, waveAndPick } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

/**
 * E2E-8: iPhone で Pick、iPad で Pack、PC の Manager が Wave 作成・注文キャンセルを「同時に」行っても整合する。
 */
test('E2E-8: iPhone pick, iPad pack and PC manager operate at the same time and everything stays consistent', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['CC-A', 'CC-B', 'CC-C']);
  for (const [i, sku] of ['CC-A', 'CC-B', 'CC-C'].entries()) await receive(owner, s.locations.TKY[['A-01', 'A-02', 'A-03'][i]!]!.id, s.products[sku]!.id, 30);
  const mk = async (n: number, lines: { sku: string; quantity: number }[]) => {
    const o = await manualOrder(owner, s.channels.WEB, `E8-${n}-${Date.now()}`, lines);
    expect((await owner.post(`/orders/${o.id}/allocate`, {})).outcome).toBe('full');
    return owner.get(`/orders/${o.id}`);
  };
  // O1, O2: iPhone で Pick する Wave / O3: ピック済み（iPad で梱包）/ O4: PC で Wave 作成 / O5: PC でキャンセル
  const o1 = await mk(1, [{ sku: 'CC-A', quantity: 2 }, { sku: 'CC-B', quantity: 1 }]);
  const o2 = await mk(2, [{ sku: 'CC-B', quantity: 1 }]);
  const o3 = await mk(3, [{ sku: 'CC-C', quantity: 2 }]);
  await waveAndPick(owner, s.warehouses.TKY, [o3.fulfillments[0].id]);
  const w1 = await owner.post('/waves', { warehouseId: s.warehouses.TKY, fulfillmentIds: [o1.fulfillments[0].id, o2.fulfillments[0].id] });
  const task = (await owner.get(`/waves/${w1.waveId}`)).tasks[0];
  const o4 = await mk(4, [{ sku: 'CC-A', quantity: 1 }]);
  const o5 = await mk(5, [{ sku: 'CC-C', quantity: 3 }]);
  const picker = await inviteUser(owner, 'picker');
  const packer = await inviteUser(owner, 'packer');
  const manager = await inviteUser(owner, 'ops_manager');
  const phone = await loginPage(browser, picker.email, devices['iPhone 14'], errors);
  const ipad = await loginPage(browser, packer.email, devices['iPad Pro 11 landscape'], errors);
  const pc = await loginPage(browser, manager.email, DEVICES.pc, errors);

  const pickFlow = async () => {
    await phone.page.goto('/m/tasks');
    await phone.page.locator('.big-card', { hasText: task.taskNumber }).getByRole('button', { name: 'このタスクを開始' }).click();
    await phone.page.waitForURL(/\/m\/pick\//);
    for (let guard = 0; guard < 12; guard++) {
      const d = await picker.api.get(`/pick-tasks/${task.id}`);
      const g = d.groups.find((x: any) => x.remaining > 0);
      if (!g) break;
      if (((await phone.page.locator('label[for=pick-scan]').textContent()) ?? '').includes('ロケーション')) {
        await phone.page.fill('#pick-scan', g.locationBarcode);
        await phone.page.press('#pick-scan', 'Enter');
        await expect(phone.page.locator('label[for=pick-scan]')).not.toContainText('ロケーション');
      }
      await phone.page.fill('#pick-scan', g.barcodes[1]);
      await phone.page.press('#pick-scan', 'Enter');
      await expect.poll(async () => (await picker.api.get(`/pick-tasks/${task.id}`)).groups.find((x: any) => x.key === g.key).remaining).toBe(g.remaining - 1);
    }
  };
  const packFlow = async () => {
    await ipad.page.goto('/pack');
    await ipad.page.fill('#pack-open', o3.orderNumber);
    await ipad.page.press('#pack-open', 'Enter');
    await ipad.page.waitForURL(/\/pack\/[0-9a-f-]{36}$/);
    for (let n = 0; n < 2; n++) {
      await ipad.page.fill('#pack-scan', s.products['CC-C']!.jan);
      await ipad.page.press('#pack-scan', 'Enter');
      await expect(ipad.page.getByText(new RegExp(`${n + 1}\\s*/\\s*2`)).first()).toBeVisible();
    }
    await ipad.page.getByRole('button', { name: '梱包完了', exact: true }).click();
    await expect.poll(async () => (await owner.get(`/orders/${o3.id}`)).status).toBe('packed');
  };
  const managerFlow = async () => {
    await pc.page.goto('/waves/new');
    await pc.page.selectOption('#wv-wh', s.warehouses.TKY);
    await pc.page.locator('tr', { hasText: o4.orderNumber }).getByRole('checkbox').check();
    const others = pc.page.locator('tr', { hasText: o5.orderNumber }).getByRole('checkbox');
    if (await others.isChecked()) await others.uncheck();
    await pc.page.getByRole('button', { name: /Wave を作成（1 件）/ }).click();
    await pc.page.waitForURL(/\/waves\/[0-9a-f-]{36}$/);
    await pc.page.goto(`/orders/${o5.id}`);
    await pc.page.getByRole('button', { name: 'キャンセル' }).first().click();
    await pc.page.getByRole('dialog').getByLabel(/理由/).fill('顧客都合（E2E）');
    await pc.page.getByRole('dialog').getByRole('button', { name: /キャンセルする/ }).click();
    await expect.poll(async () => (await owner.get(`/orders/${o5.id}`)).status).toBe('cancelled');
  };
  await Promise.all([pickFlow(), packFlow(), managerFlow()]);

  const [d1, d2, d3, d4, d5] = await Promise.all([o1, o2, o3, o4, o5].map((o) => owner.get(`/orders/${o.id}`)));
  // O4 は PC で作った Wave に入った（未ピック）ので「ピッキング中」、Fulfillment は waved
  expect([d1.status, d2.status, d3.status, d4.status, d5.status]).toEqual(['picked', 'picked', 'packed', 'picking', 'cancelled']);
  expect(d4.fulfillments[0].status).toBe('waved');
  expect(d4.fulfillments[0].waveId).toBeTruthy();
  // キャンセルした注文の引当は解放され、在庫は減っていない
  const c = await owner.get(`/inventory/balances?productId=${s.products['CC-C']!.id}`);
  const pick = c.items.filter((b: any) => b.kind === 'pick');
  expect(pick.reduce((n: number, b: any) => n + b.onHand, 0)).toBe(30);
  expect(pick.reduce((n: number, b: any) => n + b.allocated, 0)).toBe(2); // O3 の梱包済み分だけ
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  for (const x of [phone, ipad, pc]) await x.ctx.close();
});
