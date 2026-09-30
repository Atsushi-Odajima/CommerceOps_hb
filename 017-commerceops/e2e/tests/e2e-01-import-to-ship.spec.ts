import { writeFileSync } from 'node:fs';
import { devices, expect, test } from '@playwright/test';
import { asciiTempPath, DEVICES, expectNoHorizontalOverflow, inviteUser, loginPage, ordersCsv, receive, seed, signupOrg } from '../support/api.js';
import { integrityOk, sql } from '../support/integrity.js';

/**
 * E2E-1: CSV 注文取込 → 正規化 → 引当 → Wave →（iPhone）Pick →（iPad）Pack → Shipment → 追跡番号 → 出荷済み
 * 画面操作で通し、各端末でページエラーなし・横はみ出しなしを確認。最後に DB の整合性チェック。
 */
test('E2E-1: CSV import → allocation → wave → iPhone pick → iPad pack → tracking → shipped', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['TEE-RED-M', 'MUG-01']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['TEE-RED-M']!.id, 10);
  await receive(owner, s.locations.TKY['A-02']!.id, s.products['MUG-01']!.id, 10);
  const manager = await inviteUser(owner, 'ops_manager');
  const picker = await inviteUser(owner, 'picker');
  const packer = await inviteUser(owner, 'packer');
  const ext = `E1-${Date.now().toString(36).toUpperCase()}`;

  // --- PC（Manager）: 取込ウィザード
  const pc = await loginPage(browser, manager.email, DEVICES.pc, errors);
  const csvPath = asciiTempPath('orders.csv');
  writeFileSync(
    csvPath,
    ordersCsv([
      { ext: `${ext}-1`, sku: 'TEE-RED-M', qty: 2 },
      { ext: `${ext}-1`, sku: 'MUG-01', qty: 1 },
      { ext: `${ext}-2`, sku: 'MUG-01', qty: 1, name: '佐藤 一郎' },
    ]),
  );
  await pc.page.goto('/imports/new');
  await pc.page.locator(`#imp-profile option[value="${s.profileId}"]`).waitFor({ state: 'attached' });
  await pc.page.selectOption('#imp-profile', s.profileId);
  await pc.page.setInputFiles('#imp-file', csvPath);
  await expect(pc.page.getByRole('button', { name: 'プレビュー' })).toBeEnabled();
  await pc.page.getByRole('button', { name: 'プレビュー' }).click();
  await pc.page.waitForURL(/\/imports\/[0-9a-f-]{36}$/);
  await expect(pc.page.getByText('新規').first()).toBeVisible();
  await pc.page.getByRole('button', { name: '確定する' }).first().click();
  await pc.page.getByRole('dialog').getByRole('button', { name: '確定する' }).click();
  await expect.poll(async () => (await owner.get(`/orders?q=${ext}`)).total).toBe(2);

  // --- PC: 引当（Job）
  await pc.page.goto('/allocation');
  await pc.page.getByRole('button', { name: '引当を実行' }).click();
  await expect(pc.page.getByText(/引当完了: 全量 2/)).toBeVisible({ timeout: 30_000 });
  const orders = (await owner.get(`/orders?q=${ext}&sort=order_date_asc`)).items as any[];
  expect(orders.map((o) => o.status)).toEqual(['allocated', 'allocated']);

  // --- PC: Wave 作成
  await pc.page.goto('/waves/new');
  await pc.page.selectOption('#wv-wh', s.warehouses.TKY);
  for (const o of orders) await pc.page.locator('tr', { hasText: o.orderNumber }).getByRole('checkbox').check();
  await pc.page.getByRole('button', { name: /Wave を作成（2 件）/ }).click();
  await pc.page.waitForURL(/\/waves\/[0-9a-f-]{36}$/);
  const waveId = pc.page.url().split('/').pop()!;

  // --- iPhone（Picker）: 現場モードでロケーション → 商品を scan（ハンディスキャナ相当の高速入力）
  const phone = await loginPage(browser, picker.email, devices['iPhone 14'], errors);
  await phone.page.waitForURL(/\/m/);
  await expectNoHorizontalOverflow(phone.page);
  await phone.page.goto('/m/tasks');
  const task = (await owner.get(`/waves/${waveId}`)).tasks[0];
  await phone.page.locator('.big-card', { hasText: task.taskNumber }).getByRole('button', { name: 'このタスクを開始' }).click();
  await phone.page.waitForURL(/\/m\/pick\//);
  const scan = async (code: string) => {
    await phone.page.fill('#pick-scan', code);
    await phone.page.press('#pick-scan', 'Enter');
  };
  for (let guard = 0; guard < 12; guard++) {
    const d = await picker.api.get(`/pick-tasks/${task.id}`);
    const g = d.groups.find((x: any) => x.remaining > 0);
    if (!g) break;
    const label = (await phone.page.locator('label[for=pick-scan]').textContent()) ?? '';
    if (label.includes('ロケーション')) {
      await scan(g.locationBarcode);
      await expect(phone.page.locator('label[for=pick-scan]')).not.toContainText('ロケーション');
    }
    await scan(g.barcodes[1]); // JAN
    await expect.poll(async () => (await picker.api.get(`/pick-tasks/${task.id}`)).groups.find((x: any) => x.key === g.key).remaining).toBe(g.remaining - 1);
  }
  await expect(phone.page.getByText(/完了|すべてピック/).first()).toBeVisible();
  const events = await owner.get(`/pick-tasks/${task.id}`);
  expect(events.status).toBe('completed');

  // --- iPad（Packer）: Packing Station で注文番号 → 商品を 1 個ずつ scan → 梱包完了
  const ipad = await loginPage(browser, packer.email, devices['iPad Pro 11 landscape'], errors);
  await ipad.page.waitForURL(/\/pack$/);
  await expectNoHorizontalOverflow(ipad.page);
  for (const o of orders) {
    await ipad.page.goto('/pack');
    await ipad.page.fill('#pack-open', o.orderNumber);
    await ipad.page.press('#pack-open', 'Enter');
    await ipad.page.waitForURL(/\/pack\/[0-9a-f-]{36}$/);
    const sid = ipad.page.url().split('/').pop()!;
    const view = await packer.api.get(`/pack/sessions/${sid}`);
    for (const it of view.items) {
      for (let n = 0; n < it.remaining; n++) {
        await ipad.page.fill('#pack-scan', it.barcodes[0]);
        await ipad.page.press('#pack-scan', 'Enter');
        await expect.poll(async () => (await packer.api.get(`/pack/sessions/${sid}`)).items.find((x: any) => x.sku === it.sku).packed).toBe(it.packed + n + 1);
      }
    }
    await ipad.page.getByRole('button', { name: '梱包完了', exact: true }).click();
    await expect.poll(async () => (await owner.get(`/orders/${o.id}`)).status).toBe('packed');
  }

  // --- PC: 出荷待ち一覧で配送会社・追跡番号を入力 → 出荷確定
  await pc.page.goto('/shipments?status=draft');
  const detail = await Promise.all(orders.map((o) => owner.get(`/orders/${o.id}`)));
  for (const [i, d] of detail.entries()) {
    const sh = d.shipments[0];
    const row = pc.page.locator('tr', { hasText: sh.shipmentNumber });
    await row.getByLabel(`${sh.shipmentNumber} の配送会社`).selectOption('yamato');
    await row.getByLabel(`${sh.shipmentNumber} の追跡番号`).fill(`4444-5555-${String(Date.now()).slice(-3)}${i}`);
    await row.getByRole('button', { name: '出荷確定' }).click();
    await expect.poll(async () => (await owner.get(`/orders/${d.id}`)).status).toBe('shipped');
  }
  // 注文詳細（画面）で出荷済み・追跡番号を確認
  await pc.page.goto(`/orders/${orders[0].id}`);
  await expect(pc.page.getByText('出荷済').first()).toBeVisible();
  await expect(pc.page.getByText(/4444/).first()).toBeVisible();
  // 在庫: 出荷分だけ on_hand が減る
  const bal = await owner.get(`/inventory/balances?productId=${s.products['MUG-01']!.id}`);
  expect(bal.items.filter((b: any) => b.kind === 'pick').reduce((n: number, b: any) => n + b.onHand, 0)).toBe(8);
  // ハンディスキャナ相当の高速入力は scanner として記録される（Pick・梱包とも）
  const methods = await sql(orgId, `SELECT event_type, input_method FROM pick_events WHERE organization_id = $1 AND pick_task_id = $2 AND event_type IN ('pick', 'location_ok')`, [orgId, task.id]);
  expect(methods.length).toBeGreaterThan(0);
  expect(methods.every((m) => m.input_method === 'scanner')).toBe(true);
  const packMethods = await sql(orgId, `SELECT DISTINCT input_method FROM pack_events WHERE organization_id = $1 AND event_type = 'scan'`, [orgId]);
  expect(packMethods.map((m) => m.input_method)).toEqual(['scanner']);
  expect(errors).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  for (const c of [pc, phone, ipad]) await c.ctx.close();
});
