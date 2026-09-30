import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestClient, type TestEnv } from './helpers/env.js';
import { addMember, createOrg } from './helpers/factory.js';
import { availability, locationsOf, orderDetail, packFulfillment, receive, setupBasicOrg, shipReadyOrder, uploadFile, waveAndPickAll } from './helpers/scenario.js';
import { expectIntegrity } from './helpers/integrity.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function stocked() {
  const s = await setupBasicOrg(env);
  const locs = await locationsOf(s.owner.client, s.warehouseId);
  await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 20);
  await receive(s.owner.client, locs['A-02']!, s.products['SKU-B']!, 20);
  await receive(s.owner.client, locs['A-03']!, s.products['SKU-C']!, 20);
  return { ...s, locs };
}

/** 注文 → 出荷確定まで */
async function shippedOrder(s: Awaited<ReturnType<typeof stocked>>, ext: string, lines: { sku: string; quantity: number }[]) {
  const r = await shipReadyOrder(s, ext, lines);
  for (const [i, sh] of r.shipments.entries()) {
    expectStatus(await s.owner.client.patch(`/api/shipments/${sh.id}`, { carrier: 'yamato', trackingNumber: `${ext.replace(/[^A-Z0-9]/gi, '')}${i}0000` }), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${sh.id}/confirm`, {}), 200);
  }
  const d = await orderDetail(s.owner.client, r.order.id);
  expect(d.status).toBe('shipped');
  return { order: r.order, detail: d, itemId: (sku: string) => d.items.find((i: any) => i.sku === sku).id as string };
}

const newReturn = (c: TestClient, orderId: string, items: { orderItemId: string; qty: number }[], reasonCode = 'defective') =>
  c.post('/api/returns', { orderId, reasonCode, items, customerNote: '初期不良' });

describe('Phase7 returns / inspection / restock / exchange (R14–R18, R23)', () => {
  it('R14 + R15 (E2E-5): receiving does not add stock; only restock inspection increases Available; order returns to shipped', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-1', [{ sku: 'SKU-A', quantity: 2 }]);
    const afterShip = await availability(s.owner.client, s.products['SKU-A']!);
    expect(afterShip).toMatchObject({ onHand: 18, available: 18 });
    const support = await addMember(env, s.orgId, 'support');
    const packer = await addMember(env, s.orgId, 'packer');
    const created = expectStatus(await newReturn(support.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 2 }]), 200).body;
    expect(created.returnNumber).toMatch(/^RT-\d{6}$/);
    expect((await orderDetail(s.owner.client, o.order.id)).status).toBe('return_in_progress');
    expectStatus(await support.client.post(`/api/returns/${created.id}/authorize`, {}), 200);
    // 到着 scan（Packer）: RMA コードで検索 → 到着登録
    const found = expectStatus(await packer.client.get(`/api/returns/lookup?code=${created.returnNumber.toLowerCase()}`), 200).body.items;
    expect(found.map((x: any) => x.id)).toEqual([created.id]);
    const detail = expectStatus(await packer.client.get(`/api/returns/${created.id}`), 200).body;
    expect(detail.customerNote).toBeUndefined(); // 到着担当には顧客メモを出さない
    const rcv = expectStatus(await packer.client.post(`/api/returns/${created.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: detail.items[0].id, receivedQty: 2 }] }), 200).body;
    expect(rcv.status).toBe('received');
    // R14: 到着だけでは在庫は増えない
    expect(await availability(s.owner.client, s.products['SKU-A']!)).toMatchObject({ onHand: 18, available: 18 });
    // R15: Restock で Available が増える
    const ins = expectStatus(
      await s.owner.client.post(`/api/returns/${created.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: detail.items[0].id, disposition: 'restock', qty: 2 }] }),
      200,
    ).body;
    expect(ins.status).toBe('completed');
    expect(ins.inspections[0]).toMatchObject({ disposition: 'restock', qty: 2, locationCode: 'A-01' });
    expect(await availability(s.owner.client, s.products['SKU-A']!)).toMatchObject({ onHand: 20, available: 20 });
    expect((await orderDetail(s.owner.client, o.order.id)).status).toBe('shipped');
    const d = expectStatus(await s.owner.client.get(`/api/returns/${created.id}`), 200).body;
    expect(d.timeline.map((t: any) => t.key)).toEqual(['requested', 'authorized', 'received', 'inspecting', 'completed']);
    await expectIntegrity(env, s.orgId);
  });

  it('R16: damaged / quarantine / discard never return to sellable stock (split dispositions)', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-2', [{ sku: 'SKU-B', quantity: 4 }]);
    const ret = expectStatus(await newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-B'), qty: 4 }], 'damaged_in_transit'), 200).body;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
    const riId = expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body.items[0].id;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: riId, receivedQty: 4 }] }), 200);
    const before = await availability(s.owner.client, s.products['SKU-B']!);
    const noReason = await s.owner.client.post(`/api/returns/${ret.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: riId, disposition: 'damaged', qty: 1 }] });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const r = expectStatus(
      await s.owner.client.post(`/api/returns/${ret.id}/inspect`, {
        clientRequestId: randomUUID(),
        lines: [
          { returnItemId: riId, disposition: 'restock', qty: 1 },
          { returnItemId: riId, disposition: 'damaged', qty: 1, reason: '外箱破損・中身キズ' },
          { returnItemId: riId, disposition: 'quarantine', qty: 1, reason: '動作確認待ち' },
          { returnItemId: riId, disposition: 'discard', qty: 1, reason: '汚損' },
        ],
      }),
      200,
    ).body;
    expect(r.status).toBe('completed');
    const after = await availability(s.owner.client, s.products['SKU-B']!);
    expect(after.available - before.available).toBe(1); // Restock の 1 個だけ
    const all = after.balances;
    expect(all.find((b: any) => b.kind === 'damaged')?.onHand).toBe(1);
    expect(all.find((b: any) => b.kind === 'quarantine')?.onHand).toBe(1);
    const discard = await env.tx(s.orgId, (tx) => tx.one(`SELECT on_hand_delta, reason FROM inventory_movements WHERE organization_id = $1 AND movement_type = 'discard'`, [s.orgId]));
    expect(discard.on_hand_delta).toBe(0);
    await expectIntegrity(env, s.orgId);
  });

  it('R17: resent inspection (concurrent) restocks once; over-inspection and post-completion inspections are rejected', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-3', [{ sku: 'SKU-A', quantity: 3 }]);
    const ret = expectStatus(await newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 3 }]), 200).body;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
    const riId = expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body.items[0].id;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: riId, receivedQty: 3 }] }), 200);
    const before = await availability(s.owner.client, s.products['SKU-A']!);
    const reqId = randomUUID();
    const body = { clientRequestId: reqId, lines: [{ returnItemId: riId, disposition: 'restock', qty: 2 }] };
    const rs = await Promise.all([1, 2, 3].map(() => s.owner.client.post(`/api/returns/${ret.id}/inspect`, body)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect((await availability(s.owner.client, s.products['SKU-A']!)).available - before.available).toBe(2);
    const over = await s.owner.client.post(`/api/returns/${ret.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: riId, disposition: 'restock', qty: 2 }] });
    expect(over.body.error.code).toBe('EXCEEDS_RECEIVED');
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: riId, disposition: 'restock', qty: 1 }] }), 200);
    const late = await s.owner.client.post(`/api/returns/${ret.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: riId, disposition: 'restock', qty: 1 }] });
    expect(late.body.error.code).toBe('NOT_RECEIVED');
    expect((await availability(s.owner.client, s.products['SKU-A']!)).available - before.available).toBe(3);
    const n = await env.tx(s.orgId, (tx) => tx.one(`SELECT count(*)::int AS n FROM return_inspections WHERE organization_id = $1`, [s.orgId]));
    expect(n.n).toBe(2);
    await expectIntegrity(env, s.orgId);
  });

  it('R18 (E2E-6): damaged return → exchange creates a replacement order that goes through normal allocation → pick → pack → ship', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-4', [{ sku: 'SKU-C', quantity: 1 }]);
    const ret = expectStatus(await newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-C'), qty: 1 }]), 200).body;
    // 承認前は交換できない
    expect((await s.owner.client.post(`/api/returns/${ret.id}/exchange`, { items: [{ sku: 'SKU-C', quantity: 1 }] })).body.error.code).toBe('INVALID_TRANSITION');
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
    const riId = expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body.items[0].id;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: riId, receivedQty: 1 }] }), 200);
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: riId, disposition: 'damaged', qty: 1, reason: '破損' }] }), 200);
    const beforeC = await availability(s.owner.client, s.products['SKU-C']!);
    const support = await addMember(env, s.orgId, 'support');
    const ex = expectStatus(await support.client.post(`/api/returns/${ret.id}/exchange`, { items: [{ sku: 'SKU-C', quantity: 1, originalOrderItemId: o.itemId('SKU-C') }], note: '同一品で交換' }), 200).body;
    expect(ex.exchangeNumber).toMatch(/^EX-\d{6}$/);
    expect(ex.allocation).toBe('full'); // 通常の引当エンジン
    expect((await support.client.post(`/api/returns/${ret.id}/exchange`, { items: [{ sku: 'SKU-C', quantity: 1 }] })).body.error.code).toBe('EXCHANGE_EXISTS');
    const rep = await orderDetail(s.owner.client, ex.replacementOrderId);
    expect(rep).toMatchObject({ orderType: 'replacement', sourceOrderId: o.order.id, exchangeId: ex.exchangeId, status: 'allocated' });
    expect(rep.items[0]).toMatchObject({ sku: 'SKU-C', quantity: 1 });
    expect(Number(rep.items[0].unitPrice)).toBe(0);
    expect(rep.shipTo.name).toBe('顧客 太郎');
    expect(rep.fulfillments[0].type).toBe('replacement');
    // Damaged 分は販売可能在庫に戻らず、交換品の引当で Available が 1 減る
    const afterAlloc = await availability(s.owner.client, s.products['SKU-C']!);
    expect(beforeC.available - afterAlloc.available).toBe(1);
    // 通常の Wave → Pick → Pack → Ship
    await waveAndPickAll(s.owner.client, s.warehouseId, [rep.fulfillments[0].id]);
    const packed = await packFulfillment(s.owner.client, rep.fulfillments[0].id);
    expectStatus(await s.owner.client.patch(`/api/shipments/${packed.shipments[0]!.id}`, { carrier: 'sagawa', trackingNumber: 'EXCH0001' }), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${packed.shipments[0]!.id}/confirm`, {}), 200);
    expect((await orderDetail(s.owner.client, ex.replacementOrderId)).status).toBe('shipped');
    const d = expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body;
    expect(d.exchanges[0]).toMatchObject({ status: 'completed', replacementStatus: 'shipped' });
    const orig = await orderDetail(s.owner.client, o.order.id);
    expect(orig.status).toBe('shipped');
    expect(orig.relatedOrders.map((r: any) => r.id)).toContain(ex.replacementOrderId);
    await expectIntegrity(env, s.orgId);
  });

  it('R23 + RBAC: picker cannot dispose/receive/request; packer receives only; support requests only; other org 404', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-5', [{ sku: 'SKU-A', quantity: 1 }]);
    const picker = await addMember(env, s.orgId, 'picker');
    const packer = await addMember(env, s.orgId, 'packer');
    const support = await addMember(env, s.orgId, 'support');
    expect((await newReturn(picker.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 1 }])).status).toBe(403);
    expect((await newReturn(packer.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 1 }])).status).toBe(403);
    const ret = expectStatus(await newReturn(support.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 1 }]), 200).body;
    expectStatus(await support.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
    const riId = expectStatus(await support.client.get(`/api/returns/${ret.id}`), 200).body.items[0].id;
    const recvBody = { warehouseId: s.warehouseId, items: [{ returnItemId: riId, receivedQty: 1 }] };
    expect((await picker.client.post(`/api/returns/${ret.id}/receive`, recvBody)).status).toBe(403);
    expect((await support.client.post(`/api/returns/${ret.id}/receive`, recvBody)).status).toBe(403);
    expectStatus(await packer.client.post(`/api/returns/${ret.id}/receive`, recvBody), 200);
    const inspectBody = { clientRequestId: randomUUID(), lines: [{ returnItemId: riId, disposition: 'restock', qty: 1 }] };
    // R23: Picker は Disposition API を拒否される
    expect((await picker.client.post(`/api/returns/${ret.id}/inspect`, inspectBody)).status).toBe(403);
    expect((await packer.client.post(`/api/returns/${ret.id}/inspect`, inspectBody)).status).toBe(403);
    expect((await support.client.post(`/api/returns/${ret.id}/inspect`, inspectBody)).status).toBe(403);
    expect((await picker.client.get(`/api/returns/${ret.id}`)).status).toBe(403);
    expect((await picker.client.get('/api/returns')).status).toBe(403);
    const other = await createOrg(env);
    expect((await other.owner.client.get(`/api/returns/${ret.id}`)).status).toBe(404);
    expect((await other.owner.client.post(`/api/returns/${ret.id}/inspect`, inspectBody)).status).toBe(404);
    expect((await other.owner.client.post('/api/returns', { orderId: o.order.id, reasonCode: 'defective', items: [{ orderItemId: o.itemId('SKU-A'), qty: 1 }] })).status).toBe(404);
    // 検品はまだ誰もしていない（在庫は増えていない）
    const n = await env.tx(s.orgId, (tx) => tx.one(`SELECT count(*)::int AS n FROM return_inspections WHERE organization_id = $1`, [s.orgId]));
    expect(n.n).toBe(0);
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/inspect`, inspectBody), 200);
  });

  it('return request validation: not shipped, over returnable, concurrent requests cannot exceed shipped qty', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-6', [{ sku: 'SKU-A', quantity: 3 }]);
    expect((await newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 4 }])).body.error.code).toBe('EXCEEDS_RETURNABLE');
    const rs = await Promise.all([1, 2].map(() => newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 2 }])));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const returnable = expectStatus(await s.owner.client.get(`/api/orders/${o.order.id}/returnable`), 200).body;
    expect(returnable.items[0]).toMatchObject({ shippedQty: 3, returnedQty: 2, returnableQty: 1 });
    // 却下すると返品可能数が戻る
    const okId = rs.find((r) => r.status === 200)!.body.id;
    expect((await s.owner.client.post(`/api/returns/${okId}/reject`, {})).body.error.code).toBe('REASON_REQUIRED');
    expectStatus(await s.owner.client.post(`/api/returns/${okId}/reject`, { reason: '返品期限切れ' }), 200);
    expect(expectStatus(await s.owner.client.get(`/api/orders/${o.order.id}/returnable`), 200).body.items[0].returnableQty).toBe(3);
    expect((await orderDetail(s.owner.client, o.order.id)).status).toBe('shipped');
    // 未出荷の注文は返品不可
    const unshipped = await shipReadyOrder(s, 'RT-6B', [{ sku: 'SKU-B', quantity: 1 }]);
    const ud = await orderDetail(s.owner.client, unshipped.order.id);
    expect((await newReturn(s.owner.client, unshipped.order.id, [{ orderItemId: ud.items[0].id, qty: 1 }])).body.error.code).toBe('NOT_SHIPPED');
    await expectIntegrity(env, s.orgId);
  });

  it('receiving: discrepancy creates an exception, repeated receive is idempotent, cancel after arrival is not allowed, in-transit tracking', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-7', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const ret = expectStatus(
      await newReturn(s.owner.client, o.order.id, [
        { orderItemId: o.itemId('SKU-A'), qty: 2 },
        { orderItemId: o.itemId('SKU-B'), qty: 1 },
      ]),
      200,
    ).body;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/in-transit`, { carrier: 'yamato', trackingNumber: '9999-8888-7777' }), 200);
    const d = expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body;
    expect(d).toMatchObject({ status: 'in_transit', returnTrackingNumber: '999988887777' });
    const a = d.items.find((i: any) => i.sku === 'SKU-A').id;
    const b = d.items.find((i: any) => i.sku === 'SKU-B').id;
    const over = await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: a, receivedQty: 3 }] });
    expect(over.body.error.code).toBe('INVALID_QTY');
    const r1 = expectStatus(
      await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: a, receivedQty: 1 }, { returnItemId: b, receivedQty: 1 }], unexpected: '別商品のケーブルが同梱' }),
      200,
    ).body;
    expect(r1.discrepancies).toEqual([{ sku: 'SKU-A', requested: 2, received: 1 }]);
    const r2 = expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: a, receivedQty: 2 }] }), 200).body;
    expect(r2.alreadyReceived).toBe(true);
    const exc = await env.tx(s.orgId, (tx) => tx.many(`SELECT type, detail FROM exception_cases WHERE organization_id = $1 AND return_id = $2`, [s.orgId, ret.id]));
    expect(exc).toHaveLength(1);
    expect(exc[0].type).toBe('return_discrepancy');
    expect(exc[0].detail.unexpected).toContain('ケーブル');
    expect((await s.owner.client.post(`/api/returns/${ret.id}/cancel`, { reason: 'x' })).body.error.code).toBe('INVALID_TRANSITION');
    // 到着数（2 個）を検品すると完了（届かなかった SKU-A 1 個は検品対象外）
    expectStatus(
      await s.owner.client.post(`/api/returns/${ret.id}/inspect`, {
        clientRequestId: randomUUID(),
        lines: [
          { returnItemId: a, disposition: 'restock', qty: 1 },
          { returnItemId: b, disposition: 'quarantine', qty: 1, reason: '要確認' },
        ],
      }),
      200,
    );
    expect(expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body.status).toBe('completed');
    await expectIntegrity(env, s.orgId);
  });

  it('inspection photos: only real images, served with nosniff, cannot be reused across returns or orgs', async () => {
    const s = await stocked();
    const o = await shippedOrder(s, 'RT-8', [{ sku: 'SKU-A', quantity: 2 }]);
    const ret = expectStatus(await newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 1 }]), 200).body;
    const ret2 = expectStatus(await newReturn(s.owner.client, o.order.id, [{ orderItemId: o.itemId('SKU-A'), qty: 1 }]), 200).body;
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
    const up = await uploadFile(s.owner.client, `/api/returns/${ret.id}/attachments`, {}, png, 'damage.png');
    expect(up.status).toBe(200);
    expect(up.body.contentType).toBe('image/png');
    const fake = await uploadFile(s.owner.client, `/api/returns/${ret.id}/attachments`, {}, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'evil.png');
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('UNSUPPORTED_FILE');
    const img = await s.owner.client.get(`/api/attachments/${up.body.id}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    const other = await createOrg(env);
    expect((await other.owner.client.get(`/api/attachments/${up.body.id}`)).status).toBe(404);
    // 別の返品の写真は指定できない
    expectStatus(await s.owner.client.post(`/api/returns/${ret2.id}/authorize`, {}), 200);
    const ri2 = expectStatus(await s.owner.client.get(`/api/returns/${ret2.id}`), 200).body.items[0].id;
    expectStatus(await s.owner.client.post(`/api/returns/${ret2.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: ri2, receivedQty: 1 }] }), 200);
    const bad = await s.owner.client.post(`/api/returns/${ret2.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: ri2, disposition: 'damaged', qty: 1, reason: 'キズ' }], attachmentIds: [up.body.id] });
    expect(bad.body.error.code).toBe('INVALID_ATTACHMENT');
    const picker = await addMember(env, s.orgId, 'picker');
    expect((await uploadFile(picker.client, `/api/returns/${ret.id}/attachments`, {}, png, 'x.png')).status).toBe(403);
  });
});
