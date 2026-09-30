import { randomUUID } from 'node:crypto';
import { devices, expect, test } from '@playwright/test';
import { Api, DEVICES, inviteUser, loginPage, manualOrder, receive, seed, shippedOrder, signupOrg } from '../support/api.js';

type Role = 'owner' | 'ops_manager' | 'picker' | 'packer' | 'support';

/**
 * E2E-7: ロールごとに「許可された操作は成功・禁止された API は 403・禁止された画面は表示されない」。
 * UI で隠すだけでなく API でも拒否されることを、各ロールでログインして確認する。
 */
test('E2E-7: every role — allowed operations succeed, forbidden APIs are rejected, forbidden screens are not shown', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, email: ownerEmail } = await signupOrg(baseURL!);
  const s = await seed(owner, ['RB-A', 'RB-B']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['RB-A']!.id, 20);
  const shipped = await shippedOrder(owner, s, `E7S-${Date.now()}`, [{ sku: 'RB-A', quantity: 1 }]);
  const ret = await owner.post('/returns', { orderId: shipped.id, reasonCode: 'defective', items: [{ orderItemId: shipped.items[0].id, qty: 1 }] });
  await owner.post(`/returns/${ret.id}/authorize`, {});
  const retItem = (await owner.get(`/returns/${ret.id}`)).items[0].id;
  // 検品は到着処理の後にしかできない（到着だけでは在庫は増えない）
  await owner.post(`/returns/${ret.id}/receive`, { warehouseId: s.warehouses.TKY, items: [{ returnItemId: retItem, receivedQty: 1 }] });
  const open = await manualOrder(owner, s.channels.MAN, `E7O-${Date.now()}`, [{ sku: 'RB-B', quantity: 1 }]);
  const users: Record<Role, { email: string; api: Api }> = {
    owner: { email: ownerEmail, api: owner },
    ops_manager: await inviteUser(owner, 'ops_manager'),
    picker: await inviteUser(owner, 'picker'),
    packer: await inviteUser(owner, 'packer'),
    support: await inviteUser(owner, 'support'),
  };
  const adjust = { locationId: s.locations.TKY['A-01']!.id, productId: s.products['RB-A']!.id, mode: 'delta', qty: 1, reason: 'E2E', requestId: randomUUID() };
  const inspect = { clientRequestId: randomUUID(), lines: [{ returnItemId: retItem, disposition: 'restock', qty: 1 }] };
  // [method, url, body] → 期待（true = 許可）
  const matrix: { name: string; req: [string, string, unknown?]; allow: Role[] }[] = [
    { name: '倉庫の追加', req: ['POST', '/warehouses', { code: `W${Date.now().toString(36).slice(-4).toUpperCase()}`, name: 'x' }], allow: ['owner'] },
    { name: 'ユーザー招待', req: ['POST', '/users/invitations', { email: `${randomUUID().slice(0, 8)}@e2e.test`, role: 'picker' }], allow: ['owner'] },
    { name: 'バックアップ履歴', req: ['GET', '/backup/runs'], allow: ['owner'] },
    { name: '監査ログ', req: ['GET', '/audit'], allow: ['owner', 'ops_manager'] },
    { name: '引当の実行', req: ['POST', '/allocation/run', {}], allow: ['owner', 'ops_manager'] },
    { name: '在庫調整（R24）', req: ['POST', '/inventory/adjustments', adjust], allow: ['owner', 'ops_manager'] },
    { name: '注文一覧', req: ['GET', '/orders'], allow: ['owner', 'ops_manager', 'support'] },
    { name: '注文の保留', req: ['POST', `/orders/${open.id}/holds`, { reasonCode: 'customer_confirm', note: 'E2E' }], allow: ['owner', 'ops_manager', 'support'] },
    { name: '返品検品 Disposition（R23）', req: ['POST', `/returns/${ret.id}/inspect`, inspect], allow: ['owner', 'ops_manager'] },
    { name: 'Pick タスク一覧', req: ['GET', '/pick-tasks'], allow: ['owner', 'ops_manager', 'picker'] },
    { name: '梱包キュー', req: ['GET', '/pack/queue'], allow: ['owner', 'ops_manager', 'packer'] },
    { name: 'KPI', req: ['GET', '/kpi?from=2026-09-01&to=2026-09-30'], allow: ['owner', 'ops_manager'] },
    { name: '注文 CSV 出力', req: ['GET', '/orders/export'], allow: ['owner', 'ops_manager'] },
  ];
  const results: string[] = [];
  for (const m of matrix) {
    for (const role of Object.keys(users) as Role[]) {
      // 状態を変える操作は許可ロールの 1 人目だけ実行（2 人目以降は重複で 409 になるため、禁止ロールの確認を優先）
      if (m.allow.includes(role) && m.req[0] !== 'GET' && m.allow[0] !== role) continue;
      const r = await users[role].api.raw(m.req[0], m.req[1], m.req[2]);
      const ok = r.status() >= 200 && r.status() < 300;
      if (m.allow.includes(role) !== ok) results.push(`${m.name} / ${role}: HTTP ${r.status()} ${(await r.text()).slice(0, 120)}`);
      if (!m.allow.includes(role)) expect(r.status(), `${m.name} / ${role}`).toBe(403);
    }
  }
  expect(results).toEqual([]);

  // 画面: 各ロールのナビゲーションと、禁止画面の表示
  const nav = async (role: Role, deviceOpts: object) => {
    const c = await loginPage(browser, users[role].email, deviceOpts, errors);
    return c;
  };
  const o = await nav('owner', DEVICES.pc);
  await expect(o.page.getByRole('link', { name: '設定' })).toBeVisible();
  await expect(o.page.getByRole('link', { name: '監査ログ' })).toBeVisible();
  const mgr = await nav('ops_manager', DEVICES.pc);
  await expect(mgr.page.getByRole('link', { name: '監査ログ' })).toBeVisible();
  await expect(mgr.page.getByRole('link', { name: '設定' })).toHaveCount(0);
  await mgr.page.goto('/settings/backup');
  await expect(mgr.page.getByText('アクセスできません')).toBeVisible();
  const sup = await nav('support', DEVICES.pc);
  await expect(sup.page.getByRole('link', { name: '注文', exact: true })).toBeVisible();
  await expect(sup.page.getByRole('link', { name: '在庫・商品' })).toBeVisible();
  await sup.page.goto('/waves');
  await expect(sup.page.getByText('アクセスできません')).toBeVisible();
  const pk = await nav('picker', devices['Pixel 7']);
  await pk.page.waitForURL(/\/m/);
  await pk.page.goto('/orders');
  await expect(pk.page.getByText('アクセスできません')).toBeVisible();
  const pa = await nav('packer', devices['iPad Pro 11']);
  await pa.page.waitForURL(/\/pack$/);
  await pa.page.goto('/returns/new');
  await expect(pa.page.getByText('アクセスできません')).toBeVisible();
  expect(errors).toEqual([]);
  for (const c of [o, mgr, sup, pk, pa]) await c.ctx.close();
});
