import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestClient, type TestEnv } from './helpers/env.js';
import { addMember } from './helpers/factory.js';
import { availability, locationsOf, manualOrder, receive, setupBasicOrg } from './helpers/scenario.js';
import { expectIntegrity } from './helpers/integrity.js';
import { expirePickClaims } from '../src/modules/picking/service.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function allocatedOrder(c: TestClient, channelId: string, ext: string, lines: { sku: string; quantity: number }[]) {
  const o = await manualOrder(c, channelId, ext, lines);
  const r = expectStatus(await c.post(`/api/orders/${o.id}/allocate`, {}), 200).body;
  expect(r.outcome).toBe('full');
  return o;
}

async function makeWave(c: TestClient, warehouseId: string, extra: Record<string, unknown> = {}) {
  const pv = expectStatus(await c.post('/api/waves/preview', { warehouseId }), 200).body;
  const w = expectStatus(await c.post('/api/waves', { warehouseId, fulfillmentIds: pv.fulfillments.map((f: any) => f.id), ...extra }), 200).body;
  return { preview: pv, wave: w };
}

describe('Phase4 wave & picking (R06–R09)', () => {
  it('R06: orders arriving after the wave snapshot are not added to it', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 50);
    const o1 = await allocatedOrder(s.owner.client, s.channelId, 'W6-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const o2 = await allocatedOrder(s.owner.client, s.channelId, 'W6-2', [{ sku: 'SKU-A', quantity: 2 }]);
    const pv = expectStatus(await s.owner.client.post('/api/waves/preview', { warehouseId: s.warehouseId }), 200).body;
    expect(pv.fulfillments).toHaveLength(2);
    // プレビュー後に新しい注文が到着
    const late = await allocatedOrder(s.owner.client, s.channelId, 'W6-LATE', [{ sku: 'SKU-A', quantity: 1 }]);
    const w = expectStatus(await s.owner.client.post('/api/waves', { warehouseId: s.warehouseId, fulfillmentIds: pv.fulfillments.map((f: any) => f.id), label: '午前便' }), 200).body;
    expect(w.fulfillments).toBe(2);
    const detail = expectStatus(await s.owner.client.get(`/api/waves/${w.waveId}`), 200).body;
    expect(detail.fulfillments.map((f: any) => f.orderNumber).sort()).toEqual([o1.orderNumber, o2.orderNumber].sort());
    const lateDetail = expectStatus(await s.owner.client.get(`/api/orders/${late.id}`), 200).body;
    expect(lateDetail.fulfillments[0].status).toBe('ready');
    expect(lateDetail.fulfillments[0].waveId).toBeNull();
    // 同じ Fulfillment を別 Wave に入れようとしても入らない（二重投入防止）
    const again = await s.owner.client.post('/api/waves', { warehouseId: s.warehouseId, fulfillmentIds: pv.fulfillments.map((f: any) => f.id) });
    expect(again.status).toBe(409);
    expect(expectStatus(await s.owner.client.get(`/api/orders/${o1.id}`), 200).body.status).toBe('picking');
  });

  it('R07: two pickers claiming the same task at once → only one succeeds', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    await allocatedOrder(s.owner.client, s.channelId, 'W7-1', [{ sku: 'SKU-A', quantity: 2 }]);
    const { wave } = await makeWave(s.owner.client, s.warehouseId);
    const detail = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body;
    const taskId = detail.tasks[0].id;
    const p1 = await addMember(env, s.orgId, 'picker');
    const p2 = await addMember(env, s.orgId, 'picker');
    const [r1, r2] = await Promise.all([p1.client.post(`/api/pick-tasks/${taskId}/claim`), p2.client.post(`/api/pick-tasks/${taskId}/claim`)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('ALREADY_CLAIMED');
    // 敗者は scan もできない
    const loserClient = r1.status === 409 ? p1.client : p2.client;
    const task = expectStatus(await s.owner.client.get(`/api/pick-tasks/${taskId}`), 200).body;
    const g = task.groups[0];
    const scan = await loserClient.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: 'SKU-A', qty: 1 });
    expect(scan.status).toBe(409);
    expect(scan.body.error.code).toBe('NOT_ASSIGNED');
  });

  it('R08 + R09: resent pick scans are not double counted; wrong SKU / wrong location / over-pick are rejected and recorded', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    await receive(s.owner.client, locs['A-02']!, s.products['SKU-B']!, 10);
    const o = await allocatedOrder(s.owner.client, s.channelId, 'W8-1', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const { wave } = await makeWave(s.owner.client, s.warehouseId);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    const picker = await addMember(env, s.orgId, 'picker');
    const view = expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/claim`), 200).body;
    const gA = view.groups.find((g: any) => g.sku === 'SKU-A');
    const gB = view.groups.find((g: any) => g.sku === 'SKU-B');
    // Picker 画面に個人情報は含まれない
    expect(JSON.stringify(view)).not.toContain('顧客 太郎');
    expect(JSON.stringify(view)).not.toContain('150-0001');
    // 誤ロケーション
    const wl = await picker.client.post(`/api/pick-tasks/${taskId}/scan-location`, { clientEventId: randomUUID(), code: 'A-02', expectedLocationId: gA.locationId });
    expect(wl.status).toBe(422);
    expect(wl.body.code).toBe('WRONG_LOCATION');
    expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/scan-location`, { clientEventId: randomUUID(), code: 'A-01', expectedLocationId: gA.locationId }), 200);
    // R09: 誤 SKU（A-01 で SKU-B を読んだ）→ 拒否、数量は増えない
    const wrong = await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: gA.locationId, code: 'JAN-SKU-B', qty: 1, inputMethod: 'camera' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('WRONG_SKU');
    const unknown = await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: gA.locationId, code: '4999999999999', qty: 1 });
    expect(unknown.body.code).toBe('UNKNOWN_CODE');
    // R08: 同じ clientEventId の再送は 1 回分だけ
    const ev = randomUUID();
    const first = expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: ev, locationId: gA.locationId, code: 'JAN-SKU-A', qty: 1, inputMethod: 'scanner' }), 200).body;
    expect(first.group).toMatchObject({ required: 2, picked: 1, remaining: 1 });
    const resend = await Promise.all([1, 2, 3].map(() => picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: ev, locationId: gA.locationId, code: 'JAN-SKU-A', qty: 1 })));
    expect(resend.every((r) => r.status === 200 && r.body.duplicate === true)).toBe(true);
    let t = expectStatus(await picker.client.get(`/api/pick-tasks/${taskId}`), 200).body;
    expect(t.groups.find((g: any) => g.sku === 'SKU-A').picked).toBe(1);
    // 数量過多
    const over = await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: gA.locationId, code: 'SKU-A', qty: 5, inputMethod: 'manual' });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('OVER_PICK');
    expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: gA.locationId, code: 'SKU-A', qty: 1, inputMethod: 'manual' }), 200);
    const last = expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: gB.locationId, code: 'JAN-SKU-B', qty: 1 }), 200).body;
    expect(last.taskCompleted).toBe(true);
    t = expectStatus(await s.owner.client.get(`/api/pick-tasks/${taskId}`), 200).body;
    expect(t.status).toBe('completed');
    const od = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(od.status).toBe('picked');
    expect(od.fulfillments[0].status).toBe('picked');
    const w = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body;
    expect(w.status).toBe('picked');
    // 誤 scan は記録されている（KPI 用）
    const mis = await env.tx(s.orgId, (tx) => tx.one(`SELECT count(*)::int AS n FROM pick_events WHERE organization_id = $1 AND event_type IN ('mis_scan_sku', 'mis_scan_location', 'over_pick')`, [s.orgId]));
    expect(mis.n).toBe(4);
    await expectIntegrity(env, s.orgId);
  });

  it('pick correction adds a negative event (history kept) and reopens the line', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    await allocatedOrder(s.owner.client, s.channelId, 'CR-1', [{ sku: 'SKU-A', quantity: 2 }]);
    const { wave } = await makeWave(s.owner.client, s.warehouseId);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    const picker = await addMember(env, s.orgId, 'picker');
    const v = expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/claim`), 200).body;
    const g = v.groups[0];
    expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: 'SKU-A', qty: 2, inputMethod: 'manual' }), 200);
    const t1 = expectStatus(await picker.client.get(`/api/pick-tasks/${taskId}`), 200).body;
    const pickEv = t1.recentEvents.find((e: any) => e.type === 'pick');
    expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/correct`, { clientEventId: randomUUID(), pickEventId: pickEv.id, qty: 1 }), 200);
    const t2 = expectStatus(await picker.client.get(`/api/pick-tasks/${taskId}`), 200).body;
    expect(t2.groups[0]).toMatchObject({ picked: 1, remaining: 1, status: 'open' });
    expect(t2.status).toBe('in_progress');
    const events = await env.tx(s.orgId, (tx) => tx.many(`SELECT event_type, qty FROM pick_events WHERE organization_id = $1 AND event_type IN ('pick', 'correction') ORDER BY created_at`, [s.orgId]));
    expect(events).toEqual([
      { event_type: 'pick', qty: 2 },
      { event_type: 'correction', qty: -1 },
    ]);
    // 訂正しすぎは不可
    expect((await picker.client.post(`/api/pick-tasks/${taskId}/correct`, { clientEventId: randomUUID(), pickEventId: pickEv.id, qty: 2 })).status).toBe(409);
    await expectIntegrity(env, s.orgId);
  });

  it('Short Pick → held (not deducted), exceptions, order not cancelled → Manager reallocates to another warehouse → new fulfillment', async () => {
    const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'] });
    const tky = await locationsOf(s.owner.client, s.warehouses.TKY!);
    const osk = await locationsOf(s.owner.client, s.warehouses.OSK!);
    await receive(s.owner.client, tky['A-01']!, s.products['SKU-A']!, 3);
    await receive(s.owner.client, tky['A-02']!, s.products['SKU-B']!, 3);
    await receive(s.owner.client, osk['A-01']!, s.products['SKU-A']!, 5);
    const o = await allocatedOrder(s.owner.client, s.channelId, 'SP-1', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const { wave } = await makeWave(s.owner.client, s.warehouses.TKY!);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    const picker = await addMember(env, s.orgId, 'picker', { warehouseIds: [s.warehouses.TKY!] });
    const v = expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/claim`), 200).body;
    const gA = v.groups.find((g: any) => g.sku === 'SKU-A');
    const gB = v.groups.find((g: any) => g.sku === 'SKU-B');
    expectStatus(await picker.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: gB.locationId, code: 'SKU-B', qty: 1 }), 200);
    // 棚に SKU-A がない
    const sp = expectStatus(
      await picker.client.post(`/api/pick-tasks/${taskId}/short`, { clientEventId: randomUUID(), locationId: gA.locationId, productId: gA.productId, reasonCode: 'not_found' }),
      200,
    ).body;
    expect(sp).toMatchObject({ ok: true, shortQty: 2, taskCompleted: true });
    // 在庫: on_hand は減らさず held へ（Available から除外）
    const aT = await availability(s.owner.client, s.products['SKU-A']!, s.warehouses.TKY);
    expect(aT).toMatchObject({ onHand: 3, allocated: 0, held: 2, available: 1 });
    let od = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(od.status).toBe('partially_allocated');
    expect(od.cancelledAt).toBeNull();
    expect(od.exceptions.map((e: any) => e.type).sort()).toEqual(['short_pick']);
    const ffT = od.fulfillments[0];
    expect(ffT.hasShort).toBe(true);
    // 在庫側の例外
    const invEx = await env.tx(s.orgId, (tx) => tx.many(`SELECT type, status FROM exception_cases WHERE organization_id = $1 AND type = 'inventory_mismatch'`, [s.orgId]));
    expect(invEx).toEqual([{ type: 'inventory_mismatch', status: 'open' }]);
    // Manager: 大阪へ再割当
    const rs = expectStatus(await s.owner.client.post(`/api/fulfillments/${ffT.id}/resolve-short`, { action: 'reallocate', warehouseId: s.warehouses.OSK }), 200).body;
    expect(rs).toMatchObject({ shortUnits: 2, reallocated: 2, fulfillmentStatus: 'picked' });
    od = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(od.fulfillments.map((f: any) => [f.warehouseCode, f.status]).sort()).toEqual([
      ['OSK', 'ready'],
      ['TKY', 'picked'],
    ]);
    expect(od.exceptions.find((e: any) => e.type === 'short_pick').status).toBe('resolved');
    expect(od.status).toBe('allocated');
    // 大阪で Wave → Pick
    const { wave: w2 } = await makeWave(s.owner.client, s.warehouses.OSK!);
    const t2 = expectStatus(await s.owner.client.get(`/api/waves/${w2.waveId}`), 200).body.tasks[0].id;
    const v2 = expectStatus(await s.owner.client.post(`/api/pick-tasks/${t2}/claim`), 200).body;
    expectStatus(await s.owner.client.post(`/api/pick-tasks/${t2}/pick`, { clientEventId: randomUUID(), locationId: v2.groups[0].locationId, code: 'SKU-A', qty: 2 }), 200);
    od = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(od.status).toBe('picked');
    // 在庫側: 紛失確定
    const bal = aT.balances.find((b: any) => b.held > 0);
    expectStatus(await s.owner.client.post('/api/inventory/held/resolve', { balanceId: bal.id, qty: 2, resolution: 'loss' }), 200);
    expect(await availability(s.owner.client, s.products['SKU-A']!, s.warehouses.TKY)).toMatchObject({ onHand: 1, held: 0, available: 1 });
    await expectIntegrity(env, s.orgId);
  });

  it('claim timeout: expired claims are released (progress kept) and another picker can continue', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    await allocatedOrder(s.owner.client, s.channelId, 'TO-1', [{ sku: 'SKU-A', quantity: 3 }]);
    const { wave } = await makeWave(s.owner.client, s.warehouseId);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    const p1 = await addMember(env, s.orgId, 'picker');
    const p2 = await addMember(env, s.orgId, 'picker');
    const v = expectStatus(await p1.client.post(`/api/pick-tasks/${taskId}/claim`), 200).body;
    expectStatus(await p1.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: v.groups[0].locationId, code: 'SKU-A', qty: 1 }), 200);
    expect((await p2.client.post(`/api/pick-tasks/${taskId}/claim`)).status).toBe(409);
    // 時間経過をシミュレート
    await env.tx(s.orgId, (tx) => tx.exec(`UPDATE pick_tasks SET claim_expires_at = now() - interval '1 minute' WHERE organization_id = $1 AND id = $2`, [s.orgId, taskId]));
    expect(await expirePickClaims(env.deps)).toBeGreaterThanOrEqual(1);
    const v2 = expectStatus(await p2.client.post(`/api/pick-tasks/${taskId}/claim`), 200).body;
    expect(v2.groups[0].picked).toBe(1);
    // 元の担当者の再送（オフライン同期）は再検証で拒否される
    const stale = await p1.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: v.groups[0].locationId, code: 'SKU-A', qty: 1, offline: true });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('NOT_ASSIGNED');
    const audit = await env.tx(s.orgId, (tx) => tx.many(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action = 'pick_task.claim_timeout'`, [s.orgId]));
    expect(audit).toHaveLength(1);
  });

  it('wave pick list aggregates by location/SKU in location order; wave cancel requires confirm when picked', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-03']!, s.products['SKU-A']!, 10);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-B']!, 10);
    await allocatedOrder(s.owner.client, s.channelId, 'PL-1', [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 1 }]);
    await allocatedOrder(s.owner.client, s.channelId, 'PL-2', [{ sku: 'SKU-A', quantity: 2 }]);
    const { wave } = await makeWave(s.owner.client, s.warehouseId);
    const pl = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}/pick-list`), 200).body;
    expect(pl.lines.map((l: any) => [l.locationCode, l.sku, l.qty])).toEqual([
      ['A-01', 'SKU-B', 1],
      ['A-03', 'SKU-A', 3],
    ]);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    const v = expectStatus(await s.owner.client.post(`/api/pick-tasks/${taskId}/claim`), 200).body;
    expectStatus(await s.owner.client.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: v.groups[0].locationId, code: 'SKU-B', qty: 1 }), 200);
    const c1 = await s.owner.client.post(`/api/waves/${wave.waveId}/cancel`, { reason: 'やり直し' });
    expect(c1.status).toBe(409);
    expect(c1.body.error.code).toBe('CONFIRM_REQUIRED');
    expectStatus(await s.owner.client.post(`/api/waves/${wave.waveId}/cancel`, { reason: 'やり直し', confirm: true }), 200);
    const pv = expectStatus(await s.owner.client.post('/api/waves/preview', { warehouseId: s.warehouseId }), 200).body;
    expect(pv.fulfillments).toHaveLength(2); // Wave 待ちに戻る
    await expectIntegrity(env, s.orgId);
  });

  it('warehouse scope: a Tokyo picker cannot see or claim Osaka tasks', async () => {
    const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'] });
    const osk = await locationsOf(s.owner.client, s.warehouses.OSK!);
    await receive(s.owner.client, osk['A-01']!, s.products['SKU-A']!, 5);
    await allocatedOrder(s.owner.client, s.channelId, 'SC-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const { wave } = await makeWave(s.owner.client, s.warehouses.OSK!);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    const tkyPicker = await addMember(env, s.orgId, 'picker', { warehouseIds: [s.warehouses.TKY!] });
    const list = expectStatus(await tkyPicker.client.get('/api/pick-tasks?scope=available'), 200).body;
    expect(list.items).toHaveLength(0);
    expect((await tkyPicker.client.post(`/api/pick-tasks/${taskId}/claim`)).status).toBe(403);
    expect((await tkyPicker.client.get(`/api/pick-tasks/${taskId}`)).status).toBe(403);
    expect((await tkyPicker.client.get(`/api/waves/${wave.waveId}`)).status).toBe(403);
  });
  it('assignable users: only members with the permission (and warehouse scope) are listed, without emails; field report and lookup respect RBAC', async () => {
    const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'] });
    const tkyPicker = await addMember(env, s.orgId, 'picker', { warehouseIds: [s.warehouses.TKY!] });
    const anyPicker = await addMember(env, s.orgId, 'picker');
    const packer = await addMember(env, s.orgId, 'packer');
    const list = expectStatus(await s.owner.client.get(`/api/users/assignable?perm=pick.execute&warehouseId=${s.warehouses.OSK}`), 200).body.items;
    const ids = list.map((u: any) => u.userId);
    expect(ids).toContain(anyPicker.userId);
    expect(ids).not.toContain(tkyPicker.userId); // 大阪の担当範囲外
    expect(ids).not.toContain(packer.userId); // pick.execute を持たない
    expect(JSON.stringify(list)).not.toContain('@example.test');
    expect((await tkyPicker.client.get('/api/users/assignable?perm=pick.execute')).status).toBe(403);
    // 割当 API も担当範囲外の Picker を拒否
    const osk = await locationsOf(s.owner.client, s.warehouses.OSK!);
    await receive(s.owner.client, osk['A-01']!, s.products['SKU-A']!, 5);
    await allocatedOrder(s.owner.client, s.channelId, 'AS-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const { wave } = await makeWave(s.owner.client, s.warehouses.OSK!);
    const taskId = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0].id;
    expect((await s.owner.client.post(`/api/pick-tasks/${taskId}/assign`, { userId: tkyPicker.userId })).status).toBe(403);
    expectStatus(await s.owner.client.post(`/api/pick-tasks/${taskId}/assign`, { userId: anyPicker.userId }), 200);
    expect(expectStatus(await anyPicker.client.get('/api/pick-tasks?scope=mine'), 200).body.items.map((t: any) => t.id)).toContain(taskId);

    // 現場報告: 同じ requestId の二重送信は 1 件、他倉庫への報告は拒否
    const requestId = randomUUID();
    const r1 = expectStatus(await tkyPicker.client.post('/api/exceptions/report', { category: 'damaged', note: '外箱破損', code: 'JAN-SKU-A', requestId }), 200).body;
    const r2 = expectStatus(await tkyPicker.client.post('/api/exceptions/report', { category: 'damaged', note: '外箱破損', code: 'JAN-SKU-A', requestId }), 200).body;
    expect(r1.created).toBe(true);
    expect(r2).toEqual({ id: r1.id, created: false });
    expect((await tkyPicker.client.post('/api/exceptions/report', { category: 'other', warehouseId: s.warehouses.OSK, requestId: randomUUID() })).status).toBe(403);
    expect((await tkyPicker.client.post('/api/exceptions/report', { category: 'other', pickTaskId: taskId, requestId: randomUUID() })).status).toBe(403);
    const row = await env.tx(s.orgId, (tx) => tx.one(`SELECT type, product_id, created_by FROM exception_cases WHERE organization_id = $1 AND id = $2`, [s.orgId, r1.id]));
    expect(row).toMatchObject({ type: 'field_report', product_id: s.products['SKU-A'], created_by: tkyPicker.userId });

    // 商品確認: Picker には置き場所のみ（在庫数は返さない）、Owner には在庫数
    const pk = expectStatus(await anyPicker.client.get('/api/products/lookup?code=JAN-SKU-A'), 200).body;
    expect(pk.locations[0].locationCode).toBe('A-01');
    expect(pk.locations[0].onHand).toBeUndefined();
    const ow = expectStatus(await s.owner.client.get('/api/products/lookup?code=JAN-SKU-A'), 200).body;
    expect(ow.locations[0].onHand).toBe(5);
    // 誤 scan の 422 は共通エラー形式も含む
    const wrong = await anyPicker.client.post(`/api/pick-tasks/${taskId}/scan-location`, { clientEventId: randomUUID(), code: 'NOPE', expectedLocationId: osk['A-01'] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('WRONG_LOCATION');
    expect(wrong.body.error.message).toBeTruthy();
  });
});
