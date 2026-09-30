import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { deriveOrderStatus, isAllowedTransition, type OrderFacts } from '../src/modules/orders/status.js';
import { createTestEnv, expectStatus, type TestEnv } from './helpers/env.js';
import { addMember } from './helpers/factory.js';
import { importCsv, orderRow, setupBasicOrg, STD_HEADERS, stdCsv, uploadFile } from './helpers/scenario.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const baseFacts: OrderFacts = {
  status: 'ready_for_allocation',
  cancelledAt: null,
  closedAt: null,
  validationErrorCount: 0,
  onHold: false,
  openReturn: false,
  effectiveQty: 3,
  shippedQty: 0,
  allocatedQty: 0,
  unreleasedQty: 0,
  fulfillmentStatuses: [],
};

describe('order status derivation & transitions (unit)', () => {
  it('derives allocation stages', () => {
    expect(deriveOrderStatus(baseFacts)).toBe('ready_for_allocation');
    expect(deriveOrderStatus({ ...baseFacts, allocatedQty: 2 })).toBe('partially_allocated');
    expect(deriveOrderStatus({ ...baseFacts, allocatedQty: 3, unreleasedQty: 3 })).toBe('allocated');
    expect(deriveOrderStatus({ ...baseFacts, allocatedQty: 3, fulfillmentStatuses: ['ready'] })).toBe('allocated');
  });
  it('uses the least advanced fulfillment stage', () => {
    expect(deriveOrderStatus({ ...baseFacts, allocatedQty: 3, fulfillmentStatuses: ['packed', 'picking'] })).toBe('picking');
    expect(deriveOrderStatus({ ...baseFacts, allocatedQty: 3, fulfillmentStatuses: ['packed'] })).toBe('packed');
  });
  it('shipment and precedence rules', () => {
    expect(deriveOrderStatus({ ...baseFacts, shippedQty: 1, allocatedQty: 0 })).toBe('partially_shipped');
    expect(deriveOrderStatus({ ...baseFacts, shippedQty: 3 })).toBe('shipped');
    expect(deriveOrderStatus({ ...baseFacts, shippedQty: 3, openReturn: true })).toBe('return_in_progress');
    expect(deriveOrderStatus({ ...baseFacts, onHold: true, allocatedQty: 3 })).toBe('on_hold');
    expect(deriveOrderStatus({ ...baseFacts, validationErrorCount: 1 })).toBe('validation_required');
    expect(deriveOrderStatus({ ...baseFacts, effectiveQty: 0 })).toBe('cancelled');
  });
  it('transition table', () => {
    expect(isAllowedTransition(null, 'imported')).toBe(true);
    expect(isAllowedTransition('imported', 'ready_for_allocation')).toBe(true);
    expect(isAllowedTransition('allocated', 'picking')).toBe(true);
    expect(isAllowedTransition('picking', 'partially_allocated')).toBe(true); // Short Pick 差戻し
    expect(isAllowedTransition('packing', 'picked')).toBe(true); // 梱包セッション取消
    expect(isAllowedTransition('partially_shipped', 'allocated')).toBe(false); // 出荷後は出荷前段階へ戻らない
    expect(isAllowedTransition('shipped', 'cancelled')).toBe(false); // 出荷済みは単純取消しない
    expect(isAllowedTransition('partially_shipped', 'cancelled')).toBe(false);
    expect(isAllowedTransition('cancelled', 'ready_for_allocation')).toBe(false);
    expect(isAllowedTransition('shipped', 'return_in_progress')).toBe(true);
    expect(isAllowedTransition('return_in_progress', 'shipped')).toBe(true);
    expect(isAllowedTransition('shipped', 'closed')).toBe(true);
    expect(isAllowedTransition('closed', 'return_in_progress')).toBe(true);
    expect(isAllowedTransition('picking', 'validation_required')).toBe(false);
  });
});

describe('CSV import', () => {
  it('preview → commit creates normalized orders with status history; multi-line grouping', async () => {
    const s = await setupBasicOrg(env);
    const csv = stdCsv([orderRow('W-1001', 'SKU-A', 2), orderRow('W-1001', 'SKU-B', 1), orderRow('W-1002', 'SKU-C', 1)]);
    const { preview, commit } = await importCsv(s.owner.client, s.profileId, csv);
    expect(preview.summary.byClass.new).toBe(2);
    expect(preview.summary.newQty).toBe(4);
    expect(commit.created).toBe(2);
    const list = expectStatus(await s.owner.client.get('/api/orders?q=W-1001'), 200).body;
    expect(list.total).toBe(1);
    const detail = expectStatus(await s.owner.client.get(`/api/orders/${list.items[0].id}`), 200).body;
    expect(detail.status).toBe('ready_for_allocation');
    expect(detail.items.map((i: any) => [i.sku, i.quantity])).toEqual([
      ['SKU-A', 2],
      ['SKU-B', 1],
    ]);
    expect(detail.shipTo).toMatchObject({ postalCode: '150-0001', prefecture: '東京都', address1: '渋谷区神宮前1-2-3' });
    expect(detail.statusHistory.map((h: any) => h.to)).toEqual(['imported', 'ready_for_allocation']);
    expect(detail.items[0].unitPrice).toBe(1200);
  });

  it('R19: same file cannot be imported twice; same orders in another file are not duplicated', async () => {
    const s = await setupBasicOrg(env);
    const csv = stdCsv([orderRow('D-1', 'SKU-A', 1), orderRow('D-2', 'SKU-B', 2)]);
    await importCsv(s.owner.client, s.profileId, csv);
    const again = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, csv);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_FILE');
    // 行順を変えた別ファイル（内容は同じ） + 新規 1 件
    const csv2 = stdCsv([orderRow('D-2', 'SKU-B', 2), orderRow('D-1', 'SKU-A', 1), orderRow('D-3', 'SKU-C', 1)]);
    const r = await importCsv(s.owner.client, s.profileId, csv2);
    expect(r.preview.summary.byClass).toMatchObject({ identical: 2, new: 1 });
    expect(r.commit).toMatchObject({ created: 1, skippedIdentical: 2 });
    const list = expectStatus(await s.owner.client.get('/api/orders?limit=50'), 200).body;
    expect(list.total).toBe(3);
  });

  it('R20: same externalOrderId with different content is detected (update candidate) and never silently overwritten', async () => {
    const s = await setupBasicOrg(env);
    await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('U-1', 'SKU-A', 1)]));
    const changed = stdCsv([orderRow('U-1', 'SKU-A', 3, { 住所1: '東京都港区芝公園4-2-8' })]);
    const pv = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, changed);
    expect(pv.body.summary.byClass.update_candidate).toBe(1);
    const rows = expectStatus(await s.owner.client.get(`/api/imports/${pv.body.batchId}/orders`), 200).body.items;
    expect(rows[0].changed).toEqual(expect.arrayContaining(['送付先', '明細']));
    // 適用を選ばなければ更新しない
    const c1 = expectStatus(await s.owner.client.post(`/api/imports/${pv.body.batchId}/commit`, { applyUpdateIds: [] }), 200).body;
    expect(c1).toMatchObject({ updated: 0, skippedUpdateNotApplied: 1 });
    const o1 = (await s.owner.client.get('/api/orders?q=U-1')).body.items[0];
    expect(o1.totalQty).toBe(1);
    // 適用を選ぶと更新（住所変更は履歴に残る）
    const changed2 = stdCsv([orderRow('U-1', 'SKU-A', 3, { 住所1: '東京都港区芝公園4-2-8', 備考: '再送' })]);
    const pv2 = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, changed2);
    const rows2 = expectStatus(await s.owner.client.get(`/api/imports/${pv2.body.batchId}/orders`), 200).body.items;
    const c2 = expectStatus(await s.owner.client.post(`/api/imports/${pv2.body.batchId}/commit`, { applyUpdateIds: [rows2[0].id] }), 200).body;
    expect(c2.updated).toBe(1);
    const d = expectStatus(await s.owner.client.get(`/api/orders/${o1.id}`), 200).body;
    expect(d.totalQty).toBe(3);
    expect(d.shipTo.address1).toBe('港区芝公園4-2-8');
    expect(d.addressHistory).toHaveLength(1);
  });

  it('cancel flag in source never auto-cancels: creates an import_conflict exception', async () => {
    const s = await setupBasicOrg(env);
    // キャンセル列をマッピングしたプロファイル
    const prof = expectStatus(await s.owner.client.get(`/api/import-profiles/${s.profileId}`), 200).body;
    const mapping = { ...prof.mapping, cancelFlag: { source: { column: '備考' }, transforms: [{ op: 'map', table: { キャンセル: 'true' }, fallback: 'false' }] } };
    expectStatus(await s.owner.client.patch(`/api/import-profiles/${s.profileId}`, { mapping }), 200);
    await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('C-1', 'SKU-A', 1)]));
    const r = await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('C-1', 'SKU-A', 1, { 備考: 'キャンセル' })]));
    expect(r.preview.summary.byClass.cancel_candidate).toBe(1);
    expect(r.commit.cancelCandidates).toBe(1);
    const o = (await s.owner.client.get('/api/orders?q=C-1')).body.items[0];
    expect(o.status).toBe('ready_for_allocation');
    const d = (await s.owner.client.get(`/api/orders/${o.id}`)).body;
    expect(d.exceptions[0]).toMatchObject({ type: 'import_conflict', status: 'open' });
  });

  it('validation: unknown SKU → validation_required (remap fixes it); missing qty → invalid; inconsistent rows → invalid', async () => {
    const s = await setupBasicOrg(env);
    const csv = stdCsv([
      orderRow('V-1', 'NO-SUCH-SKU', 1),
      orderRow('V-2', 'SKU-A', 0),
      orderRow('V-3', 'SKU-A', 1),
      orderRow('V-3', 'SKU-B', 1, { 郵便番号: '1600022' }),
      orderRow('V-4', 'SKU-A', 1, { 郵便番号: '12345' }),
    ]);
    const pv = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, csv);
    expect(pv.status).toBe(200);
    expect(pv.body.summary.byClass).toMatchObject({ new: 2, invalid: 2 });
    const cm = expectStatus(await s.owner.client.post(`/api/imports/${pv.body.batchId}/commit`, {}), 200).body;
    expect(cm).toMatchObject({ created: 2, createdValidationRequired: 2, invalidSkipped: 2 });
    const v1 = (await s.owner.client.get('/api/orders?q=V-1')).body.items[0];
    expect(v1.status).toBe('validation_required');
    const d = (await s.owner.client.get(`/api/orders/${v1.id}`)).body;
    expect(d.validationErrors[0].code).toBe('UNKNOWN_SKU');
    expectStatus(await s.owner.client.post(`/api/orders/${v1.id}/items/${d.items[0].id}/remap`, { productId: s.products['SKU-C'] }), 200);
    const d2 = (await s.owner.client.get(`/api/orders/${v1.id}`)).body;
    expect(d2.status).toBe('ready_for_allocation');
    expect(d2.items[0].sku).toBe('NO-SUCH-SKU'); // 原文 SKU は保持
    // 郵便番号不正 → 住所変更で解消
    const v4 = (await s.owner.client.get('/api/orders?q=V-4')).body.items[0];
    expect(v4.status).toBe('validation_required');
    const r = expectStatus(
      await s.owner.client.put(`/api/orders/${v4.id}/address`, { name: '山田 太郎', postalCode: '150-0001', address1: '東京都渋谷区神宮前1-2-3', reason: '顧客に確認済み' }),
      200,
    ).body;
    expect(r.status).toBe('ready_for_allocation');
  });

  it('Shift_JIS profile imports CP932 files; UTF-8 profile rejects them with a clear message', async () => {
    const s = await setupBasicOrg(env);
    const text = [STD_HEADERS.join(','), '髙-1,2026-09-30 10:00:00,髙橋 ①子,,,髙橋 ①子,1500001,,,東京都渋谷区1-1,,,,,SKU-A,商品,1,100'].join('\r\n');
    const buf = iconv.encode(text, 'cp932');
    const bad = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, buf);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('ENCODING_MISMATCH');
    expectStatus(await s.owner.client.patch(`/api/import-profiles/${s.profileId}`, { encoding: 'shift_jis' }), 200);
    const r = await importCsv(s.owner.client, s.profileId, buf);
    expect(r.commit.created).toBe(1);
    const o = (await s.owner.client.get(`/api/orders?q=${encodeURIComponent('髙-1')}`)).body.items[0];
    expect(o.recipientName).toBe('髙橋 ①子');
  });

  it('failed commit leaves existing data untouched; two concurrent commits never duplicate an order', async () => {
    const s = await setupBasicOrg(env);
    // 同じ注文を含む 2 つの異なるファイルを同時に確定
    const a = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, stdCsv([orderRow('R-1', 'SKU-A', 1), orderRow('R-2', 'SKU-A', 1)]));
    const b = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, stdCsv([orderRow('R-2', 'SKU-A', 1), orderRow('R-1', 'SKU-A', 1), orderRow('R-3', 'SKU-B', 1)]));
    const [ca, cb] = await Promise.all([
      s.owner.client.post(`/api/imports/${a.body.batchId}/commit`, {}),
      s.owner.client.post(`/api/imports/${b.body.batchId}/commit`, {}),
    ]);
    expect(ca.status).toBe(200);
    expect(cb.status).toBe(200);
    expect(ca.body.created + cb.body.created).toBe(3);
    const list = (await s.owner.client.get('/api/orders?limit=50')).body;
    expect(list.total).toBe(3);
    // 期限切れ・取消済みのバッチは確定不可
    const c = await uploadFile(s.owner.client, '/api/imports/preview', { profileId: s.profileId }, stdCsv([orderRow('R-9', 'SKU-A', 1)]));
    expectStatus(await s.owner.client.post(`/api/imports/${c.body.batchId}/cancel`, {}), 200);
    expect((await s.owner.client.post(`/api/imports/${c.body.batchId}/commit`, {})).status).toBe(409);
    expect((await s.owner.client.get('/api/orders?q=R-9')).body.total).toBe(0);
    // 確定の再送は冪等
    const again = expectStatus(await s.owner.client.post(`/api/imports/${a.body.batchId}/commit`, {}), 200).body;
    expect(again.alreadyCommitted).toBe(true);
  });

  it('R21: editing the customer master does not change past order shipping snapshots', async () => {
    const s = await setupBasicOrg(env);
    await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('S-1', 'SKU-A', 1)]));
    const o = (await s.owner.client.get('/api/orders?q=S-1')).body.items[0];
    const d = (await s.owner.client.get(`/api/orders/${o.id}`)).body;
    expect(d.customerId).toBeTruthy();
    expectStatus(
      await s.owner.client.patch(`/api/customers/${d.customerId}`, { name: '山田 花子', postalCode: '100-0001', address1: '千代田区千代田1-1', phone: '03-0000-0000' }),
      200,
    );
    const cust = expectStatus(await s.owner.client.get(`/api/customers/${d.customerId}`), 200).body;
    expect(cust.name).toBe('山田 花子');
    const d2 = (await s.owner.client.get(`/api/orders/${o.id}`)).body;
    expect(d2.shipTo).toEqual(d.shipTo);
    expect(d2.customer).toEqual(d.customer);
    // 次の取込で同じ顧客（メール一致）でもマスターは上書きしない
    await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('S-2', 'SKU-A', 1)]));
    expect(expectStatus(await s.owner.client.get(`/api/customers/${d.customerId}`), 200).body.name).toBe('山田 花子');
  });

  it('holds: reason required for other, history kept, fulfillments excluded; manual order creation', async () => {
    const s = await setupBasicOrg(env);
    const created = expectStatus(
      await s.owner.client.post('/api/orders', {
        channelId: s.channelId,
        order: {
          externalOrderId: 'TEL-001',
          customer: { name: '電話 注文' },
          shipTo: { name: '電話 注文', postalCode: '530-0001', address1: '大阪府大阪市北区梅田1-1' },
          lines: [{ sku: 'SKU-A', quantity: 2 }],
        },
      }),
      200,
    ).body;
    expect(created.status).toBe('ready_for_allocation');
    expect((await s.owner.client.post(`/api/orders/${created.id}/holds`, { reasonCode: 'other' })).status).toBe(400);
    const h = expectStatus(await s.owner.client.post(`/api/orders/${created.id}/holds`, { reasonCode: 'address_check', note: '番地不足' }), 200).body;
    expect(h.status).toBe('on_hold');
    const r = expectStatus(await s.owner.client.post(`/api/orders/${created.id}/holds/${h.holdId}/release`, { note: '確認済' }), 200).body;
    expect(r.status).toBe('ready_for_allocation');
    const d = (await s.owner.client.get(`/api/orders/${created.id}`)).body;
    expect(d.holds[0]).toMatchObject({ reasonCode: 'address_check', note: '番地不足', releaseNote: '確認済' });
    expect(d.statusHistory.map((x: any) => x.to)).toEqual(['imported', 'ready_for_allocation', 'on_hold', 'ready_for_allocation']);
    expect(d.shipTo.prefecture).toBe('大阪府');
  });

  it('RBAC: support can read orders (with PII) but cannot import; picker cannot read orders at all', async () => {
    const s = await setupBasicOrg(env);
    await importCsv(s.owner.client, s.profileId, stdCsv([orderRow('P-1', 'SKU-A', 1)]));
    const support = await addMember(env, s.orgId, 'support');
    const picker = await addMember(env, s.orgId, 'picker');
    const list = expectStatus(await support.client.get('/api/orders?q=P-1'), 200).body;
    expect(list.items[0].customerName).toBe('山田 太郎');
    const pv = await uploadFile(support.client, '/api/imports/preview', { profileId: s.profileId }, stdCsv([orderRow('P-2', 'SKU-A', 1)]));
    expect(pv.status).toBe(403);
    expect((await picker.client.get('/api/orders')).status).toBe(403);
    expect((await picker.client.get(`/api/orders/${list.items[0].id}`)).status).toBe(403);
    // 顧客名での検索（read_pii）
    expect(expectStatus(await support.client.get(`/api/orders?q=${encodeURIComponent('山田')}`), 200).body.total).toBe(1);
  });
});
