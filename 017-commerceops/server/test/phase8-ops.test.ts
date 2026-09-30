import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestEnv } from './helpers/env.js';
import { addMember, createOrg } from './helpers/factory.js';
import { allocatedOrder, locationsOf, manualOrder, orderDetail, receive, setupBasicOrg, shipReadyOrder, waveAndPickAll } from './helpers/scenario.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function stocked(opts: { warehouses?: string[] } = {}) {
  const s = await setupBasicOrg(env, opts);
  const locs = await locationsOf(s.owner.client, s.warehouseId);
  await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 30);
  await receive(s.owner.client, locs['A-02']!, s.products['SKU-B']!, 30);
  return { ...s, locs };
}

async function ship(s: Awaited<ReturnType<typeof stocked>>, ext: string, lines: { sku: string; quantity: number }[]) {
  const r = await shipReadyOrder(s, ext, lines);
  for (const [i, sh] of r.shipments.entries()) {
    expectStatus(await s.owner.client.patch(`/api/shipments/${sh.id}`, { carrier: 'yamato', trackingNumber: `${ext.replace(/[^A-Z0-9]/gi, '')}${i}9999` }), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${sh.id}/confirm`, {}), 200);
  }
  return r;
}

describe('Phase8 exceptions queue / assignment / home / KPI / search / export', () => {
  it('exception queue lifecycle: assign, investigate, resolve (code required), ignore (reason required), reopen, comment; RBAC and warehouse scope', async () => {
    const s = await stocked({ warehouses: ['TKY', 'OSK'] });
    // 欠品（倉庫なし）と現場報告（TKY）
    const o = await allocatedOrder(s.owner.client, s.channelId, 'EXQ-1', [{ sku: 'SKU-C', quantity: 1 }], { expect: 'none' });
    const tkyPicker = await addMember(env, s.orgId, 'picker', { warehouseIds: [s.warehouses.TKY!] });
    expectStatus(await tkyPicker.client.post('/api/exceptions/report', { category: 'location_issue', warehouseId: s.warehouses.TKY, requestId: randomUUID() }), 200);
    const list = expectStatus(await s.owner.client.get('/api/exceptions?status=active'), 200).body;
    expect(list.counts.active).toBe(2);
    expect(list.activeByType).toMatchObject({ shortage: 1, field_report: 1 });
    const shortage = list.items.find((e: any) => e.type === 'shortage');
    expect(shortage.orderNumber).toBe(o.orderNumber);
    const manager = await addMember(env, s.orgId, 'ops_manager');
    const oskManager = await addMember(env, s.orgId, 'ops_manager', { warehouseIds: [s.warehouses.OSK!] });
    const support = await addMember(env, s.orgId, 'support');
    const packer = await addMember(env, s.orgId, 'packer');
    // 割当: 例外対応できない人（Picker）は不可
    expect((await s.owner.client.post(`/api/exceptions/${shortage.id}/assign`, { userId: tkyPicker.userId })).body.error.code).toBe('INVALID_ASSIGNEE');
    expectStatus(await s.owner.client.post(`/api/exceptions/${shortage.id}/assign`, { userId: manager.userId }), 200);
    expect(expectStatus(await manager.client.get('/api/exceptions?assignee=me'), 200).body.items.map((e: any) => e.id)).toEqual([shortage.id]);
    expectStatus(await manager.client.post(`/api/exceptions/${shortage.id}/status`, { status: 'investigating', note: '入荷予定を確認中' }), 200);
    expect((await manager.client.post(`/api/exceptions/${shortage.id}/status`, { status: 'resolved' })).body.error.code).toBe('RESOLUTION_REQUIRED');
    expect((await manager.client.post(`/api/exceptions/${shortage.id}/status`, { status: 'resolved', resolutionCode: 'other' })).body.error.code).toBe('NOTE_REQUIRED');
    expectStatus(await manager.client.post(`/api/exceptions/${shortage.id}/comment`, { note: '仕入先に確認済み' }), 200);
    expectStatus(await manager.client.post(`/api/exceptions/${shortage.id}/status`, { status: 'resolved', resolutionCode: 'customer_contacted', note: 'お客様了承済み' }), 200);
    const d = expectStatus(await manager.client.get(`/api/exceptions/${shortage.id}`), 200).body;
    expect(d).toMatchObject({ status: 'resolved', resolutionCode: 'customer_contacted' });
    expect(d.events.map((e: any) => e.type)).toEqual(['created', 'assigned', 'status', 'comment', 'status']);
    // 無視は理由必須
    const field = list.items.find((e: any) => e.type === 'field_report');
    expect((await manager.client.post(`/api/exceptions/${field.id}/status`, { status: 'ignored' })).body.error.code).toBe('REASON_REQUIRED');
    expectStatus(await manager.client.post(`/api/exceptions/${field.id}/status`, { status: 'ignored', ignoredReason: '確認したが問題なし' }), 200);
    expectStatus(await manager.client.post(`/api/exceptions/${field.id}/status`, { status: 'open' }), 200);
    // 解決済みの例外と同じ内容の例外が新たに開いている場合は再オープン不可
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200); // 在庫不足のまま → 新しい欠品例外
    const reopen = await manager.client.post(`/api/exceptions/${shortage.id}/status`, { status: 'open' });
    expect(reopen.body.error.code).toBe('ALREADY_OPEN');
    // RBAC: Support は閲覧のみ、Picker/Packer は閲覧不可
    expectStatus(await support.client.get('/api/exceptions'), 200);
    expect((await support.client.post(`/api/exceptions/${field.id}/status`, { status: 'investigating' })).status).toBe(403);
    expect((await tkyPicker.client.get('/api/exceptions')).status).toBe(403);
    expect((await packer.client.get(`/api/exceptions/${field.id}`)).status).toBe(403);
    // 倉庫スコープ: 大阪担当は東京の現場報告を見られない（倉庫なしの欠品は見える）
    const oskList = expectStatus(await oskManager.client.get('/api/exceptions'), 200).body.items;
    expect(oskList.some((e: any) => e.id === field.id)).toBe(false);
    expect(oskList.some((e: any) => e.type === 'shortage')).toBe(true);
    expect((await oskManager.client.get(`/api/exceptions/${field.id}`)).status).toBe(403);
    // 他組織
    const other = await createOrg(env);
    expect((await other.owner.client.get(`/api/exceptions/${field.id}`)).status).toBe(404);
    expect((await other.owner.client.post(`/api/exceptions/${field.id}/status`, { status: 'ignored', ignoredReason: 'xx' })).status).toBe(404);
    // CSV 出力（export.csv が必要）
    const csv = await s.owner.client.get('/api/exceptions/export?status=active');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(field.number);
    expect((await support.client.get('/api/exceptions/export')).status).toBe(403);
  });

  it('address problems raise address_invalid and fixing the address auto-resolves it', async () => {
    const s = await stocked();
    const o = expectStatus(
      await s.owner.client.post('/api/orders', {
        channelId: s.channelId,
        order: { externalOrderId: 'ADDR-1', customer: { name: '住所 不備' }, shipTo: { name: '住所 不備', address1: '東京都渋谷区1-1' }, lines: [{ sku: 'SKU-A', quantity: 1 }] },
      }),
      200,
    ).body;
    expect(o.status).toBe('validation_required');
    let exc = await env.tx(s.orgId, (tx) => tx.many(`SELECT status, type FROM exception_cases WHERE organization_id = $1 AND order_id = $2`, [s.orgId, o.id]));
    expect(exc).toEqual([{ status: 'open', type: 'address_invalid' }]);
    expectStatus(await s.owner.client.put(`/api/orders/${o.id}/address`, { name: '住所 不備', postalCode: '150-0001', address1: '東京都渋谷区神宮前1-1', reason: 'お客様に確認' }), 200);
    exc = await env.tx(s.orgId, (tx) => tx.many(`SELECT status, resolution_code FROM exception_cases WHERE organization_id = $1 AND order_id = $2`, [s.orgId, o.id]));
    expect(exc).toEqual([{ status: 'resolved', resolution_code: 'auto' }]);
    expect((await orderDetail(s.owner.client, o.id)).status).toBe('ready_for_allocation');
  });

  it('home counts respect permissions and warehouse scope', async () => {
    const s = await stocked();
    await manualOrder(s.owner.client, s.channelId, 'HOME-1', [{ sku: 'SKU-A', quantity: 1 }]); // 引当待ち
    await allocatedOrder(s.owner.client, s.channelId, 'HOME-2', [{ sku: 'SKU-A', quantity: 1 }]); // Wave 待ち
    await shipReadyOrder(s, 'HOME-3', [{ sku: 'SKU-B', quantity: 1 }]); // 出荷待ち
    const home = expectStatus(await s.owner.client.get('/api/dashboard/home'), 200).body.counts;
    expect(home).toMatchObject({ todayOrders: 3, readyForAllocation: 1, waveWaiting: 1, awaitingShipment: 1, exceptionsOpen: 0 });
    const picker = await addMember(env, s.orgId, 'picker');
    const pc = expectStatus(await picker.client.get('/api/dashboard/home'), 200).body.counts;
    expect(pc.todayOrders).toBeUndefined();
    expect(pc.awaitingShipment).toBeUndefined();
    expect(pc).toHaveProperty('availablePickTasks');
    const support = await addMember(env, s.orgId, 'support');
    const sc = expectStatus(await support.client.get('/api/dashboard/home'), 200).body.counts;
    expect(sc.todayOrders).toBe(3);
    expect(sc.picking).toBeUndefined();
  });

  it('KPI: explicit numerators/denominators; replacement orders excluded; period validation; permissions', async () => {
    const s = await stocked();
    await ship(s, 'KPI-1', [{ sku: 'SKU-A', quantity: 1 }]);
    await ship(s, 'KPI-2', [{ sku: 'SKU-B', quantity: 2 }]);
    await manualOrder(s.owner.client, s.channelId, 'KPI-3', [{ sku: 'SKU-A', quantity: 1 }]); // 未出荷
    // 誤 scan を 1 回（Pick）
    const o4 = await allocatedOrder(s.owner.client, s.channelId, 'KPI-4', [{ sku: 'SKU-A', quantity: 1 }]);
    const wave = expectStatus(await s.owner.client.post('/api/waves', { warehouseId: s.warehouseId, fulfillmentIds: (await orderDetail(s.owner.client, o4.id)).fulfillments.map((f: any) => f.id) }), 200).body;
    const task = expectStatus(await s.owner.client.get(`/api/waves/${wave.waveId}`), 200).body.tasks[0];
    const tv = expectStatus(await s.owner.client.post(`/api/pick-tasks/${task.id}/claim`), 200).body;
    await s.owner.client.post(`/api/pick-tasks/${task.id}/pick`, { clientEventId: randomUUID(), locationId: tv.groups[0].locationId, code: 'JAN-SKU-B' });
    expectStatus(await s.owner.client.post(`/api/pick-tasks/${task.id}/pick`, { clientEventId: randomUUID(), locationId: tv.groups[0].locationId, code: 'JAN-SKU-A' }), 200);
    const k = expectStatus(await s.owner.client.get('/api/kpi'), 200).body;
    const m = (key: string) => k.metrics.find((x: any) => x.key === key);
    expect(m('ordersReceived').value).toBe(4);
    expect(m('shipments').value).toBe(2);
    expect(m('ordersShipped').value).toBe(2);
    expect(m('unitsShipped').value).toBe(3);
    expect(m('sameDayShipRate')).toMatchObject({ numerator: 2, denominator: 4, value: 50 });
    expect(m('pickMisScanRate').numerator).toBe(1);
    expect(m('pickMisScanRate').denominator).toBeGreaterThanOrEqual(2);
    expect(m('splitShipmentRate')).toMatchObject({ numerator: 0, denominator: 2 });
    expect(m('sameDayShipRate').definition).toContain('分母');
    expect(k.daily.length).toBe(7);
    // 分割出荷 1 件 → 分割発送率に反映
    const sp = await allocatedOrder(s.owner.client, s.channelId, 'KPI-5', [
      { sku: 'SKU-A', quantity: 1 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const ff = (await orderDetail(s.owner.client, sp.id)).fulfillments[0].id;
    await waveAndPickAll(s.owner.client, s.warehouseId, [ff]);
    const sid = expectStatus(await s.owner.client.post('/api/pack/open', { fulfillmentId: ff }), 200).body.sessionId;
    expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code: 'JAN-SKU-A' }), 200);
    expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/next-box`, { clientEventId: randomUUID() }), 200);
    expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code: 'JAN-SKU-B' }), 200);
    const boxes = expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() }), 200).body.shipments;
    for (const [i, b] of boxes.entries()) {
      expectStatus(await s.owner.client.patch(`/api/shipments/${b.id}`, { carrier: 'sagawa', trackingNumber: `SPLIT000${i}` }), 200);
      expectStatus(await s.owner.client.post(`/api/shipments/${b.id}/confirm`, {}), 200);
    }
    const k2 = expectStatus(await s.owner.client.get('/api/kpi'), 200).body;
    expect(k2.metrics.find((x: any) => x.key === 'splitShipmentRate')).toMatchObject({ numerator: 1, denominator: 3 });
    // 交換品の注文は受注件数に含めない
    const before = k2.metrics.find((x: any) => x.key === 'ordersReceived').value;
    await env.tx(s.orgId, (tx) => tx.exec(`UPDATE orders SET order_type = 'replacement' WHERE organization_id = $1 AND id = $2`, [s.orgId, sp.id]));
    const k3 = expectStatus(await s.owner.client.get('/api/kpi'), 200).body;
    expect(k3.metrics.find((x: any) => x.key === 'ordersReceived').value).toBe(before - 1);
    // 期間の検証・権限
    expect((await s.owner.client.get('/api/kpi?from=2026-09-30&to=2026-09-01')).body.error.code).toBe('INVALID_PERIOD');
    const support = await addMember(env, s.orgId, 'support');
    expect((await support.client.get('/api/kpi')).status).toBe(403);
    const exp = await s.owner.client.get('/api/kpi/export');
    expect(exp.status).toBe(200);
    expect(exp.text).toContain('当日出荷率');
  });

  it('search: permission-aware (PII fields only with permission), warehouse-scoped, tenant-isolated', async () => {
    const s = await stocked({ warehouses: ['TKY', 'OSK'] });
    const r = await ship(s, 'SRCH-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const on = r.order.orderNumber;
    let res = expectStatus(await s.owner.client.get(`/api/search?q=${on}`), 200).body.results;
    expect(res.orders.map((o: any) => o.orderNumber)).toEqual([on]);
    res = expectStatus(await s.owner.client.get(`/api/search?q=${encodeURIComponent('SRCH-1')}`), 200).body.results;
    expect(res.orders[0].matched).toBe('注文番号');
    res = expectStatus(await s.owner.client.get(`/api/search?q=${encodeURIComponent('顧客')}`), 200).body.results;
    expect(res.orders.map((o: any) => o.orderNumber)).toContain(on);
    res = expectStatus(await s.owner.client.get(`/api/search?q=150-0001`), 200).body.results;
    expect(res.orders.map((o: any) => o.orderNumber)).toContain(on);
    res = expectStatus(await s.owner.client.get(`/api/search?q=SRCH109999`), 200).body.results;
    expect(res.shipments.length).toBe(1);
    expect(res.orders[0].matched).toBe('追跡番号');
    res = expectStatus(await s.owner.client.get(`/api/search?q=SKU-A`), 200).body.results;
    expect(res.products.map((p: any) => p.sku)).toContain('SKU-A');
    // Picker: 注文・荷物は検索対象外（商品のみ）
    const picker = await addMember(env, s.orgId, 'picker');
    const pr = expectStatus(await picker.client.get(`/api/search?q=${on}`), 200).body.results;
    expect(pr.orders).toBeUndefined();
    expect(pr.shipments).toBeUndefined();
    const pn = expectStatus(await picker.client.get(`/api/search?q=${encodeURIComponent('顧客')}`), 200).body;
    expect(pn.total).toBe(0);
    // 大阪担当の管理者は東京の荷物を検索できない
    const osk = await addMember(env, s.orgId, 'ops_manager', { warehouseIds: [s.warehouses.OSK!] });
    expect(expectStatus(await osk.client.get(`/api/search?q=SRCH109999`), 200).body.results.shipments).toHaveLength(0);
    // 他組織
    const other = await createOrg(env);
    expect(expectStatus(await other.owner.client.get(`/api/search?q=${on}`), 200).body.total).toBe(0);
  });

  it('assignments: overview, wave bulk assign, manager unassign; invalid assignee rejected', async () => {
    const s = await stocked({ warehouses: ['TKY', 'OSK'] });
    await allocatedOrder(s.owner.client, s.channelId, 'ASG-1', [{ sku: 'SKU-A', quantity: 1 }]);
    await allocatedOrder(s.owner.client, s.channelId, 'ASG-2', [{ sku: 'SKU-B', quantity: 1 }]);
    const pv = expectStatus(await s.owner.client.post('/api/waves/preview', { warehouseId: s.warehouseId }), 200).body;
    const w = expectStatus(await s.owner.client.post('/api/waves', { warehouseId: s.warehouseId, fulfillmentIds: pv.fulfillments.map((f: any) => f.id), splitMode: 'lines', linesPerTask: 1 }), 200).body;
    const picker = await addMember(env, s.orgId, 'picker');
    const oskPicker = await addMember(env, s.orgId, 'picker', { warehouseIds: [s.warehouses.OSK!] });
    expect((await s.owner.client.post(`/api/waves/${w.waveId}/assign`, { userId: oskPicker.userId })).status).toBe(403);
    const a = expectStatus(await s.owner.client.post(`/api/waves/${w.waveId}/assign`, { userId: picker.userId }), 200).body;
    expect(a.assigned).toBe(2);
    let ov = expectStatus(await s.owner.client.get('/api/assignments'), 200).body;
    expect(ov.pickTasks.filter((t: any) => t.assigneeUserId === picker.userId)).toHaveLength(2);
    expect(ov.workload.find((x: any) => x.userId === picker.userId).pickTasks).toBe(2);
    expectStatus(await s.owner.client.post(`/api/pick-tasks/${ov.pickTasks[0].id}/unassign`, {}), 200);
    ov = expectStatus(await s.owner.client.get('/api/assignments'), 200).body;
    expect(ov.pickTasks.filter((t: any) => t.assigneeUserId === null)).toHaveLength(1);
    expect((await picker.client.get('/api/assignments')).status).toBe(403);
    expect((await picker.client.post(`/api/pick-tasks/${ov.pickTasks[0].id}/unassign`, {})).status).toBe(403);
  });

  it('CSV export: orders with permission-bounded PII levels (formula-safe, audited); returns & inventory exports', async () => {
    const s = await stocked();
    const o = await manualOrder(s.owner.client, s.channelId, 'EXP-1', [{ sku: 'SKU-A', quantity: 1 }]);
    expectStatus(await s.owner.client.put(`/api/orders/${o.id}/address`, { name: '@SUM(A1)', postalCode: '1500001', address1: '東京都渋谷区神宮前1-1', phone: '090-1111-0000', reason: 'テスト' }), 200);
    const none = await s.owner.client.get('/api/orders/export');
    expect(none.status).toBe(200);
    expect(none.text).toContain(o.orderNumber);
    expect(none.text).not.toContain('SUM(A1)');
    const shipTo = await s.owner.client.get('/api/orders/export?pii=ship_to');
    expect(shipTo.text).toContain("'@SUM(A1)");
    expect(shipTo.text).not.toContain('090-1111-0000');
    const full = await s.owner.client.get('/api/orders/export?pii=full');
    expect(full.text).toContain('090-1111-0000');
    const support = await addMember(env, s.orgId, 'support');
    expect((await support.client.get('/api/orders/export')).status).toBe(403); // export.csv なし
    const packer = await addMember(env, s.orgId, 'packer');
    expect((await packer.client.get('/api/inventory/export')).status).toBe(403);
    const inv = await s.owner.client.get('/api/inventory/export');
    expect(inv.text).toContain('SKU-A');
    expectStatus(await s.owner.client.get('/api/returns/export'), 200);
    const audits = await env.tx(s.orgId, (tx) => tx.many(`SELECT action, metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'export.%' ORDER BY created_at`, [s.orgId]));
    expect(audits.map((a) => a.action)).toEqual(['export.orders', 'export.orders', 'export.orders', 'export.inventory', 'export.returns']);
    expect(audits.map((a) => a.metadata.pii).slice(0, 3)).toEqual(['none', 'ship_to', 'full']);
    expect(JSON.stringify(audits)).not.toContain('090-1111-0000');
  });
});
