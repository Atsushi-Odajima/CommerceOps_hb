import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Api, asciiTempPath, DEVICES, inviteUser, loginPage, manualOrder, packViaApi, receive, seed, shippedOrder, shipViaApi, signupOrg, trackingNo, waveAndPick } from '../support/api.js';
import { E2E_RESTORE_DB, integrityOk, sql } from '../support/integrity.js';

const RESTORE_URL = 'http://localhost:3101';

/** 画面・API で比較する「業務の中身」 */
async function digest(api: Api) {
  const orders = (await api.get('/orders?limit=200&sort=order_date_asc')).items as any[];
  const details = [];
  for (const o of orders) {
    const d = await api.get(`/orders/${o.id}`);
    details.push({
      orderNumber: d.orderNumber,
      externalOrderId: d.externalOrderId,
      status: d.status,
      items: d.items.map((i: any) => [i.sku, i.quantity, i.allocatedQty, i.shippedQty]),
      fulfillments: d.fulfillments.map((f: any) => [f.fulfillmentNumber, f.status, f.warehouseCode]),
      shipments: d.shipments.map((x: any) => [x.shipmentNumber, x.status, x.trackingNumber]),
      returns: (d.returns ?? []).map((r: any) => [r.returnNumber, r.status]),
      related: (d.relatedOrders ?? []).map((r: any) => r.orderNumber),
    });
  }
  const waves = (await api.get('/waves?limit=200')).items.map((w: any) => [w.waveNumber, w.status, w.pickedUnits]);
  const returns = (await api.get('/returns?limit=200')).items.map((r: any) => [r.returnNumber, r.status]);
  const inventory = (await api.get('/inventory?limit=200')).items.map((b: any) => [b.sku, b.warehouseCode, b.onHand, b.allocated, b.available, b.damaged]);
  const audit = (await api.get('/audit?limit=1')).total as number;
  return { details, waves, returns, inventory, audit };
}

/** E2E-9: Backup（画面）→ 空の環境で Restore（画面）→ 注文・引当・Wave・Pick・Pack・Shipment・Return・監査が一致 */
test('E2E-9: download a backup in the UI → restore it in the UI of an empty environment → orders, allocations, waves, picks, packs, shipments, returns and audit match', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, email: ownerEmail, orgId } = await signupOrg(baseURL!);
  const s = await seed(owner, ['BK-A', 'BK-B']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['BK-A']!.id, 20);
  await receive(owner, s.locations.TKY['A-02']!.id, s.products['BK-B']!.id, 20);
  // 出荷 → 返品 Restock / 破損 → 交換（出荷まで）
  const o1 = await shippedOrder(owner, s, `E9-1-${Date.now()}`, [{ sku: 'BK-A', quantity: 2 }, { sku: 'BK-B', quantity: 1 }]);
  const r1 = await owner.post('/returns', { orderId: o1.id, reasonCode: 'size_issue', items: [{ orderItemId: o1.items[0].id, qty: 2 }] });
  await owner.post(`/returns/${r1.id}/authorize`, {});
  const r1d = await owner.get(`/returns/${r1.id}`);
  await owner.post(`/returns/${r1.id}/receive`, { warehouseId: s.warehouses.TKY, items: [{ returnItemId: r1d.items[0].id, receivedQty: 2 }] });
  await owner.post(`/returns/${r1.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: r1d.items[0].id, disposition: 'restock', qty: 1 }, { returnItemId: r1d.items[0].id, disposition: 'damaged', qty: 1, reason: '破損' }] });
  const ex = await owner.post(`/returns/${r1.id}/exchange`, { items: [{ sku: 'BK-A', quantity: 1, originalOrderItemId: o1.items[0].id }] });
  const rep = await owner.get(`/orders/${ex.replacementOrderId}`);
  await waveAndPick(owner, s.warehouses.TKY, [rep.fulfillments[0].id]);
  for (const sh of await packViaApi(owner, rep.fulfillments[0].id)) await shipViaApi(owner, sh.id, trackingNo());
  // 進行中の注文（引当済み・Wave 投入済み）と保留
  const o2 = await manualOrder(owner, s.channels.WEB, `E9-2-${Date.now()}`, [{ sku: 'BK-B', quantity: 3 }]);
  await owner.post(`/orders/${o2.id}/allocate`, {});
  const o2d = await owner.get(`/orders/${o2.id}`);
  await owner.post('/waves', { warehouseId: s.warehouses.TKY, fulfillmentIds: [o2d.fulfillments[0].id] });
  const o3 = await manualOrder(owner, s.channels.MPA, `E9-3-${Date.now()}`, [{ sku: 'BK-A', quantity: 1 }]);
  await owner.post(`/orders/${o3.id}/holds`, { reasonCode: 'address_check', note: '番地確認' });
  await inviteUser(owner, 'picker');
  const before = await digest(owner);
  expect(before.details.length).toBe(4);

  // 元の環境: Owner が画面からバックアップをダウンロード
  const src = await loginPage(browser, ownerEmail, DEVICES.pc, errors);
  await src.page.goto('/settings/backup');
  const [dl] = await Promise.all([src.page.waitForEvent('download'), src.page.getByRole('button', { name: 'バックアップをダウンロード' }).click()]);
  const file = asciiTempPath(dl.suggestedFilename());
  await dl.saveAs(file);
  expect(dl.suggestedFilename()).toMatch(/^commerceops-backup-\d{8}T\d{6}\.ndjson\.gz$/);

  // 空の環境: 運用者がサインアップ → 画面から検証 → 新しい組織として復元 → 切替
  const target = await signupOrg(RESTORE_URL, '復元先の空の組織');
  const ctx = await browser.newContext({ ...DEVICES.pc, baseURL: RESTORE_URL, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[restore] PAGEERROR ${e.message}`));
  await page.goto('/login');
  await page.fill('#email', target.email);
  await page.fill('#password', 'E2e-Passw0rd-2026');
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  await page.goto('/settings/backup');
  await page.setInputFiles('#bk-file', file);
  await page.getByRole('button', { name: 'ファイルを検証' }).click();
  await expect(page.getByText('検証 OK')).toBeVisible();
  await page.getByLabel(/新しい組織として復元し、自分がその組織の Owner/).check();
  await page.getByRole('button', { name: '新しい組織として復元' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '復元する' }).click();
  await expect(page.getByText(/復元しました:/)).toBeVisible({ timeout: 60_000 });
  // 元の環境のユーザーはこの環境にいないため、招待し直す一覧が出る
  await expect(page.getByText(ownerEmail)).toBeVisible();
  await page.getByRole('button', { name: '復元した組織に切り替える' }).click();
  await page.waitForURL(`${RESTORE_URL}/`);
  const restoredApi = await Api.login(RESTORE_URL, target.email);
  const me = await restoredApi.get('/auth/me');
  expect(me.organization.name).toMatch(/（復元 \d{4}-\d{2}-\d{2}）$/);
  expect(me.role).toBe('owner');

  const after = await digest(restoredApi);
  expect(after.details).toEqual(before.details);
  expect(after.waves).toEqual(before.waves);
  expect(after.returns).toEqual(before.returns);
  expect(after.inventory).toEqual(before.inventory);
  // 監査ログ: 元の記録 + バックアップ取得（取得時点で記録済み）+ 復元の 1 行
  expect(after.audit).toBe(before.audit + 2);
  // DB 上の件数も一致（Pick / Pack の記録・引当）
  const counts = async (db: string | undefined, org: string) =>
    (await sql(org, `SELECT (SELECT count(*) FROM allocations WHERE organization_id = $1)::int AS a, (SELECT count(*) FROM pick_events WHERE organization_id = $1)::int AS pe,
                             (SELECT count(*) FROM pack_events WHERE organization_id = $1)::int AS pk, (SELECT count(*) FROM inventory_movements WHERE organization_id = $1)::int AS m`, [org], db))[0];
  expect(await counts(E2E_RESTORE_DB, me.organization.id)).toEqual(await counts(undefined, orgId));
  expect(await integrityOk(me.organization.id, E2E_RESTORE_DB)).toBe(true);
  expect(errors).toEqual([]);
  await src.ctx.close();
  await ctx.close();
  await restoredApi.dispose();
});
