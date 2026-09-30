import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestClient, type TestEnv } from './helpers/env.js';
import { addMember, createOrg } from './helpers/factory.js';
import { allocatedOrder, locationsOf, orderDetail, receive, setupBasicOrg, waveAndPickAll } from './helpers/scenario.js';
import { expectIntegrity } from './helpers/integrity.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const scan = (c: TestClient, sid: string, code: string, extra: Record<string, unknown> = {}) =>
  c.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code, inputMethod: 'scanner', ...extra });
const view = async (c: TestClient, sid: string) => expectStatus(await c.get(`/api/pack/sessions/${sid}`), 200).body;
const item = (v: any, sku: string) => v.items.find((i: any) => i.sku === sku);

/** 在庫を入れて注文を引当 → Wave → 全数ピック。梱包待ちの Fulfillment を返す */
async function readyToPack(s: Awaited<ReturnType<typeof setupBasicOrg>>, ext: string, lines: { sku: string; quantity: number }[]) {
  const o = await allocatedOrder(s.owner.client, s.channelId, ext, lines);
  const { fulfillmentIds } = await waveAndPickAll(s.owner.client, s.warehouseId);
  const d = await orderDetail(s.owner.client, o.id);
  const ff = d.fulfillments.find((f: any) => fulfillmentIds.includes(f.id));
  expect(ff.status).toBe('picked');
  return { order: o, fulfillmentId: ff.id as string, fulfillmentNumber: ff.fulfillmentNumber as string };
}

async function stocked(skus: Record<string, number> = { 'SKU-A': 50, 'SKU-B': 50, 'SKU-C': 50 }) {
  const s = await setupBasicOrg(env);
  const locs = await locationsOf(s.owner.client, s.warehouseId);
  const codes = ['A-01', 'A-02', 'A-03', 'A-04', 'A-05'];
  let i = 0;
  for (const [sku, qty] of Object.entries(skus)) await receive(s.owner.client, locs[codes[i++]!]!, s.products[sku]!, qty);
  return s;
}

describe('Phase5 Packing Station (R10, R11)', () => {
  it('R10: required 2 / scanned 1 cannot complete normally; full scan completes and creates a draft shipment (idempotent)', async () => {
    const s = await stocked();
    const { order, fulfillmentId } = await readyToPack(s, 'PK-1', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const packer = await addMember(env, s.orgId, 'packer');
    // 注文番号で開く
    const open = expectStatus(await packer.client.post('/api/pack/open', { code: order.orderNumber }), 200).body;
    expect(open.resumed).toBe(false);
    const sid = open.sessionId;
    expect((await orderDetail(s.owner.client, order.id)).status).toBe('packing');
    const a1 = expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200).body;
    expect(a1.item).toMatchObject({ sku: 'SKU-A', required: 2, packed: 1, remaining: 1 });
    expect(a1.allPacked).toBe(false);
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-B'), 200);
    // 必要 2 / scan 1 → 通常完了不可
    const incomplete = await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.error.code).toBe('PACK_INCOMPLETE');
    expect(incomplete.body.error.details.items).toEqual([{ sku: 'SKU-A', packed: 1, required: 2 }]);
    // Packer は強制完了できない
    const forceByPacker = await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID(), force: true, reason: '急ぎ' });
    expect(forceByPacker.status).toBe(403);
    const a2 = expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200).body;
    expect(a2.allPacked).toBe(true);
    const requestId = randomUUID();
    const done = expectStatus(await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId }), 200).body;
    expect(done.forced).toBe(false);
    expect(done.shipments).toHaveLength(1);
    expect(done.shipments[0].status).toBe('draft');
    expect(done.shipments[0].items.sort((x: any, y: any) => x.sku.localeCompare(y.sku))).toEqual([
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    // 完了の再送は同じ結果（荷物は増えない）、別 requestId は拒否
    const again = expectStatus(await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId }), 200).body;
    expect(again.duplicate).toBe(true);
    expect(again.shipments.map((x: any) => x.id)).toEqual(done.shipments.map((x: any) => x.id));
    expect((await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() })).status).toBe(409);
    const d = await orderDetail(s.owner.client, order.id);
    expect(d.status).toBe('packed');
    expect(d.fulfillments.find((f: any) => f.id === fulfillmentId).status).toBe('packed');
    expect(d.shipments).toHaveLength(1);
    // 梱包済みの Fulfillment は再度開けない
    const reopen = await packer.client.post('/api/pack/open', { fulfillmentId });
    expect(reopen.body.error.code).toBe('ALREADY_PACKED');
    await expectIntegrity(env, s.orgId);
  });

  it('R11: resending the same pack scan (concurrently) counts once; mis-scan resend counts once', async () => {
    const s = await stocked();
    const { fulfillmentId } = await readyToPack(s, 'PK-2', [{ sku: 'SKU-A', quantity: 3 }]);
    const packer = await addMember(env, s.orgId, 'packer');
    const sid = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    const ev = randomUUID();
    const rs = await Promise.all([1, 2, 3, 4].map(() => packer.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: ev, code: 'JAN-SKU-A' })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(item(await view(packer.client, sid), 'SKU-A').packed).toBe(1);
    const bad = randomUUID();
    const m1 = await packer.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: bad, code: 'JAN-SKU-C' });
    const m2 = await packer.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: bad, code: 'JAN-SKU-C' });
    expect([m1.status, m2.status]).toEqual([422, 422]);
    expect(m2.body.duplicate).toBe(true);
    expect((await view(packer.client, sid)).misScanCount).toBe(1);
    await expectIntegrity(env, s.orgId);
  });

  it('mis-scans are rejected without counting: other order in the same wave, other variant, wrong SKU, unknown code, over-pack', async () => {
    const s = await stocked();
    const c = s.owner.client;
    const red = expectStatus(await c.post('/api/products', { sku: 'TS-RED-M', name: 'Tシャツ', variant: '赤 M', groupCode: 'TS-RED', barcodes: [{ code: '4900000000017' }] }), 200).body.id;
    const redL = expectStatus(await c.post('/api/products', { sku: 'TS-RED-L', name: 'Tシャツ', variant: '赤 L', groupCode: 'TS-RED', barcodes: [{ code: '4900000000024' }] }), 200).body.id;
    const locs = await locationsOf(c, s.warehouseId);
    await receive(c, locs['A-04']!, red, 5);
    await receive(c, locs['A-05']!, redL, 5);
    const x = await allocatedOrder(c, s.channelId, 'MX-1', [
      { sku: 'SKU-A', quantity: 1 },
      { sku: 'TS-RED-M', quantity: 1 },
    ]);
    const y = await allocatedOrder(c, s.channelId, 'MX-2', [{ sku: 'SKU-B', quantity: 1 }]);
    await waveAndPickAll(c, s.warehouseId);
    const yNumber = (await orderDetail(c, y.id)).fulfillments[0].fulfillmentNumber;
    const packer = await addMember(env, s.orgId, 'packer');
    const sid = expectStatus(await packer.client.post('/api/pack/open', { code: x.orderNumber }), 200).body.sessionId;
    const other = await scan(packer.client, sid, 'JAN-SKU-B');
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('OTHER_ORDER');
    expect(other.body.error.message).toContain(yNumber);
    const variant = await scan(packer.client, sid, '4900000000024');
    expect(variant.body.code).toBe('WRONG_VARIANT');
    expect(variant.body.message).toContain('赤 L');
    expect((await scan(packer.client, sid, 'JAN-SKU-C')).body.code).toBe('WRONG_SKU');
    expect((await scan(packer.client, sid, 'NO-SUCH-CODE')).body.code).toBe('UNKNOWN_CODE');
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    const over = await scan(packer.client, sid, 'JAN-SKU-A');
    expect(over.body.code).toBe('OVER_PACK');
    const v = await view(packer.client, sid);
    expect(v.misScanCount).toBe(5);
    expect(item(v, 'SKU-A').packed).toBe(1);
    expect(item(v, 'TS-RED-M').packed).toBe(0);
    expect(v.events.filter((e: any) => e.misScan)).toHaveLength(5);
    // 正しい商品で完了できる
    expectStatus(await scan(packer.client, sid, '4900000000017'), 200);
    expectStatus(await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() }), 200);
    await expectIntegrity(env, s.orgId);
  });

  it('force complete: manager takes over, reason required, forced_pack exception + audit; packer loses the session', async () => {
    const s = await stocked();
    const { order, fulfillmentId } = await readyToPack(s, 'FC-1', [{ sku: 'SKU-A', quantity: 3 }]);
    const packer = await addMember(env, s.orgId, 'packer');
    const manager = await addMember(env, s.orgId, 'ops_manager');
    const sid = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    // 管理者でも他人の作業中セッションは takeover 指定なしでは開けない
    expect((await manager.client.post('/api/pack/open', { fulfillmentId })).body.error.code).toBe('PACK_IN_PROGRESS');
    // Packer は takeover を指定できない（管理者のみ）
    expect((await packer.client.post('/api/pack/open', { fulfillmentId, takeover: true })).status).toBe(403);
    const other = await addMember(env, s.orgId, 'packer');
    expect((await other.client.post('/api/pack/open', { fulfillmentId, takeover: true })).status).toBe(403);
    const t = expectStatus(await manager.client.post('/api/pack/open', { fulfillmentId, takeover: true }), 200).body;
    expect(t).toMatchObject({ sessionId: sid, takenOver: true });
    expect((await scan(packer.client, sid, 'JAN-SKU-A')).body.error.code).toBe('NOT_ASSIGNED');
    const noReason = await manager.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID(), force: true });
    expect(noReason.status).toBe(400);
    const done = expectStatus(
      await manager.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID(), force: true, reason: 'バーコード破損のため目視確認' }),
      200,
    ).body;
    expect(done.forced).toBe(true);
    expect(done.shipments[0].items).toEqual([{ sku: 'SKU-A', quantity: 3 }]);
    const exc = await env.tx(s.orgId, (tx) => tx.many(`SELECT type, severity, detail FROM exception_cases WHERE organization_id = $1 AND fulfillment_id = $2`, [s.orgId, fulfillmentId]));
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ type: 'forced_pack', severity: 'high' });
    expect(exc[0].detail.items).toEqual([{ sku: 'SKU-A', scanned: 1, required: 3 }]);
    const auditRows = await env.tx(s.orgId, (tx) => tx.many(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_id = $2`, [s.orgId, sid]));
    expect(auditRows.map((r) => r.action)).toEqual(expect.arrayContaining(['pack.start', 'pack.takeover', 'pack.force_complete']));
    expect((await orderDetail(s.owner.client, order.id)).status).toBe('packed');
    await expectIntegrity(env, s.orgId);
  });

  it('open preconditions: not picked, second packer, resume, expired takeover, hold blocks scanning', async () => {
    const s = await stocked();
    const o = await allocatedOrder(s.owner.client, s.channelId, 'OP-1', [{ sku: 'SKU-A', quantity: 2 }]);
    const pv = expectStatus(await s.owner.client.post('/api/waves/preview', { warehouseId: s.warehouseId }), 200).body;
    const fulfillmentId = pv.fulfillments[0].id;
    expectStatus(await s.owner.client.post('/api/waves', { warehouseId: s.warehouseId, fulfillmentIds: [fulfillmentId] }), 200);
    const p1 = await addMember(env, s.orgId, 'packer');
    const p2 = await addMember(env, s.orgId, 'packer');
    const notPicked = await p1.client.post('/api/pack/open', { fulfillmentId });
    expect(notPicked.status).toBe(409);
    expect(notPicked.body.error.code).toBe('PICK_INCOMPLETE');
    // ピック完了
    const wave = (await orderDetail(s.owner.client, o.id)).fulfillments[0].waveId;
    const task = expectStatus(await s.owner.client.get(`/api/waves/${wave}`), 200).body.tasks[0];
    const tv = expectStatus(await s.owner.client.post(`/api/pick-tasks/${task.id}/claim`), 200).body;
    expectStatus(await s.owner.client.post(`/api/pick-tasks/${task.id}/pick`, { clientEventId: randomUUID(), locationId: tv.groups[0].locationId, code: 'SKU-A', qty: 2 }), 200);
    const sid = expectStatus(await p1.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    const busy = await p2.client.post('/api/pack/open', { fulfillmentId });
    expect(busy.body.error.code).toBe('PACK_IN_PROGRESS');
    expect(expectStatus(await p1.client.post('/api/pack/open', { fulfillmentId }), 200).body).toMatchObject({ sessionId: sid, resumed: true });
    expectStatus(await scan(p1.client, sid, 'JAN-SKU-A'), 200);
    // 期限切れ → 別の Packer が引き継ぎ（進捗は保持）
    await env.tx(s.orgId, (tx) => tx.exec(`UPDATE pack_sessions SET claim_expires_at = now() - interval '1 minute' WHERE organization_id = $1 AND id = $2`, [s.orgId, sid]));
    expect(expectStatus(await p2.client.post('/api/pack/open', { fulfillmentId }), 200).body).toMatchObject({ sessionId: sid, takenOver: true });
    expect(item(await view(p2.client, sid), 'SKU-A').packed).toBe(1);
    expect((await scan(p1.client, sid, 'JAN-SKU-A')).body.error.code).toBe('NOT_ASSIGNED');
    // 保留中は scan / 完了できない
    const confirmNeeded = await s.owner.client.post(`/api/orders/${o.id}/holds`, { reasonCode: 'address_check' });
    expect(confirmNeeded.body.error.code).toBe('CONFIRM_REQUIRED');
    const hold = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/holds`, { reasonCode: 'address_check', confirm: true }), 200).body;
    const held = await scan(p2.client, sid, 'JAN-SKU-A');
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe('ON_HOLD');
    expectStatus(await s.owner.client.post(`/api/orders/${o.id}/holds/${hold.holdId}/release`, {}), 200);
    expectStatus(await scan(p2.client, sid, 'JAN-SKU-A'), 200);
    expectStatus(await p2.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() }), 200);
    await expectIntegrity(env, s.orgId);
  });

  it('multi-box, correction (negative event), unpack & repack, session cancel resets counts', async () => {
    const s = await stocked();
    const { order, fulfillmentId } = await readyToPack(s, 'MB-1', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const packer = await addMember(env, s.orgId, 'packer');
    const sid = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    const empty = await packer.client.post(`/api/pack/sessions/${sid}/next-box`, { clientEventId: randomUUID() });
    expect(empty.body.error.code).toBe('EMPTY_BOX');
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    const aId = item(await view(packer.client, sid), 'SKU-A').fulfillmentItemId;
    const corr = expectStatus(await packer.client.post(`/api/pack/sessions/${sid}/correct`, { clientEventId: randomUUID(), fulfillmentItemId: aId, qty: 1 }), 200).body;
    expect(corr).toMatchObject({ ok: true, packed: 1, remaining: 1 });
    let v = await view(packer.client, sid);
    expect(v.events.some((e: any) => e.type === 'correction' && e.qty === -1)).toBe(true);
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    const nb = expectStatus(await packer.client.post(`/api/pack/sessions/${sid}/next-box`, { clientEventId: randomUUID() }), 200).body;
    expect(nb.currentBox).toBe(2);
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-B'), 200);
    v = await view(packer.client, sid);
    expect(v.boxes).toEqual([
      { boxNo: 1, units: 2 },
      { boxNo: 2, units: 1 },
    ]);
    const done = expectStatus(await packer.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() }), 200).body;
    expect(done.shipments.map((x: any) => [x.boxNo, x.items])).toEqual([
      [1, [{ sku: 'SKU-A', quantity: 2 }]],
      [2, [{ sku: 'SKU-B', quantity: 1 }]],
    ]);
    // 梱包取消（未出荷）→ 下書き荷物を取消し、再梱包できる
    const un = expectStatus(await packer.client.post(`/api/fulfillments/${fulfillmentId}/unpack`, { reason: '入れ間違い' }), 200).body;
    expect(un.cancelledShipments).toHaveLength(2);
    let d = await orderDetail(s.owner.client, order.id);
    expect(d.fulfillments[0].status).toBe('picked');
    expect(d.shipments.every((x: any) => x.status === 'cancelled')).toBe(true);
    await expectIntegrity(env, s.orgId);
    const sid2 = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    expect(sid2).not.toBe(sid);
    expectStatus(await scan(packer.client, sid2, 'JAN-SKU-A'), 200);
    // 中止 → scan 済み数量は戻る（イベントは残る）
    expectStatus(await packer.client.post(`/api/pack/sessions/${sid2}/cancel`, { reason: '中断' }), 200);
    d = await orderDetail(s.owner.client, order.id);
    expect(d.fulfillments[0].status).toBe('picked');
    expect(d.fulfillments[0].items.every((i: any) => i.packedQty === 0)).toBe(true);
    const evs = await env.tx(s.orgId, (tx) => tx.one(`SELECT count(*)::int AS n FROM pack_events WHERE organization_id = $1 AND pack_session_id = $2`, [s.orgId, sid2]));
    expect(evs.n).toBe(1);
    const sid3 = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    for (const code of ['JAN-SKU-A', 'JAN-SKU-A', 'JAN-SKU-B']) expectStatus(await scan(packer.client, sid3, code), 200);
    const done3 = expectStatus(await packer.client.post(`/api/pack/sessions/${sid3}/complete`, { requestId: randomUUID() }), 200).body;
    expect(done3.shipments).toHaveLength(1);
    await expectIntegrity(env, s.orgId);
  });

  it('bulk quantity requires one physical scan first', async () => {
    const s = await stocked();
    const { fulfillmentId } = await readyToPack(s, 'BQ-1', [{ sku: 'SKU-A', quantity: 5 }]);
    const packer = await addMember(env, s.orgId, 'packer');
    const sid = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    const first = await scan(packer.client, sid, 'SKU-A', { qty: 3, inputMethod: 'manual' });
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('SCAN_FIRST');
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    expect((await scan(packer.client, sid, 'SKU-A', { qty: 5, inputMethod: 'manual' })).body.code).toBe('OVER_PACK');
    const bulk = expectStatus(await scan(packer.client, sid, 'SKU-A', { qty: 4, inputMethod: 'manual' }), 200).body;
    expect(bulk.allPacked).toBe(true);
    await expectIntegrity(env, s.orgId);
  });

  it('order cancel during packing stops the session (confirm required) and later scans are rejected', async () => {
    const s = await stocked();
    const { order, fulfillmentId } = await readyToPack(s, 'OC-1', [{ sku: 'SKU-A', quantity: 2 }]);
    const packer = await addMember(env, s.orgId, 'packer');
    const sid = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    expectStatus(await scan(packer.client, sid, 'JAN-SKU-A'), 200);
    const c1 = await s.owner.client.post(`/api/orders/${order.id}/cancel`, { reason: '顧客都合' });
    expect(c1.body.error.code).toBe('CONFIRM_REQUIRED');
    expectStatus(await s.owner.client.post(`/api/orders/${order.id}/cancel`, { reason: '顧客都合', confirm: true }), 200);
    const after = await scan(packer.client, sid, 'JAN-SKU-A');
    expect(after.status).toBe(409);
    expect(['SESSION_CLOSED', 'FULFILLMENT_CANCELLED']).toContain(after.body.error.code);
    expect((await orderDetail(s.owner.client, order.id)).status).toBe('cancelled');
    await expectIntegrity(env, s.orgId);
  });

  it('RBAC / warehouse scope / tenant isolation for pack APIs; packing slip shows address only with ship-to permission', async () => {
    const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'] });
    const locs = await locationsOf(s.owner.client, s.warehouses.TKY!);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 5);
    const o = await allocatedOrder(s.owner.client, s.channelId, 'RB-1', [{ sku: 'SKU-A', quantity: 1 }]);
    await waveAndPickAll(s.owner.client, s.warehouses.TKY!);
    const fulfillmentId = (await orderDetail(s.owner.client, o.id)).fulfillments[0].id;
    const picker = await addMember(env, s.orgId, 'picker');
    const support = await addMember(env, s.orgId, 'support');
    const oskPacker = await addMember(env, s.orgId, 'packer', { warehouseIds: [s.warehouses.OSK!] });
    const packer = await addMember(env, s.orgId, 'packer');
    expect((await picker.client.post('/api/pack/open', { fulfillmentId })).status).toBe(403);
    expect((await support.client.post('/api/pack/open', { fulfillmentId })).status).toBe(403);
    expect((await support.client.get(`/api/fulfillments/${fulfillmentId}/packing-slip`)).status).toBe(403);
    expect((await oskPacker.client.post('/api/pack/open', { fulfillmentId })).status).toBe(403);
    expect((await oskPacker.client.post('/api/pack/open', { code: o.orderNumber })).status).toBe(409); // 担当倉庫内に梱包対象なし
    const sid = expectStatus(await packer.client.post('/api/pack/open', { fulfillmentId }), 200).body.sessionId;
    expect((await oskPacker.client.get(`/api/pack/sessions/${sid}`)).status).toBe(403);
    expect((await picker.client.get(`/api/pack/sessions/${sid}`)).status).toBe(403);
    // 他組織からは存在自体が見えない
    const other = await createOrg(env);
    expect((await other.owner.client.get(`/api/pack/sessions/${sid}`)).status).toBe(404);
    expect((await other.owner.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code: 'JAN-SKU-A' })).status).toBe(404);
    expect((await other.owner.client.post('/api/pack/open', { code: o.orderNumber })).status).toBe(404);
    // Packer（orders.read_ship_to あり）は納品書で送付先を見られる。Picker は Pack 画面に入れない
    const slip = expectStatus(await packer.client.get(`/api/fulfillments/${fulfillmentId}/packing-slip`), 200).body;
    expect(slip.shipTo.name).toBe('顧客 太郎');
    expect(slip.items).toEqual([{ sku: 'SKU-A', name: '商品 SKU-A', variant: null, quantity: 1 }]);
    const v = await view(packer.client, sid);
    expect(v.fulfillment.shipTo.postalCode).toBe('150-0001');
    expect(JSON.stringify(v)).not.toContain('090-0000-0000'); // 電話番号は梱包画面に出さない
    const queue = expectStatus(await packer.client.get('/api/pack/queue'), 200).body;
    expect(queue.items.map((x: any) => x.fulfillmentId)).toContain(fulfillmentId);
    expect(expectStatus(await oskPacker.client.get('/api/pack/queue'), 200).body.items).toHaveLength(0);
  });
});
