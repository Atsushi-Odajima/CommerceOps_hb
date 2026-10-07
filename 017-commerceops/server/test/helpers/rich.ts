import { randomUUID } from 'node:crypto';
import { expectStatus, type TestEnv } from './env.js';
import { addMember, type TestUser } from './factory.js';
import {
  allocatedOrder,
  importCsv,
  locationsOf,
  manualOrder,
  orderDetail,
  orderRow,
  packFulfillment,
  receive,
  setupBasicOrg,
  shipReadyOrder,
  stdCsv,
  uploadFile,
  waveAndPickAll,
} from './scenario.js';

/** 1x1 PNG（返品検品写真用） */
export const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082',
  'hex',
);

export interface RichOrg extends Awaited<ReturnType<typeof setupBasicOrg>> {
  manager: TestUser;
  picker: TestUser;
  packer: TestUser;
  support: TestUser;
  /** 個人情報として扱う文字列（監査ログ・ログ・他組織の応答に出てはいけない） */
  pii: { name: string; email: string; phone: string; address: string };
  ids: Record<string, string>;
}

/**
 * バックアップ/復元・テナント分離テスト用: 業務テーブルをすべて使う組織を作る。
 * 取込・一括引当・通常出荷・返品（Restock/Damaged・写真）・交換（交換品の出荷まで）・一部引当 + 先行出荷・保留・取消・住所変更・
 * Short Pick・例外の割当/コメント・顧客マスター変更・招待
 */
export async function richOrg(env: TestEnv, marker = 'PIIMARK'): Promise<RichOrg> {
  const s = await setupBasicOrg(env, { warehouses: ['TKY', 'OSK'], skus: ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D'] });
  const c = s.owner.client;
  const TKY = s.warehouses.TKY!;
  const OSK = s.warehouses.OSK!;
  const tky = await locationsOf(c, TKY);
  const osk = await locationsOf(c, OSK);
  await receive(c, tky['A-01']!, s.products['SKU-A']!, 30);
  await receive(c, tky['A-02']!, s.products['SKU-B']!, 30);
  await receive(c, tky['A-03']!, s.products['SKU-C']!, 2);
  await receive(c, osk['A-01']!, s.products['SKU-D']!, 2);
  const manager = await addMember(env, s.orgId, 'ops_manager');
  const picker = await addMember(env, s.orgId, 'picker');
  const packer = await addMember(env, s.orgId, 'packer');
  const support = await addMember(env, s.orgId, 'support');
  const pii = {
    name: `${marker} 花子`,
    email: `${marker.toLowerCase()}.hanako@example.test`,
    phone: '090-9876-5432',
    address: `東京都渋谷区${marker}町1-2-3`,
  };
  const piiRow = { 購入者名: pii.name, 送付先氏名: pii.name, 購入者メール: pii.email, 購入者電話: pii.phone, 送付先電話: pii.phone, 住所1: pii.address };
  const ids: Record<string, string> = {};

  // 1) CSV 取込 → 一括引当（allocation_runs）
  const imp = await importCsv(c, s.profileId, stdCsv([orderRow('IMP-1', 'SKU-A', 1, piiRow), orderRow('IMP-2', 'SKU-B', 2, piiRow)]));
  ids.importBatchId = imp.preview.batchId;
  expectStatus(await c.post('/api/allocation/run-now', {}), 200);

  // 2) 通常出荷
  const full = await shipReadyOrder({ owner: s.owner, channelId: s.channelId, warehouseId: TKY }, 'FULL-1', [
    { sku: 'SKU-A', quantity: 2 },
    { sku: 'SKU-B', quantity: 1 },
  ]);
  for (const [i, sh] of full.shipments.entries()) {
    expectStatus(await c.patch(`/api/shipments/${sh.id}`, { carrier: 'yamato', trackingNumber: `FULL1000${i}` }), 200);
    expectStatus(await c.post(`/api/shipments/${sh.id}/confirm`, {}), 200);
  }
  const fullDetail = await orderDetail(c, full.order.id);
  ids.orderId = full.order.id;
  ids.orderItemId = fullDetail.items.find((i: any) => i.sku === 'SKU-A').id;
  ids.fulfillmentId = full.fulfillmentIds[0]!;
  ids.shipmentId = full.shipments[0]!.id;
  ids.customerId = fullDetail.customerId;

  // 3) 返品（到着・写真・Restock/Damaged）→ 交換品を通常フローで出荷
  const ret = expectStatus(
    await support.client.post('/api/returns', { orderId: full.order.id, reasonCode: 'defective', items: [{ orderItemId: ids.orderItemId, qty: 2 }], customerNote: '初期不良' }),
    200,
  ).body;
  ids.returnId = ret.id;
  expectStatus(await support.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
  const retDetail = expectStatus(await c.get(`/api/returns/${ret.id}`), 200).body;
  ids.returnItemId = retDetail.items[0].id;
  expectStatus(await packer.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: TKY, items: [{ returnItemId: ids.returnItemId, receivedQty: 2 }] }), 200);
  const photo = await uploadFile(c, `/api/returns/${ret.id}/attachments`, {}, PNG_1PX, 'damage.png');
  if (photo.status !== 200) throw new Error(`photo upload failed ${photo.status} ${photo.text}`);
  ids.attachmentId = photo.body.id;
  expectStatus(
    await c.post(`/api/returns/${ret.id}/inspect`, {
      clientRequestId: randomUUID(),
      lines: [
        { returnItemId: ids.returnItemId, disposition: 'restock', qty: 1 },
        { returnItemId: ids.returnItemId, disposition: 'damaged', qty: 1, reason: '外箱破損' },
      ],
      attachmentIds: [ids.attachmentId],
    }),
    200,
  );
  const ex = expectStatus(
    await support.client.post(`/api/returns/${ret.id}/exchange`, { items: [{ sku: 'SKU-A', quantity: 1, originalOrderItemId: ids.orderItemId }], note: '同一品で交換' }),
    200,
  ).body;
  ids.exchangeId = ex.exchangeId;
  ids.replacementOrderId = ex.replacementOrderId;
  const rep = await orderDetail(c, ex.replacementOrderId);
  await waveAndPickAll(c, TKY, [rep.fulfillments[0].id]);
  const repPack = await packFulfillment(c, rep.fulfillments[0].id);
  expectStatus(await c.patch(`/api/shipments/${repPack.shipments[0]!.id}`, { carrier: 'sagawa', trackingNumber: 'EXCH0001' }), 200);
  expectStatus(await c.post(`/api/shipments/${repPack.shipments[0]!.id}/confirm`, {}), 200);
  ids.packSessionId = repPack.sessionId;

  // 4) 一部引当 → 揃った分を先行出荷（partially_shipped）→ 欠品例外を割当・コメント
  const part = await allocatedOrder(
    c,
    s.channelId,
    'PART-1',
    [
      { sku: 'SKU-A', quantity: 1 },
      { sku: 'SKU-C', quantity: 5 },
    ],
    { expect: 'partial', warehouseId: TKY },
  );
  const rel = expectStatus(await c.post(`/api/orders/${part.id}/release`, {}), 200).body;
  const w = await waveAndPickAll(c, TKY, rel.fulfillmentIds);
  ids.waveId = w.waveId;
  ids.pickTaskId = expectStatus(await c.get(`/api/waves/${w.waveId}`), 200).body.tasks[0].id;
  const partPack = await packFulfillment(c, rel.fulfillmentIds[0]);
  expectStatus(await c.patch(`/api/shipments/${partPack.shipments[0]!.id}`, { carrier: 'yamato', trackingNumber: 'PART0001' }), 200);
  expectStatus(await c.post(`/api/shipments/${partPack.shipments[0]!.id}/confirm`, {}), 200);
  const shortage = await env.tx(s.orgId, (tx) =>
    tx.maybeOne(`SELECT id FROM exception_cases WHERE organization_id = $1 AND order_id = $2 AND type = 'shortage'`, [s.orgId, part.id]),
  );
  if (!shortage) throw new Error('shortage exception was not created');
  ids.exceptionId = shortage.id;
  expectStatus(await c.post(`/api/exceptions/${shortage.id}/assign`, { userId: manager.userId }), 200);
  expectStatus(await manager.client.post(`/api/exceptions/${shortage.id}/comment`, { note: '仕入先に確認中' }), 200);

  // 5) 保留 / 6) 取消 / 7) 住所変更（履歴）
  const hold = await manualOrder(c, s.channelId, 'HOLD-1', [{ sku: 'SKU-B', quantity: 1 }]);
  expectStatus(await support.client.post(`/api/orders/${hold.id}/holds`, { reasonCode: 'customer_confirm', note: '色の確認待ち' }), 200);
  ids.holdOrderId = hold.id;
  ids.holdId = (await env.tx(s.orgId, (tx) => tx.one(`SELECT id FROM holds WHERE organization_id = $1 AND order_id = $2`, [s.orgId, hold.id]))).id;
  const cxl = await allocatedOrder(c, s.channelId, 'CXL-1', [{ sku: 'SKU-B', quantity: 1 }], { warehouseId: TKY });
  expectStatus(await c.post(`/api/orders/${cxl.id}/cancel`, { reason: '顧客都合', confirm: true }), 200);
  const addr = await manualOrder(c, s.channelId, 'ADDR-1', [{ sku: 'SKU-B', quantity: 1 }]);
  expectStatus(
    await support.client.put(`/api/orders/${addr.id}/address`, { name: pii.name, postalCode: '150-0002', address1: `${pii.address}-2`, phone: pii.phone, reason: '顧客から連絡' }),
    200,
  );

  // 8) Short Pick（大阪）
  await allocatedOrder(c, s.channelId, 'SHORT-1', [{ sku: 'SKU-D', quantity: 2 }], { warehouseId: OSK });
  const pvOsk = expectStatus(await c.post('/api/waves/preview', { warehouseId: OSK }), 200).body;
  const wOsk = expectStatus(await c.post('/api/waves', { warehouseId: OSK, fulfillmentIds: pvOsk.fulfillments.map((f: any) => f.id) }), 200).body;
  const tOsk = expectStatus(await c.get(`/api/waves/${wOsk.waveId}`), 200).body.tasks[0].id;
  const v = expectStatus(await picker.client.post(`/api/pick-tasks/${tOsk}/claim`), 200).body;
  expectStatus(
    await picker.client.post(`/api/pick-tasks/${tOsk}/short`, { clientEventId: randomUUID(), locationId: v.groups[0].locationId, productId: v.groups[0].productId, reasonCode: 'not_found' }),
    200,
  );

  // 9) 顧客マスター変更 / 10) 招待（未承諾）
  expectStatus(await c.patch(`/api/customers/${ids.customerId}`, { name: `${marker} 花子（更新）`, postalCode: '100-0001', address1: `千代田区${marker}1-1`, phone: '03-0000-0000' }), 200);
  ids.invitationId = expectStatus(await c.post('/api/users/invitations', { email: `${marker.toLowerCase()}.invitee@example.test`, role: 'picker' }), 200).body.id;

  // StockPilot 統合分: 仕入先・補充設定・発注（分納 + 打切り）・棚卸（差異あり）・誤登録の取消
  const sup = expectStatus(await c.post('/api/suppliers', { code: 'SUP-1', name: `${marker} 商事`, leadTimeDays: 5 }), 200).body;
  ids.supplierId = sup.id;
  expectStatus(
    await c.put(`/api/products/${s.products['SKU-C']}/replenishment`, { settings: { supplierId: sup.id, safetyStock: 2, reorderPoint: 5, targetStock: 20, orderMultiple: 5, minOrderQty: 0 } }),
    200,
  );
  const po = expectStatus(
    await c.post('/api/purchase-orders', { supplierId: sup.id, warehouseId: TKY, lines: [{ productId: s.products['SKU-C'], locationId: tky['A-05'], qty: 10 }] }),
    200,
  ).body;
  ids.purchaseOrderId = po.id;
  expectStatus(await c.post(`/api/purchase-orders/${po.id}/place`, {}), 200);
  expectStatus(await c.post(`/api/purchase-orders/${po.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: po.lines[0].id, qty: 6 }] }), 200);
  expectStatus(await c.post(`/api/purchase-orders/${po.id}/close`, { reason: '欠品のため打切り' }), 200);
  const st = expectStatus(await c.post('/api/stocktakes', { locationId: tky['A-05'] }), 200).body;
  ids.stocktakeId = st.id;
  ids.stocktakeLineId = st.lines[0].id;
  expectStatus(await c.put(`/api/stocktakes/${st.id}/lines/${st.lines[0].id}`, { countedQty: 5, reason: '破損1個', version: st.lines[0].version }), 200);
  expectStatus(await c.post(`/api/stocktakes/${st.id}/review`, {}), 200);
  expectStatus(await c.post(`/api/stocktakes/${st.id}/confirm`, {}), 200);
  const mistaken = expectStatus(await c.post('/api/inventory/receipts', { locationId: tky['A-04'], productId: s.products['SKU-B'], qty: 3, requestId: randomUUID() }), 200).body;
  const mv = (await env.tx(s.orgId, (tx) => tx.one(`SELECT id FROM inventory_movements WHERE organization_id = $1 AND balance_id = $2 ORDER BY id DESC LIMIT 1`, [s.orgId, mistaken.balance.id]))).id;
  ids.movementId = mv;
  expectStatus(await c.post(`/api/inventory/movements/${mv}/reverse`, { reason: '入力ミス', requestId: randomUUID() }), 200);

  ids.productId = s.products['SKU-A']!;
  ids.warehouseId = TKY;
  ids.locationId = tky['A-01']!;
  ids.channelId = s.channelId;
  ids.profileId = s.profileId;
  ids.barcodeId = (await env.tx(s.orgId, (tx) => tx.one(`SELECT id FROM product_barcodes WHERE organization_id = $1 AND product_id = $2`, [s.orgId, ids.productId]))).id;
  ids.userId = picker.userId;
  return { ...s, manager, picker, packer, support, pii, ids };
}
