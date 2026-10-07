/**
 * StockPilot(#013)から統合した機能（DECISIONS.md ADR-040）:
 * 仕入先・発注（分納・発注残・打切り）/ 補充提案 / 棚卸 / 誤登録の取消
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestEnv } from './helpers/env.js';
import { addMember } from './helpers/factory.js';
import { expectIntegrity } from './helpers/integrity.js';
import { allocatedOrder, availability, locationsOf, manualOrder, receive, setupBasicOrg } from './helpers/scenario.js';
import { poDisplayStatus, recommendQty } from '../src/modules/purchasing/service.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function org() {
  const s = await setupBasicOrg(env);
  const c = s.owner.client;
  const locs = await locationsOf(c, s.warehouseId);
  const sup = expectStatus(await c.post('/api/suppliers', { code: 'S1', name: '仕入先1', leadTimeDays: 7 }), 200).body;
  return { s, c, locs, supplierId: sup.id as string };
}

async function movementsOf(c: any, productId: string) {
  return (expectStatus(await c.get(`/api/inventory/movements?productId=${productId}&limit=200`), 200).body as any).items as any[];
}

describe('StockPilot merge: pure rules', () => {
  it('replenishment formula matches StockPilot (P ≦ reorder point → round up to order multiple / MOQ)', () => {
    const s = { reorderPoint: 10, targetStock: 50, minOrderQty: 0, orderMultiple: 1 };
    expect(recommendQty(s, 11)).toBe(0);
    expect(recommendQty(s, 10)).toBe(40);
    expect(recommendQty({ ...s, orderMultiple: 12 }, 10)).toBe(48);
    expect(recommendQty({ ...s, minOrderQty: 60, orderMultiple: 12 }, 10)).toBe(60);
    expect(recommendQty(s, -5)).toBe(55); // 受注残で P が負になっても目標まで
  });
  it('purchase order display status', () => {
    expect(poDisplayStatus('placed', [{ ordered_qty: 10, received_qty: 0, closed_qty: 0 }])).toBe('ordered');
    expect(poDisplayStatus('placed', [{ ordered_qty: 10, received_qty: 4, closed_qty: 0 }])).toBe('partial');
    expect(poDisplayStatus('placed', [{ ordered_qty: 10, received_qty: 10, closed_qty: 0 }])).toBe('received');
    expect(poDisplayStatus('placed', [{ ordered_qty: 10, received_qty: 6, closed_qty: 4 }])).toBe('closed_short');
    expect(poDisplayStatus('draft', [])).toBe('draft');
  });
});

describe('StockPilot merge: purchase orders (分納・発注残)', () => {
  it('draft → placed → partial receipt split across locations → over-receipt rejected → replay ignored → close remaining', async () => {
    const { s, c, locs, supplierId } = await org();
    const A = s.products['SKU-A']!;
    const B = s.products['SKU-B']!;
    const po = expectStatus(
      await c.post('/api/purchase-orders', { supplierId, warehouseId: s.warehouseId, expectedDate: '2030-01-10', lines: [{ productId: A, qty: 10 }, { productId: B, locationId: locs['A-02'], qty: 5 }] }),
      200,
    ).body;
    expect(po.poNumber).toMatch(/^PO-\d{6}$/);
    expect(po.displayStatus).toBe('draft');
    // 下書きは入荷できない
    expectStatus(await c.post(`/api/purchase-orders/${po.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: po.lines[0].id, qty: 1 }] }), 409);
    expectStatus(await c.post(`/api/purchase-orders/${po.id}/place`, {}), 200);

    const reqId = randomUUID();
    const r1 = expectStatus(
      await c.post(`/api/purchase-orders/${po.id}/receive`, {
        requestId: reqId,
        lines: [
          { lineId: po.lines[0].id, qty: 3 },
          { lineId: po.lines[0].id, qty: 2, locationId: locs['A-03'] },
        ],
      }),
      200,
    ).body;
    expect(r1.applied).toBe(true);
    expect(r1.displayStatus).toBe('partial');
    expect(r1.lines[0]).toMatchObject({ receivedQty: 5, openQty: 5 });
    expect((await availability(c, A)).onHand).toBe(5);
    // 同じ requestId の再送は二重に入荷しない
    const r2 = expectStatus(await c.post(`/api/purchase-orders/${po.id}/receive`, { requestId: reqId, lines: [{ lineId: po.lines[0].id, qty: 3 }, { lineId: po.lines[0].id, qty: 2 }] }), 200).body;
    expect(r2.applied).toBe(false);
    expect((await availability(c, A)).onHand).toBe(5);
    // 発注残を超える入荷は在庫も発注も変えない
    const over = await c.post(`/api/purchase-orders/${po.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: po.lines[0].id, qty: 6 }] });
    expectStatus(over, 409);
    expect(over.body.error.code).toBe('OVER_RECEIPT');
    expect((await availability(c, A)).onHand).toBe(5);
    // 入荷の履歴は発注明細を参照している
    expect((await movementsOf(c, A)).filter((m) => m.referenceType === 'po_line')).toHaveLength(2);

    // 入荷済みがあると取消はできず、打切りで締める
    expectStatus(await c.post(`/api/purchase-orders/${po.id}/cancel`, {}), 409);
    expectStatus(await c.post(`/api/purchase-orders/${po.id}/close`, {}), 400);
    const closed = expectStatus(await c.post(`/api/purchase-orders/${po.id}/close`, { reason: '欠品' }), 200).body;
    expect(closed.displayStatus).toBe('closed_short');
    expect(closed.lines.map((l: any) => l.openQty)).toEqual([0, 0]);
    const list = expectStatus(await c.get('/api/purchase-orders?status=open'), 200).body;
    expect(list.items.find((x: any) => x.id === po.id)).toBeUndefined();
    await expectIntegrity(env, s.orgId);
  });

  it('draft can be edited and cancelled; lines must use locations of the PO warehouse', async () => {
    const { s, c, supplierId } = await org();
    const po = expectStatus(await c.post('/api/purchase-orders', { supplierId, warehouseId: s.warehouseId, lines: [{ productId: s.products['SKU-A'], qty: 1 }] }), 200).body;
    const upd = expectStatus(await c.put(`/api/purchase-orders/${po.id}`, { note: 'メモ', lines: [{ productId: s.products['SKU-C'], qty: 4 }] }), 200).body;
    expect(upd.lines).toHaveLength(1);
    expect(upd.lines[0]).toMatchObject({ sku: 'SKU-C', orderedQty: 4 });
    const other = expectStatus(await c.post('/api/warehouses', { code: 'OSK', name: 'OSK 倉庫', priority: 20 }), 200).body.id;
    expectStatus(await c.post(`/api/warehouses/${other}/locations/bulk`, { lines: ['B-01'] }), 200);
    const oskLoc = (await locationsOf(c, other))['B-01'];
    expectStatus(await c.put(`/api/purchase-orders/${po.id}`, { lines: [{ productId: s.products['SKU-C'], locationId: oskLoc, qty: 4 }] }), 400);
    expect(expectStatus(await c.post(`/api/purchase-orders/${po.id}/cancel`, {}), 200).body.displayStatus).toBe('cancelled');
  });

  it('permissions: support can not see purchasing; picker can not receive', async () => {
    const { s, c, supplierId } = await org();
    const support = await addMember(env, s.orgId, 'support');
    const picker = await addMember(env, s.orgId, 'picker');
    expectStatus(await support.client.get('/api/purchase-orders'), 403);
    const po = expectStatus(await c.post('/api/purchase-orders', { supplierId, warehouseId: s.warehouseId, lines: [{ productId: s.products['SKU-A'], qty: 1 }] }), 200).body;
    await c.post(`/api/purchase-orders/${po.id}/place`, {});
    expectStatus(await picker.client.post(`/api/purchase-orders/${po.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: po.lines[0].id, qty: 1 }] }), 403);
  });
});

describe('StockPilot merge: replenishment', () => {
  it('P = usable + open PO − unallocated demand; drafts per supplier with basis check', async () => {
    const { s, c, locs, supplierId } = await org();
    const A = s.products['SKU-A']!;
    const B = s.products['SKU-B']!;
    const sup2 = expectStatus(await c.post('/api/suppliers', { code: 'S2', name: '仕入先2' }), 200).body.id;
    await receive(c, locs['A-01']!, A, 8);
    // 安全在庫 ≦ 発注点 ＜ 目標 でなければ保存できない
    expectStatus(await c.put(`/api/products/${A}/replenishment`, { settings: { supplierId, safetyStock: 5, reorderPoint: 3, targetStock: 20 } }), 400);
    expectStatus(await c.put(`/api/products/${A}/replenishment`, { settings: { supplierId, safetyStock: 3, reorderPoint: 10, targetStock: 30, orderMultiple: 6 } }), 200);
    expectStatus(await c.put(`/api/products/${B}/replenishment`, { settings: { supplierId: sup2, safetyStock: 0, reorderPoint: 0, targetStock: 5 } }), 200);
    // 引当 2 → U = 6、引当待ちの注文 3 → D = 3（在庫を超える注文は一部引当）
    await allocatedOrder(c, s.channelId, 'RP-1', [{ sku: 'SKU-A', quantity: 2 }]);
    await manualOrder(c, s.channelId, 'RP-2', [{ sku: 'SKU-B', quantity: 3 }]);
    // 下書きの発注は発注残に含めない / 発注済みは含める
    const po = expectStatus(await c.post('/api/purchase-orders', { supplierId, warehouseId: s.warehouseId, lines: [{ productId: A, qty: 4 }] }), 200).body;
    let items = expectStatus(await c.get('/api/replenishment'), 200).body.items as any[];
    let a = items.find((x) => x.productId === A);
    expect(a).toMatchObject({ usable: 6, openPo: 0, p: 6, recommended: 24, belowSafety: false });
    await c.post(`/api/purchase-orders/${po.id}/place`, {});
    items = expectStatus(await c.get('/api/replenishment'), 200).body.items as any[];
    a = items.find((x) => x.productId === A);
    expect(a).toMatchObject({ openPo: 4, p: 10, recommended: 24 });
    const b = items.find((x) => x.productId === B);
    expect(b).toMatchObject({ usable: 0, demand: 3, p: -3, recommended: 8 });

    // 表示後に在庫が変わったら BASIS_CHANGED
    await receive(c, locs['A-01']!, A, 1);
    const stale = await c.post('/api/replenishment/drafts', { warehouseId: s.warehouseId, items: [{ productId: A, qty: 24, basisP: 10 }] });
    expectStatus(stale, 409);
    expect(stale.body.error.code).toBe('BASIS_CHANGED');
    const r = expectStatus(
      await c.post('/api/replenishment/drafts', { warehouseId: s.warehouseId, items: [{ productId: A, qty: 24, basisP: 11 }, { productId: B, qty: 8, basisP: -3 }] }),
      200,
    ).body;
    expect(r.created).toHaveLength(2); // 仕入先ごと
    const d = expectStatus(await c.get(`/api/purchase-orders/${r.created.find((x: any) => x.supplierId === supplierId).id}`), 200).body;
    expect(d).toMatchObject({ displayStatus: 'draft' });
    expect(d.lines[0]).toMatchObject({ productId: A, orderedQty: 24 });
    // 仕入先なしは作れない
    expectStatus(await c.put(`/api/products/${B}/replenishment`, { settings: { supplierId: null, safetyStock: 0, reorderPoint: 0, targetStock: 5 } }), 200);
    expectStatus(await c.post('/api/replenishment/drafts', { warehouseId: s.warehouseId, items: [{ productId: B, qty: 8, basisP: -3 }] }), 400);
    // 設定の削除
    expectStatus(await c.put(`/api/products/${B}/replenishment`, { settings: null }), 200);
    expect((expectStatus(await c.get('/api/replenishment?all=true'), 200).body.items as any[]).some((x) => x.productId === B)).toBe(false);
  });
});

describe('StockPilot merge: stocktake', () => {
  it('count → review (uncounted / reason checks) → confirm adjusts only variances; picker counts, cannot confirm', async () => {
    const { s, c, locs } = await org();
    const A = s.products['SKU-A']!;
    const B = s.products['SKU-B']!;
    await receive(c, locs['A-04']!, A, 10);
    await receive(c, locs['A-04']!, B, 4);
    const picker = await addMember(env, s.orgId, 'picker');
    const st = expectStatus(await picker.client.post('/api/stocktakes', { locationId: locs['A-04'] }), 200).body;
    expect(st.lines.map((l: any) => [l.sku, l.expectedQty, l.countedQty])).toEqual([
      ['SKU-A', 10, null],
      ['SKU-B', 4, null],
    ]);
    // 同じロケーションの2つ目は開始できない
    expectStatus(await c.post('/api/stocktakes', { locationId: locs['A-04'] }), 409);
    // 在庫0の商品もスキャン（JAN）で追加できる
    const added = expectStatus(await picker.client.post(`/api/stocktakes/${st.id}/lines`, { code: 'JAN-SKU-C' }), 200).body.stocktake;
    const lineOf = (x: any, sku: string) => x.lines.find((l: any) => l.sku === sku);
    expectStatus(await picker.client.post(`/api/stocktakes/${st.id}/review`, {}), 409); // 未計数
    let cur = added;
    cur = expectStatus(await picker.client.put(`/api/stocktakes/${st.id}/lines/${lineOf(cur, 'SKU-A').id}`, { countedQty: 8, version: lineOf(cur, 'SKU-A').version }), 200).body;
    cur = expectStatus(await picker.client.put(`/api/stocktakes/${st.id}/lines/${lineOf(cur, 'SKU-B').id}`, { countedQty: 4, version: lineOf(cur, 'SKU-B').version }), 200).body;
    cur = expectStatus(await picker.client.put(`/api/stocktakes/${st.id}/lines/${lineOf(cur, 'SKU-C').id}`, { countedQty: 1, version: lineOf(cur, 'SKU-C').version }), 200).body;
    // 古い version は競合
    expectStatus(await picker.client.put(`/api/stocktakes/${st.id}/lines/${lineOf(cur, 'SKU-A').id}`, { countedQty: 9, version: 1 }), 409);
    expectStatus(await picker.client.post(`/api/stocktakes/${st.id}/review`, {}), 409); // 差異の理由なし
    cur = expectStatus(await picker.client.put(`/api/stocktakes/${st.id}/lines/${lineOf(cur, 'SKU-A').id}`, { countedQty: 8, reason: '破損2個', version: lineOf(cur, 'SKU-A').version }), 200).body;
    cur = expectStatus(await picker.client.put(`/api/stocktakes/${st.id}/lines/${lineOf(cur, 'SKU-C').id}`, { countedQty: 1, reason: '未登録品', version: lineOf(cur, 'SKU-C').version }), 200).body;
    expect(expectStatus(await picker.client.post(`/api/stocktakes/${st.id}/review`, {}), 200).body.status).toBe('review');
    expectStatus(await picker.client.post(`/api/stocktakes/${st.id}/confirm`, {}), 403);
    const done = expectStatus(await c.post(`/api/stocktakes/${st.id}/confirm`, {}), 200).body;
    expect(done).toMatchObject({ status: 'confirmed', adjustments: 2 });
    // 再確定は二重に調整しない
    expect(expectStatus(await c.post(`/api/stocktakes/${st.id}/confirm`, {}), 200).body.adjustments).toBe(0);
    const bal = (await availability(c, A)).balances.find((b: any) => b.locationId === locs['A-04']);
    expect(bal.onHand).toBe(8);
    expect((await availability(c, B)).onHand).toBe(4);
    // 棚卸の調整は取り消せない
    const adj = (await movementsOf(c, A)).find((m) => m.referenceType === 'stocktake');
    expect(adj.reversible).toBe(false);
    expectStatus(await c.post(`/api/inventory/movements/${adj.id}/reverse`, { reason: 'x' }), 409);
    await expectIntegrity(env, s.orgId);
  });

  it('stock moved during the count → STOCKTAKE_STALE; counting below allocated → STOCKTAKE_BELOW_COMMITTED', async () => {
    const { s, c, locs } = await org();
    const A = s.products['SKU-A']!;
    await receive(c, locs['A-01']!, A, 5);
    const st = expectStatus(await c.post('/api/stocktakes', { locationId: locs['A-01'] }), 200).body;
    await receive(c, locs['A-01']!, A, 1); // 棚卸中に入荷
    const l = st.lines[0];
    await c.put(`/api/stocktakes/${st.id}/lines/${l.id}`, { countedQty: 5, version: l.version });
    await c.post(`/api/stocktakes/${st.id}/review`, {});
    const r = await c.post(`/api/stocktakes/${st.id}/confirm`, {});
    expectStatus(r, 409);
    expect(r.body.error.code).toBe('STOCKTAKE_STALE');
    expect((await availability(c, A)).onHand).toBe(6);
    expect(expectStatus(await c.post(`/api/stocktakes/${st.id}/cancel`, {}), 200).body.status).toBe('cancelled');

    await allocatedOrder(c, s.channelId, 'ST-1', [{ sku: 'SKU-A', quantity: 4 }]);
    const st2 = expectStatus(await c.post('/api/stocktakes', { locationId: locs['A-01'] }), 200).body;
    const l2 = st2.lines[0];
    await c.put(`/api/stocktakes/${st2.id}/lines/${l2.id}`, { countedQty: 3, reason: '紛失', version: l2.version });
    await c.post(`/api/stocktakes/${st2.id}/review`, {});
    const r2 = await c.post(`/api/stocktakes/${st2.id}/confirm`, {});
    expectStatus(r2, 409);
    expect(r2.body.error.code).toBe('STOCKTAKE_BELOW_COMMITTED');
    expect((await availability(c, A)).onHand).toBe(6);
    await expectIntegrity(env, s.orgId);
  });
});

describe('StockPilot merge: reversal of mistaken movements', () => {
  it('receipt, transfer (both sides) and PO receipt can be reversed once; not below allocated', async () => {
    const { s, c, locs, supplierId } = await org();
    const A = s.products['SKU-A']!;
    const rec = expectStatus(await c.post('/api/inventory/receipts', { locationId: locs['A-01'], productId: A, qty: 7, requestId: randomUUID() }), 200).body;
    let mv = (await movementsOf(c, A))[0];
    expect(mv).toMatchObject({ type: 'receipt', reversible: true });
    expectStatus(await c.post(`/api/inventory/movements/${mv.id}/reverse`, {}), 400); // 理由必須
    expectStatus(await c.post(`/api/inventory/movements/${mv.id}/reverse`, { reason: '数量の入力ミス' }), 200);
    expect((await availability(c, A)).onHand).toBe(0);
    const again = await c.post(`/api/inventory/movements/${mv.id}/reverse`, { reason: '再度' });
    expectStatus(again, 409);
    expect(again.body.error.code).toBe('ALREADY_REVERSED');
    expect(rec.applied).toBe(true);

    // 移動の取消は相手側も戻る
    await receive(c, locs['A-01']!, A, 10);
    expectStatus(await c.post('/api/inventory/transfers', { fromLocationId: locs['A-01'], toLocationId: locs['A-02'], productId: A, qty: 4, requestId: randomUUID() }), 200);
    const tin = (await movementsOf(c, A)).find((m) => m.type === 'transfer_in')!;
    expectStatus(await c.post(`/api/inventory/movements/${tin.id}/reverse`, { reason: '移動先の間違い' }), 200);
    const bals = (await availability(c, A)).balances;
    expect(bals.find((b: any) => b.locationId === locs['A-01']).onHand).toBe(10);
    expect(bals.find((b: any) => b.locationId === locs['A-02']).onHand).toBe(0);
    const out = (await movementsOf(c, A)).find((m) => m.type === 'transfer_out')!;
    expect(out.reversed).toBe(true);

    // 発注入荷の取消は発注残に戻る
    const po = expectStatus(await c.post('/api/purchase-orders', { supplierId, warehouseId: s.warehouseId, lines: [{ productId: A, locationId: locs['A-03'], qty: 5 }] }), 200).body;
    await c.post(`/api/purchase-orders/${po.id}/place`, {});
    await c.post(`/api/purchase-orders/${po.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: po.lines[0].id, qty: 5 }] });
    const poMv = (await movementsOf(c, A)).find((m) => m.referenceType === 'po_line' && m.type === 'receipt')!;
    expectStatus(await c.post(`/api/inventory/movements/${poMv.id}/reverse`, { reason: '別の発注の入荷だった' }), 200);
    const poNow = expectStatus(await c.get(`/api/purchase-orders/${po.id}`), 200).body;
    expect(poNow).toMatchObject({ displayStatus: 'ordered' });
    expect(poNow.lines[0]).toMatchObject({ receivedQty: 0, openQty: 5 });

    // 引当済みの数量を下回る取消は拒否
    const rec2 = await receive(c, locs['A-04']!, A, 3);
    await allocatedOrder(c, s.channelId, 'RV-1', [{ sku: 'SKU-A', quantity: 13 }]);
    const mv2 = (await movementsOf(c, A)).find((m) => m.type === 'receipt' && m.locationCode === 'A-04')!;
    const insuff = await c.post(`/api/inventory/movements/${mv2.id}/reverse`, { reason: 'x' });
    expectStatus(insuff, 409);
    expect(insuff.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(rec2).toBeTruthy();
    // 出荷由来などは取り消せない
    mv = (await movementsOf(c, A)).find((m) => m.type === 'reversal')!;
    expect(mv.reversible).toBe(false);
    await expectIntegrity(env, s.orgId);
  });
});
