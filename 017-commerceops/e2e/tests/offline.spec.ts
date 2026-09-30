import { devices, expect, test } from '@playwright/test';
import { inviteUser, loginPage, manualOrder, receive, seed, signupOrg } from '../support/api.js';
import { integrityOk } from '../support/integrity.js';

/**
 * オフライン: スマホ Pick で通信が切れたら、読取は端末内に「未同期」として保存され（サーバーの数量は増えない）、
 * 再接続すると 1 回だけ送信されてサーバーが再検証する。梱包・出荷など在庫を確定する操作はオフラインでは行えない。
 */
test('offline pick: scans are queued as "unsynced" on the phone, not counted by the server until reconnect, then sent exactly once', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['OF-A']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['OF-A']!.id, 10);
  const o = await manualOrder(owner, s.channels.WEB, `OF-${Date.now()}`, [{ sku: 'OF-A', quantity: 3 }]);
  expect((await owner.post(`/orders/${o.id}/allocate`, {})).outcome).toBe('full');
  const d = await owner.get(`/orders/${o.id}`);
  const w = await owner.post('/waves', { warehouseId: s.warehouses.TKY, fulfillmentIds: [d.fulfillments[0].id] });
  const task = (await owner.get(`/waves/${w.waveId}`)).tasks[0];
  const picker = await inviteUser(owner, 'picker');
  const { ctx, page } = await loginPage(browser, picker.email, devices['iPhone 14'], errors);
  const picked = async () => (await owner.get(`/pick-tasks/${task.id}`)).groups[0].picked as number;

  await page.goto('/m/tasks');
  await page.locator('.big-card', { hasText: task.taskNumber }).getByRole('button', { name: 'このタスクを開始' }).click();
  await page.waitForURL(/\/m\/pick\//);
  const g = (await picker.api.get(`/pick-tasks/${task.id}`)).groups[0];
  await page.fill('#pick-scan', g.locationBarcode);
  await page.press('#pick-scan', 'Enter');
  await expect(page.locator('label[for=pick-scan]')).not.toContainText('ロケーション');
  // 1 個目はオンラインで読む
  await page.fill('#pick-scan', s.products['OF-A']!.jan);
  await page.press('#pick-scan', 'Enter');
  await expect.poll(picked).toBe(1);

  // 通信が切れる → 2 個目は端末内に未同期として保存（サーバーは 1 のまま）
  await ctx.setOffline(true);
  await expect(page.getByText(/オフライン/).first()).toBeVisible();
  await page.fill('#pick-scan', s.products['OF-A']!.jan);
  await page.press('#pick-scan', 'Enter');
  await expect(page.getByText(/未同期で記録しました/)).toBeVisible();
  await expect(page.getByText('未同期 1', { exact: true })).toBeVisible();
  // 違う商品はオフラインでも拒否（未同期にもならない）
  await page.fill('#pick-scan', 'NOT-A-PRODUCT');
  await page.press('#pick-scan', 'Enter');
  await expect(page.getByText(/違う商品です/)).toBeVisible();
  await expect(page.getByText('未同期 1', { exact: true })).toBeVisible();
  expect(await picked()).toBe(1);

  // 再接続 → 自動で送信（1 回だけ）→ 案内が出て、サーバーの数量が 2 になる
  await ctx.setOffline(false);
  await expect(page.getByText(/未同期の読取を送信しました（1 件反映/)).toBeVisible({ timeout: 15_000 });
  await expect.poll(picked).toBe(2);
  await expect(page.getByText('未同期 1', { exact: true })).toHaveCount(0);
  // 念のためもう一度オフライン → オンラインを繰り返しても二重に送られない
  await ctx.setOffline(true);
  await ctx.setOffline(false);
  await page.waitForTimeout(1500);
  expect(await picked()).toBe(2);
  // 通信断そのものによる読み込み失敗のログは除く
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|net::ERR_|Failed to fetch/.test(e))).toEqual([]);
  expect(await integrityOk(orgId)).toBe(true);
  await ctx.close();
});
