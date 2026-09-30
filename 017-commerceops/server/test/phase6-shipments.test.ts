import { randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestClient, type TestEnv } from './helpers/env.js';
import { addMember, createOrg } from './helpers/factory.js';
import {
  allocatedOrder,
  availability,
  locationsOf,
  orderDetail,
  packFulfillment,
  receive,
  setupBasicOrg,
  shipReadyOrder,
  uploadFile,
  waveAndPickAll,
} from './helpers/scenario.js';
import { expectIntegrity } from './helpers/integrity.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function stocked(skus: Record<string, number> = { 'SKU-A': 20, 'SKU-B': 20, 'SKU-C': 20 }) {
  const s = await setupBasicOrg(env);
  const locs = await locationsOf(s.owner.client, s.warehouseId);
  const codes = ['A-01', 'A-02', 'A-03', 'A-04', 'A-05'];
  let i = 0;
  for (const [sku, qty] of Object.entries(skus)) if (qty > 0) await receive(s.owner.client, locs[codes[i++]!]!, s.products[sku]!, qty);
  return s;
}

const setTracking = (c: TestClient, id: string, trackingNumber: string, carrier = 'yamato') => c.patch(`/api/shipments/${id}`, { carrier, trackingNumber });

describe('Phase6 Shipment / split shipping / tracking (R12, R13)', () => {
  it('R12: resending ship confirm (concurrent + later) decrements on-hand only once and consumes the allocation', async () => {
    const s = await stocked();
    const { order, shipments } = await shipReadyOrder(s, 'SH-1', [{ sku: 'SKU-A', quantity: 2 }]);
    const before = await availability(s.owner.client, s.products['SKU-A']!);
    expect(before).toMatchObject({ onHand: 20, allocated: 2, available: 18 });
    const sh = shipments[0]!;
    expectStatus(await setTracking(s.owner.client, sh.id, '1234-5678-9012'), 200);
    const rs = await Promise.all([1, 2, 3].map(() => s.owner.client.post(`/api/shipments/${sh.id}/confirm`, {})));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.body.alreadyShipped === false)).toHaveLength(1);
    const again = expectStatus(await s.owner.client.post(`/api/shipments/${sh.id}/confirm`, {}), 200).body;
    expect(again.alreadyShipped).toBe(true);
    const after = await availability(s.owner.client, s.products['SKU-A']!);
    expect(after).toMatchObject({ onHand: 18, allocated: 0, available: 18 });
    const d = await orderDetail(s.owner.client, order.id);
    expect(d.status).toBe('shipped');
    expect(d.fulfillments[0].status).toBe('shipped');
    expect(d.shipments[0]).toMatchObject({ status: 'shipped', carrier: 'yamato', trackingNumber: '123456789012' });
    expect(d.allocations.every((a: any) => a.status === 'consumed')).toBe(true);
    const moves = await env.tx(s.orgId, (tx) => tx.one(`SELECT count(*)::int AS n, SUM(on_hand_delta)::int AS d FROM inventory_movements WHERE organization_id = $1 AND movement_type = 'ship'`, [s.orgId]));
    expect(moves).toEqual({ n: 1, d: -2 });
    await expectIntegrity(env, s.orgId);
  });

  it('R13: split shipments (multi-box) never exceed packed or ordered quantity; rogue extra shipment is rejected', async () => {
    const s = await stocked();
    const o = await allocatedOrder(s.owner.client, s.channelId, 'SP-1', [
      { sku: 'SKU-A', quantity: 2 },
      { sku: 'SKU-B', quantity: 1 },
    ]);
    const { fulfillmentIds } = await waveAndPickAll(s.owner.client, s.warehouseId);
    const ffId = fulfillmentIds[0]!;
    // 2 箱に分けて梱包
    const sid = expectStatus(await s.owner.client.post('/api/pack/open', { fulfillmentId: ffId }), 200).body.sessionId;
    for (const code of ['JAN-SKU-A', 'JAN-SKU-A']) expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code }), 200);
    expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/next-box`, { clientEventId: randomUUID() }), 200);
    expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/scan`, { clientEventId: randomUUID(), code: 'JAN-SKU-B' }), 200);
    const [box1, box2] = expectStatus(await s.owner.client.post(`/api/pack/sessions/${sid}/complete`, { requestId: randomUUID() }), 200).body.shipments;
    expectStatus(await setTracking(s.owner.client, box1.id, 'AAA1111'), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${box1.id}/confirm`, {}), 200);
    let d = await orderDetail(s.owner.client, o.id);
    expect(d.status).toBe('partially_shipped');
    expect(d.items.find((i: any) => i.sku === 'SKU-A').shippedQty).toBe(2);
    expect(d.fulfillments[0].status).toBe('packed');
    // 不正な追加荷物（SKU-A をもう 1 個）を DB に直接作っても出荷確定できない
    const rogue = await env.tx(s.orgId, async (tx) => {
      const fi = await tx.one(`SELECT fi.id, fi.order_item_id, fi.product_id FROM fulfillment_items fi JOIN products p ON p.organization_id = fi.organization_id AND p.id = fi.product_id WHERE fi.organization_id = $1 AND fi.fulfillment_id = $2 AND p.sku = 'SKU-A'`, [s.orgId, ffId]);
      const id = randomUUID();
      await tx.exec(
        `INSERT INTO shipments (organization_id, id, shipment_number, order_id, fulfillment_id, warehouse_id, box_no, carrier, tracking_number, status)
         VALUES ($1, $2, 'SH-ROGUE', $3, $4, $5, 9, 'yamato', 'ROGUE999', 'draft')`,
        [s.orgId, id, o.id, ffId, s.warehouseId],
      );
      await tx.exec(`INSERT INTO shipment_items (organization_id, id, shipment_id, order_item_id, fulfillment_item_id, product_id, quantity) VALUES ($1, $2, $3, $4, $5, $6, 1)`, [
        s.orgId,
        randomUUID(),
        id,
        fi.order_item_id,
        fi.id,
        fi.product_id,
      ]);
      return id;
    });
    const r = await s.owner.client.post(`/api/shipments/${rogue}/confirm`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EXCEEDS_PACKED');
    await env.tx(s.orgId, (tx) => tx.exec(`UPDATE shipments SET status = 'cancelled' WHERE organization_id = $1 AND id = $2`, [s.orgId, rogue]));
    // DB の CHECK 制約でも注文数量超過は拒否される
    await expect(
      env.tx(s.orgId, (tx) => tx.exec(`UPDATE order_items SET shipped_qty = quantity + 1 WHERE organization_id = $1 AND order_id = $2`, [s.orgId, o.id])),
    ).rejects.toThrow();
    expectStatus(await setTracking(s.owner.client, box2.id, 'AAA2222'), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${box2.id}/confirm`, {}), 200);
    d = await orderDetail(s.owner.client, o.id);
    expect(d.status).toBe('shipped');
    expect(d.items.map((i: any) => [i.sku, i.shippedQty])).toEqual([
      ['SKU-A', 2],
      ['SKU-B', 1],
    ]);
    expect(d.shipments.filter((x: any) => x.status === 'shipped')).toHaveLength(2);
    // 出荷済みの注文は取消できない
    expect((await s.owner.client.post(`/api/orders/${o.id}/cancel`, { reason: 'x', confirm: true })).body.error.code).toBe('PARTIALLY_SHIPPED');
    await expectIntegrity(env, s.orgId);
  });

  it('E2E-3 (API): 3 SKUs with 1 short → ship 2 SKUs first → restock → 2nd shipment → order shipped', async () => {
    const s = await stocked({ 'SKU-A': 10, 'SKU-B': 10, 'SKU-C': 0 });
    const o = await allocatedOrder(
      s.owner.client,
      s.channelId,
      'E3-1',
      [
        { sku: 'SKU-A', quantity: 1 },
        { sku: 'SKU-B', quantity: 2 },
        { sku: 'SKU-C', quantity: 1 },
      ],
      { expect: 'partial' },
    );
    expect((await orderDetail(s.owner.client, o.id)).status).toBe('partially_allocated');
    // 揃った分を先行出荷
    const rel = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/release`, {}), 200).body;
    expect(rel.fulfillmentIds).toHaveLength(1);
    await waveAndPickAll(s.owner.client, s.warehouseId, rel.fulfillmentIds);
    const p1 = await packFulfillment(s.owner.client, rel.fulfillmentIds[0]);
    expectStatus(await setTracking(s.owner.client, p1.shipments[0]!.id, 'FIRST0001', 'sagawa'), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${p1.shipments[0]!.id}/confirm`, {}), 200);
    let d = await orderDetail(s.owner.client, o.id);
    expect(d.status).toBe('partially_shipped');
    // 後日 SKU-C が入荷 → 残りを引当 → 2 回目の出荷
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-05']!, s.products['SKU-C']!, 3);
    const a2 = expectStatus(await s.owner.client.post(`/api/orders/${o.id}/allocate`, {}), 200).body;
    expect(a2.outcome).toBe('full');
    d = await orderDetail(s.owner.client, o.id);
    const ff2 = d.fulfillments.find((f: any) => f.status === 'ready');
    await waveAndPickAll(s.owner.client, s.warehouseId, [ff2.id]);
    const p2 = await packFulfillment(s.owner.client, ff2.id);
    expect(p2.shipments[0]!.items).toEqual([{ sku: 'SKU-C', quantity: 1 }]);
    expectStatus(await setTracking(s.owner.client, p2.shipments[0]!.id, 'SECOND0002', 'sagawa'), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${p2.shipments[0]!.id}/confirm`, {}), 200);
    d = await orderDetail(s.owner.client, o.id);
    expect(d.status).toBe('shipped');
    expect(d.shipments.map((x: any) => x.trackingNumber).sort()).toEqual(['FIRST0001', 'SECOND0002']);
    expect(d.items.every((i: any) => i.shippedQty === i.quantity)).toBe(true);
    await expectIntegrity(env, s.orgId);
  });

  it('tracking: required before confirm, normalization, duplicates rejected, no-tracking option, correction after shipping needs reason', async () => {
    const s = await stocked();
    const a = await shipReadyOrder(s, 'TR-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const b = await shipReadyOrder(s, 'TR-2', [{ sku: 'SKU-B', quantity: 1 }]);
    const shA = a.shipments[0]!.id;
    const shB = b.shipments[0]!.id;
    const noCarrier = await s.owner.client.post(`/api/shipments/${shA}/confirm`, {});
    expect(noCarrier.body.error.code).toBe('CARRIER_REQUIRED');
    expectStatus(await s.owner.client.patch(`/api/shipments/${shA}`, { carrier: 'ヤマト運輸' }), 200);
    expect((await s.owner.client.post(`/api/shipments/${shA}/confirm`, {})).body.error.code).toBe('TRACKING_REQUIRED');
    expect((await s.owner.client.patch(`/api/shipments/${shA}`, { trackingNumber: '<script>' })).body.error.code).toBe('TRACKING_INVALID');
    const t = expectStatus(await s.owner.client.patch(`/api/shipments/${shA}`, { trackingNumber: '４４４４－５５５５ ６６６６' }), 200).body;
    expect(t).toMatchObject({ carrier: 'yamato', trackingNumber: '444455556666' });
    const dup = await setTracking(s.owner.client, shB, '4444-5555-6666');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TRACKING_DUPLICATE');
    // 別の配送会社なら同じ番号でも可
    expectStatus(await setTracking(s.owner.client, shB, '4444-5555-6666', 'sagawa'), 200);
    // 追跡番号なし（例: 追跡のない配送方法）
    expectStatus(await s.owner.client.patch(`/api/shipments/${shB}`, { noTracking: true }), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${shB}/confirm`, {}), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${shA}/confirm`, {}), 200);
    // 出荷後の訂正: 理由なしは拒否、重量などは変更不可、理由ありで訂正（監査）
    expect((await s.owner.client.patch(`/api/shipments/${shA}`, { trackingNumber: '777788889999' })).body.error.code).toBe('REASON_REQUIRED');
    expect((await s.owner.client.patch(`/api/shipments/${shA}`, { weightG: 100, reason: 'x' })).body.error.code).toBe('SHIPPED_LOCKED');
    expectStatus(await s.owner.client.patch(`/api/shipments/${shA}`, { trackingNumber: '777788889999', reason: '伝票の貼り間違い' }), 200);
    const detail = expectStatus(await s.owner.client.get(`/api/shipments/${shA}`), 200).body;
    expect(detail.trackingNumber).toBe('777788889999');
    expect(detail.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['shipment.update', 'shipment.confirm', 'shipment.tracking_correct']));
    await expectIntegrity(env, s.orgId);
  });

  it('tracking CSV import: dry run validates without changes; apply updates + confirms; duplicates become exceptions; Shift_JIS works', async () => {
    const s = await stocked();
    const a = await shipReadyOrder(s, 'CI-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const b = await shipReadyOrder(s, 'CI-2', [{ sku: 'SKU-B', quantity: 1 }]);
    const c = await shipReadyOrder(s, 'CI-3', [{ sku: 'SKU-C', quantity: 1 }]);
    const [shA, shB, shC] = [a.shipments[0]!, b.shipments[0]!, c.shipments[0]!];
    const csv = [
      '出荷番号,配送会社,追跡番号,出荷日',
      `${shA.shipmentNumber},ヤマト運輸,1111-2222-3333,2026/09/30`,
      `${shB.shipmentNumber},ヤマト運輸,1111-2222-3333,2026/09/30`, // ファイル内重複
      `SH-999999,佐川急便,5555666677,`, // 存在しない
      `${shC.shipmentNumber},謎の配送,9999888877,`, // 配送会社不明
    ].join('\r\n');
    const dry = await uploadFile(s.owner.client, '/api/shipments/tracking-import', { dryRun: 'true', confirm: 'true' }, Buffer.from('﻿' + csv, 'utf8'), 'tracking.csv');
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, total: 4, valid: 1, errors: 3, updated: 0 });
    expect(expectStatus(await s.owner.client.get(`/api/shipments/${shA.id}`), 200).body.trackingNumber).toBeNull();
    const applied = await uploadFile(s.owner.client, '/api/shipments/tracking-import', { dryRun: 'false', confirm: 'true' }, Buffer.from(csv, 'utf8'), 'tracking.csv');
    expect(applied.body).toMatchObject({ dryRun: false, updated: 1, confirmed: 1, errors: 3 });
    expect(applied.body.rows.find((r: any) => r.line === 3).message).toContain('重複');
    const detA = expectStatus(await s.owner.client.get(`/api/shipments/${shA.id}`), 200).body;
    expect(detA).toMatchObject({ status: 'shipped', carrier: 'yamato', trackingNumber: '111122223333' });
    const exc = await env.tx(s.orgId, (tx) => tx.many(`SELECT type FROM exception_cases WHERE organization_id = $1 AND type = 'tracking_duplicate'`, [s.orgId]));
    expect(exc).toHaveLength(1);
    // 同じファイルを再取込しても変化なし（出荷済み・同じ番号は unchanged）
    const again = await uploadFile(s.owner.client, '/api/shipments/tracking-import', { dryRun: 'false', confirm: 'true' }, Buffer.from(csv, 'utf8'), 'tracking.csv');
    expect(again.body.unchanged).toBe(1);
    expect(again.body.confirmed).toBe(0);
    // Shift_JIS（注文番号 + 箱番号で特定）
    const sjis = iconv.encode(['注文番号,箱番号,配送会社,追跡番号', `${b.order.orderNumber},1,佐川急便,4444-0000-1111`].join('\r\n'), 'cp932');
    const bad = await uploadFile(s.owner.client, '/api/shipments/tracking-import', { dryRun: 'true' }, sjis, 'sjis.csv');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('ENCODING_MISMATCH');
    const ok = await uploadFile(s.owner.client, '/api/shipments/tracking-import', { dryRun: 'false', encoding: 'shift_jis', confirm: 'false' }, sjis, 'sjis.csv');
    expect(ok.body).toMatchObject({ updated: 1, confirmed: 0, errors: 0 });
    expect(expectStatus(await s.owner.client.get(`/api/shipments/${shB.id}`), 200).body).toMatchObject({ status: 'draft', carrier: 'sagawa', trackingNumber: '444400001111' });
    await expectIntegrity(env, s.orgId);
  });

  it('CSV export: pending (with address, formula-safe) and shipped (tracking) need export permission', async () => {
    const s = await stocked();
    const o = await allocatedOrder(s.owner.client, s.channelId, 'EX-1', [{ sku: 'SKU-A', quantity: 1 }]);
    // 数式インジェクションを含む送付先名
    expectStatus(await s.owner.client.put(`/api/orders/${o.id}/address`, { name: '=HYPERLINK("http://evil")', postalCode: '1500001', address1: '東京都渋谷区神宮前1-1-1', phone: '090-1234-5678', reason: 'テスト' }), 200);
    const d0 = await orderDetail(s.owner.client, o.id);
    await waveAndPickAll(s.owner.client, s.warehouseId, [d0.fulfillments[0].id]);
    const p = await packFulfillment(s.owner.client, d0.fulfillments[0].id);
    const pending = await s.owner.client.get('/api/shipments/export?type=pending');
    expect(pending.status).toBe(200);
    expect(String(pending.headers['content-type'])).toContain('text/csv');
    expect(pending.text.startsWith('﻿出荷番号,')).toBe(true);
    expect(pending.text).toContain(p.shipments[0]!.shipmentNumber);
    expect(pending.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(pending.text).toContain('090-1234-5678');
    expectStatus(await setTracking(s.owner.client, p.shipments[0]!.id, 'EXP12345'), 200);
    expectStatus(await s.owner.client.post(`/api/shipments/${p.shipments[0]!.id}/confirm`, {}), 200);
    const shipped = await s.owner.client.get('/api/shipments/export?type=shipped&encoding=shift_jis');
    expect(shipped.status).toBe(200);
    expect(String(shipped.headers['content-type'])).toContain('Shift_JIS');
    const shippedUtf = await s.owner.client.get('/api/shipments/export?type=shipped');
    expect(shippedUtf.text).toContain('EXP12345');
    expect(shippedUtf.text).toContain('SKU-A×1');
    const support = await addMember(env, s.orgId, 'support');
    const packer = await addMember(env, s.orgId, 'packer');
    expect((await support.client.get('/api/shipments/export?type=shipped')).status).toBe(403);
    expect((await packer.client.get('/api/shipments/export?type=pending')).status).toBe(403);
    const audits = await env.tx(s.orgId, (tx) => tx.many(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'export.shipments'`, [s.orgId]));
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain('HYPERLINK');
  });

  it('hold blocks confirm; cancelled order drafts cannot ship; scan-confirm and bulk confirm', async () => {
    const s = await stocked();
    const a = await shipReadyOrder(s, 'HB-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const hold = expectStatus(await s.owner.client.post(`/api/orders/${a.order.id}/holds`, { reasonCode: 'address_check', confirm: true }), 200).body;
    expectStatus(await setTracking(s.owner.client, a.shipments[0]!.id, 'HOLD0001'), 200);
    expect((await s.owner.client.post(`/api/shipments/${a.shipments[0]!.id}/confirm`, {})).body.error.code).toBe('ON_HOLD');
    expectStatus(await s.owner.client.post(`/api/orders/${a.order.id}/holds/${hold.holdId}/release`, {}), 200);
    // scan 出荷（荷物コード + 追跡番号）
    const sc = expectStatus(await s.owner.client.post('/api/shipments/scan-confirm', { shipmentCode: a.shipments[0]!.shipmentNumber.toLowerCase(), trackingCode: 'SCAN-0001-0002', carrier: 'japanpost' }), 200).body;
    expect(sc.alreadyShipped).toBe(false);
    const sc2 = expectStatus(await s.owner.client.post('/api/shipments/scan-confirm', { shipmentCode: a.shipments[0]!.shipmentNumber, trackingCode: 'SCAN-0001-0002' }), 200).body;
    expect(sc2.alreadyShipped).toBe(true);
    expect(expectStatus(await s.owner.client.get(`/api/shipments/${a.shipments[0]!.id}`), 200).body).toMatchObject({ carrier: 'japanpost', trackingNumber: 'SCAN00010002' });
    // 注文キャンセル → 下書き荷物は取消 → 出荷不可
    const c = await shipReadyOrder(s, 'HB-2', [{ sku: 'SKU-B', quantity: 1 }]);
    expectStatus(await s.owner.client.post(`/api/orders/${c.order.id}/cancel`, { reason: '顧客都合', confirm: true }), 200);
    expect((await s.owner.client.post(`/api/shipments/${c.shipments[0]!.id}/confirm`, {})).body.error.code).toBe('SHIPMENT_CANCELLED');
    // まとめて確定: 追跡番号のない荷物だけ失敗
    const x = await shipReadyOrder(s, 'HB-3', [{ sku: 'SKU-C', quantity: 1 }]);
    const y = await shipReadyOrder(s, 'HB-4', [{ sku: 'SKU-C', quantity: 1 }]);
    expectStatus(await setTracking(s.owner.client, x.shipments[0]!.id, 'BULK0001'), 200);
    expectStatus(await s.owner.client.patch(`/api/shipments/${y.shipments[0]!.id}`, { carrier: 'yamato' }), 200);
    const bulk = expectStatus(await s.owner.client.post('/api/shipments/bulk-confirm', { shipmentIds: [x.shipments[0]!.id, y.shipments[0]!.id] }), 200).body;
    expect(bulk).toMatchObject({ confirmed: 1, failed: 1 });
    expect(bulk.results.find((r: any) => !r.ok).code).toBe('TRACKING_REQUIRED');
    await expectIntegrity(env, s.orgId);
  });

  it('RBAC / scope / tenant: packer & support read-only, picker denied, other org 404, warehouse-scoped manager', async () => {
    const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'] });
    const locs = await locationsOf(s.owner.client, s.warehouses.TKY!);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 5);
    const a = await shipReadyOrder({ owner: s.owner, channelId: s.channelId, warehouseId: s.warehouses.TKY! }, 'RB-1', [{ sku: 'SKU-A', quantity: 1 }]);
    const shId = a.shipments[0]!.id;
    const packer = await addMember(env, s.orgId, 'packer');
    const support = await addMember(env, s.orgId, 'support');
    const picker = await addMember(env, s.orgId, 'picker');
    const oskManager = await addMember(env, s.orgId, 'ops_manager', { warehouseIds: [s.warehouses.OSK!] });
    expectStatus(await packer.client.get(`/api/shipments/${shId}`), 200);
    expect((await packer.client.patch(`/api/shipments/${shId}`, { carrier: 'yamato', trackingNumber: 'PK0001' })).status).toBe(403);
    expect((await packer.client.post(`/api/shipments/${shId}/confirm`, {})).status).toBe(403);
    const sup = expectStatus(await support.client.get(`/api/shipments/${shId}`), 200).body;
    expect(sup.shipTo.phone).toBe('090-0000-0000'); // Support は read_pii（電話まで）
    const pk = expectStatus(await packer.client.get(`/api/shipments/${shId}`), 200).body;
    expect(pk.shipTo.name).toBe('顧客 太郎');
    expect(pk.shipTo.phone).toBeUndefined(); // Packer は氏名・住所まで
    expect((await support.client.post(`/api/shipments/${shId}/confirm`, {})).status).toBe(403);
    expect((await picker.client.get(`/api/shipments/${shId}`)).status).toBe(403);
    expect((await picker.client.get('/api/shipments')).status).toBe(403);
    expect((await oskManager.client.get(`/api/shipments/${shId}`)).status).toBe(403);
    expect(expectStatus(await oskManager.client.get('/api/shipments'), 200).body.items).toHaveLength(0);
    expect((await oskManager.client.post('/api/shipments/scan-confirm', { shipmentCode: a.shipments[0]!.shipmentNumber, trackingCode: 'X12345' })).status).toBe(403);
    const other = await createOrg(env);
    expect((await other.owner.client.get(`/api/shipments/${shId}`)).status).toBe(404);
    expect((await other.owner.client.post(`/api/shipments/${shId}/confirm`, {})).status).toBe(404);
    expect((await other.owner.client.patch(`/api/shipments/${shId}`, { trackingNumber: 'HACK0001' })).status).toBe(404);
    expect(expectStatus(await other.owner.client.get('/api/shipments'), 200).body.items).toHaveLength(0);
  });
});
