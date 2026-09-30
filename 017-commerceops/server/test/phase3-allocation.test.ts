import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestEnv } from './helpers/env.js';
import { addMember } from './helpers/factory.js';
import { availability, importCsv, locationsOf, manualOrder, orderRow, receive, setupBasicOrg, stdCsv, uploadFile } from './helpers/scenario.js';
import { expectIntegrity } from './helpers/integrity.js';
import { startWorker } from '../src/jobs/worker.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('Phase3 allocation (required tests R01–R05)', () => {
  it('R01: OnHand 10 → allocate 3 → Allocated 3 / Available 7 (on_hand unchanged)', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    const o = await manualOrder(s.owner.client, s.channelId, 'R01', [{ sku: 'SKU-A', quantity: 3 }]);
    const r = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200).body;
    expect(r).toMatchObject({ outcome: 'full', allocatedUnits: 3, remainingUnits: 0 });
    const a = await availability(s.owner.client, s.products['SKU-A']!);
    expect(a).toMatchObject({ onHand: 10, allocated: 3, available: 7 });
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d.status).toBe('allocated');
    expect(d.fulfillments).toHaveLength(1); // 全量引当 → 自動で Fulfillment 化
    expect(d.fulfillments[0].status).toBe('ready');
    await expectIntegrity(env, s.orgId);
  });

  it('R02: two orders from two channels race for the last unit concurrently → exactly one succeeds, the other gets a shortage', async () => {
    const s = await setupBasicOrg(env);
    const ch2 = expectStatus(await s.owner.client.post('/api/channels', { name: 'Marketplace A', type: 'amazon', code: 'MPA' }), 200).body.id;
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 1);
    const o1 = await manualOrder(s.owner.client, s.channelId, 'LAST-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const o2 = await manualOrder(s.owner.client, ch2, 'LAST-2', [{ sku: 'SKU-A', quantity: 1 }]);
    const [r1, r2] = await Promise.all([
      s.owner.client.post(`/api/orders/${o1.id}/allocate`, {}),
      s.owner.client.post(`/api/orders/${o2.id}/allocate`, {}),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect([r1.body.outcome, r2.body.outcome].sort()).toEqual(['full', 'none']);
    const a = await availability(s.owner.client, s.products['SKU-A']!);
    expect(a).toMatchObject({ onHand: 1, allocated: 1, available: 0 });
    const statuses = await Promise.all([o1, o2].map(async (o) => (await s.owner.client.get(`/api/orders/${o.id}`)).body));
    const short = statuses.find((x) => x.status === 'ready_for_allocation')!;
    expect(short.exceptions.some((e: any) => e.type === 'shortage' && e.status === 'open')).toBe(true);
    await expectIntegrity(env, s.orgId);
  });

  it('R02b: 30 orders race for 10 units via the engine → exactly 10 allocated, never negative', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-B']!, 6);
    await receive(s.owner.client, locs['A-02']!, s.products['SKU-B']!, 4);
    const orders = [];
    for (let i = 0; i < 30; i++) orders.push(await manualOrder(s.owner.client, s.channelId, `RACE-${i}`, [{ sku: 'SKU-B', quantity: 1 }]));
    const results = await Promise.all(orders.map((o) => s.owner.client.post(`/api/orders/${o.id}/allocate`, {})));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === 'full')).toHaveLength(10);
    const a = await availability(s.owner.client, s.products['SKU-B']!);
    expect(a).toMatchObject({ onHand: 10, allocated: 10, available: 0 });
    await expectIntegrity(env, s.orgId);
  });

  it('R03: re-running the allocation job does not double-allocate (and concurrent runs are deduplicated)', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 100);
    for (let i = 0; i < 5; i++) await manualOrder(s.owner.client, s.channelId, `JOB-${i}`, [{ sku: 'SKU-A', quantity: 2 }]);
    const j1 = expectStatus(await s.owner.client.post('/api/allocation/run', {}), 200).body;
    const j2 = expectStatus(await s.owner.client.post('/api/allocation/run', {}), 200).body;
    expect(j2.deduped).toBe(true);
    expect(j2.jobId).toBe(j1.jobId);
    const worker = startWorker(env.deps, undefined, 1);
    await worker.stop();
    await worker.drain();
    const job = expectStatus(await s.owner.client.get(`/api/jobs/${j1.jobId}`), 200).body;
    expect(job.status).toBe('succeeded');
    expect(job.result.full).toBe(5);
    // 再実行（Job を再投入して再度処理）→ 追加の引当なし
    const j3 = expectStatus(await s.owner.client.post('/api/allocation/run', {}), 200).body;
    expect(j3.deduped).toBe(false);
    await worker.drain();
    const job3 = expectStatus(await s.owner.client.get(`/api/jobs/${j3.jobId}`), 200).body;
    expect(job3.result.allocatedUnits).toBe(0);
    // 同一注文の同時引当（API 2 本 + run-now）でも二重にならない
    const o = await manualOrder(s.owner.client, s.channelId, 'JOB-X', [{ sku: 'SKU-A', quantity: 3 }]);
    await Promise.all([
      s.owner.client.post(`/api/orders/${o.id}/allocate`, {}),
      s.owner.client.post(`/api/orders/${o.id}/allocate`, {}),
      s.owner.client.post('/api/allocation/run-now', { orderIds: [o.id] }),
    ]);
    const a = await availability(s.owner.client, s.products['SKU-A']!);
    expect(a.allocated).toBe(13);
    await expectIntegrity(env, s.orgId);
  });

  it('R04: quantity 3 with Available 2 → Partially Allocated; quantity is never reduced', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 2);
    const o = await manualOrder(s.owner.client, s.channelId, 'R04', [{ sku: 'SKU-A', quantity: 3 }]);
    const r = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200).body;
    expect(r).toMatchObject({ outcome: 'partial', allocatedUnits: 2, remainingUnits: 1 });
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d.status).toBe('partially_allocated');
    expect(d.items[0]).toMatchObject({ quantity: 3, allocatedQty: 2, cancelledQty: 0 });
    expect(d.fulfillments).toHaveLength(0); // 既定は「全商品待ち」
    expect(d.exceptions.find((e: any) => e.type === 'shortage').status).toBe('open');
    // 入荷 → 再引当で全量 → 欠品例外は自動解決、Fulfillment 作成
    await receive(s.owner.client, locs['A-02']!, s.products['SKU-A']!, 5);
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200);
    const d2 = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d2.status).toBe('allocated');
    expect(d2.exceptions.find((e: any) => e.type === 'shortage').status).toBe('resolved');
    expect(d2.fulfillments).toHaveLength(1);
    await expectIntegrity(env, s.orgId);
  });

  it('R05: cancelling an order releases its unshipped allocations', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 5);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-B']!, 5);
    const o = await manualOrder(s.owner.client, s.channelId, 'R05', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 3 },
    ]);
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200);
    expect((await availability(s.owner.client, s.products['SKU-A']!)).allocated).toBe(2);
    expect((await s.owner.client.post(`/api/orders/${o.id}/cancel`, {})).status).toBe(400); // 理由必須
    const c = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/cancel`, { reason: '顧客都合' }), 200).body;
    expect(c).toMatchObject({ status: 'cancelled', releasedUnits: 5 });
    expect(await availability(s.owner.client, s.products['SKU-A']!)).toMatchObject({ onHand: 5, allocated: 0, available: 5 });
    expect(await availability(s.owner.client, s.products['SKU-B']!)).toMatchObject({ onHand: 5, allocated: 0, available: 5 });
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d.fulfillments.every((f: any) => f.status === 'cancelled')).toBe(true);
    expect(d.statusHistory.at(-1).to).toBe('cancelled');
    // 再送は冪等
    expect(expectStatus(await s.owner.client.post(`/api/orders/${o.id}/cancel`, { reason: '再送' }), 200).body.alreadyCancelled).toBe(true);
    await expectIntegrity(env, s.orgId);
  });
});

describe('multi-warehouse rules, partial release, holds, shortages', () => {
  it('prefers a warehouse that can fulfill everything; otherwise partial at the best one with split candidates (never auto-split)', async () => {
    const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'] });
    const tky = await locationsOf(s.owner.client, s.warehouses.TKY!);
    const osk = await locationsOf(s.owner.client, s.warehouses.OSK!);
    // OSK だけが X と Y を両方持つ（TKY は優先度が高いが X しかない）
    await receive(s.owner.client, tky['A-01']!, s.products['SKU-A']!, 5);
    await receive(s.owner.client, osk['A-01']!, s.products['SKU-A']!, 5);
    await receive(s.owner.client, osk['A-02']!, s.products['SKU-B']!, 5);
    const full = await manualOrder(s.owner.client, s.channelId, 'MW-1', [
      { sku: 'SKU-A', quantity: 1 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const plan = expectStatus(await s.owner.client.get(`/api/orders/${full.id}/allocation-plan`), 200).body;
    expect(plan.recommendation).toContain('OSK');
    const r = expectStatus(await s.owner.client.post(`/api/orders/${full.id}/allocate`, {}), 200).body;
    expect(r.outcome).toBe('full');
    expect(r.warehouseId).toBe(s.warehouses.OSK);
    // 分割が必要: C は TKY のみ、B は OSK のみ
    await receive(s.owner.client, tky['A-03']!, s.products['SKU-C']!, 2);
    const split = await manualOrder(s.owner.client, s.channelId, 'MW-2', [
      { sku: 'SKU-C', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const r2 = expectStatus(await s.owner.client.post(`/api/orders/${split.id}/allocate`, {}), 200).body;
    expect(r2.outcome).toBe('partial');
    expect(r2.warehouseId).toBe(s.warehouses.TKY); // 最も多く揃う倉庫（2 個）
    expect(r2.splitCandidates).toEqual([{ warehouseCode: 'OSK', units: 1 }]);
    // 人間が「残りを大阪から」を確定 → 全量 → 倉庫ごとに 2 つの Fulfillment
    const r3 = expectStatus(await s.owner.client.post(`/api/orders/${split.id}/allocate`, { warehouseId: s.warehouses.OSK }), 200).body;
    expect(r3.outcome).toBe('full');
    const d = expectStatus(await s.owner.client.get(`/api/orders/${split.id}`), 200).body;
    expect(d.fulfillments.map((f: any) => f.warehouseCode).sort()).toEqual(['OSK', 'TKY']);
    await expectIntegrity(env, s.orgId);
  });

  it('partial release (ship available first) creates a fulfillment for allocated items only', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 2);
    const o = await manualOrder(s.owner.client, s.channelId, 'PR-1', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200);
    const rel = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/release`, {}), 200).body;
    expect(rel.fulfillmentIds).toHaveLength(1);
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d.status).toBe('partially_allocated');
    expect(d.fulfillments[0].items).toHaveLength(1);
    expect(d.fulfillments[0].items[0].requiredQty).toBe(2);
    // 解除すると ready の Fulfillment は空になり取消
    const released = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/deallocate`, { reason: 'テスト' }), 200).body.released;
    expect(released).toBe(2);
    const d2 = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d2.fulfillments[0].status).toBe('cancelled');
    expect(d2.status).toBe('ready_for_allocation');
    await expectIntegrity(env, s.orgId);
  });

  it('held orders are not allocated; allowPartialAllocation=false allocates nothing', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 1);
    const o = await manualOrder(s.owner.client, s.channelId, 'H-1', [{ sku: 'SKU-A', quantity: 1 }]);
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/holds`, { reasonCode: 'payment_check' }), 200);
    const r = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200).body;
    expect(r.outcome).toBe('skipped');
    const org = expectStatus(await s.owner.client.get('/api/org'), 200).body;
    expectStatus(await s.owner.client.patch('/api/org', { settings: { ...org.settings, allocation: { ...org.settings.allocation, allowPartialAllocation: false } } }), 200);
    const o2 = await manualOrder(s.owner.client, s.channelId, 'NP-1', [{ sku: 'SKU-A', quantity: 3 }]);
    const r2 = expectStatus(await s.owner.client.post(`/api/orders/${o2.id}/allocate`, {}), 200).body;
    expect(r2).toMatchObject({ outcome: 'none', allocatedUnits: 0 });
  });

  it('inventory: held stock is not available; adjustments cannot go below allocated; receipts are idempotent', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    const pid = s.products['SKU-A']!;
    const req = '0199a000-0000-7000-8000-000000000001';
    const r1 = expectStatus(await s.owner.client.post('/api/inventory/receipts', { locationId: locs['A-01'], productId: pid, qty: 5, requestId: req }), 200).body;
    const r2 = expectStatus(await s.owner.client.post('/api/inventory/receipts', { locationId: locs['A-01'], productId: pid, qty: 5, requestId: req }), 200).body;
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(false);
    expect((await availability(s.owner.client, pid)).onHand).toBe(5);
    const o = await manualOrder(s.owner.client, s.channelId, 'ADJ-1', [{ sku: 'SKU-A', quantity: 4 }]);
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200);
    const bad = await s.owner.client.post('/api/inventory/adjustments', { locationId: locs['A-01'], productId: pid, mode: 'set', qty: 3, reason: '棚卸' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INSUFFICIENT_STOCK');
    // 移動: 引当可能数量まで
    expect((await s.owner.client.post('/api/inventory/transfers', { fromLocationId: locs['A-01'], toLocationId: locs['A-02'], productId: pid, qty: 2 })).status).toBe(409);
    expectStatus(await s.owner.client.post('/api/inventory/transfers', { fromLocationId: locs['A-01'], toLocationId: locs['A-02'], productId: pid, qty: 1 }), 200);
    const mv = expectStatus(await s.owner.client.get(`/api/inventory/movements?productId=${pid}`), 200).body;
    expect(mv.items.map((m: any) => m.type).sort()).toEqual(['receipt', 'transfer_in', 'transfer_out']);
    await expectIntegrity(env, s.orgId);
  });

  it('R24: Customer Support cannot adjust inventory (API denies); picker cannot run allocation', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    const support = await addMember(env, s.orgId, 'support');
    const picker = await addMember(env, s.orgId, 'picker');
    const body = { locationId: locs['A-01'], productId: s.products['SKU-A'], mode: 'delta', qty: 10, reason: '不正' };
    const r = await support.client.post('/api/inventory/adjustments', body);
    expect(r.status).toBe(403);
    expect((await support.client.post('/api/inventory/receipts', { locationId: locs['A-01'], productId: s.products['SKU-A'], qty: 1 })).status).toBe(403);
    expect((await support.client.get(`/api/inventory/balances?productId=${s.products['SKU-A']}`)).status).toBe(200); // 参照は可
    expect((await picker.client.post('/api/allocation/run', {})).status).toBe(403);
    expect((await availability(s.owner.client, s.products['SKU-A']!)).onHand).toBe(0);
  });

  it('R20 (conflict): re-import with different content after allocation → conflict exception, order untouched', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('CF-1', 'SKU-A', 1)]));
    const o = (await s.owner.client.get('/api/orders?q=CF-1')).body.items[0];
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200);
    const pv = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, stdCsv([orderRow('CF-1', 'SKU-A', 4)]));
    expect(pv.body.summary.byClass.conflict).toBe(1);
    const cm = expectStatus(await s.owner.client.post(`/api/imports/${pv.body.batchId}/commit`, {}), 200).body;
    expect(cm.conflicts).toBe(1);
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d.items[0].quantity).toBe(1);
    expect(d.exceptions.some((e: any) => e.type === 'import_conflict')).toBe(true);
  });

  it('line cancellation of an unallocated remainder turns a partially allocated order into allocated', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 2);
    const o = await manualOrder(s.owner.client, s.channelId, 'LC-1', [{ sku: 'SKU-A', quantity: 3 }]);
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200);
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    const r = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/cancel-lines`, { lines: [{ itemId: d.items[0].id, qty: 1 }], reason: '顧客合意で1個取消' }), 200).body;
    expect(r.status).toBe('allocated');
    const d2 = expectStatus(await s.owner.client.get(`/api/orders/${o.id}`), 200).body;
    expect(d2.items[0]).toMatchObject({ quantity: 3, cancelledQty: 1, allocatedQty: 2 });
    await expectIntegrity(env, s.orgId);
  });
});
