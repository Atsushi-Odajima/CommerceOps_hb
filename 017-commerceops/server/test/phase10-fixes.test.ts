import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, type TestEnv } from './helpers/env.js';
import { availability, locationsOf, orderDetail, receive, setupBasicOrg, shipReadyOrder } from './helpers/scenario.js';
import { expectIntegrity } from './helpers/integrity.js';
import { exportOrganizationLines } from '../src/modules/backup/export.js';
import { linesFromGzipBuffer, verifyBackup } from '../src/modules/backup/restore.js';
import { MemoryStorage } from '../src/modules/attachments/storage.js';

/** Phase 10 のレビュー・負荷検証で見つけて直した挙動の回帰テスト */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('Phase10 fixes', () => {
  it('a late second parcel: a completed return counts only what arrived, so the rest can be returned later in a new return', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 10);
    const r = await shipReadyOrder(s, 'LATE-1', [{ sku: 'SKU-A', quantity: 2 }]);
    for (const [i, sh] of r.shipments.entries()) {
      expectStatus(await s.owner.client.patch(`/api/shipments/${sh.id}`, { carrier: 'yamato', trackingNumber: `LATE1${i}000000` }), 200);
      expectStatus(await s.owner.client.post(`/api/shipments/${sh.id}/confirm`, {}), 200);
    }
    const d = await orderDetail(s.owner.client, r.order.id);
    const itemId = d.items[0].id as string;
    // 2 個の返品申請 → 1 個だけ届いた → 検品して完了
    const ret = expectStatus(await s.owner.client.post('/api/returns', { orderId: r.order.id, reasonCode: 'size_issue', items: [{ orderItemId: itemId, qty: 2 }] }), 200).body;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/authorize`, {}), 200);
    const rd = expectStatus(await s.owner.client.get(`/api/returns/${ret.id}`), 200).body;
    expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: rd.items[0].id, receivedQty: 1 }] }), 200);
    // 進行中は申請数（2）で数えるので、同じ明細の追加返品はできない
    expect((await s.owner.client.post('/api/returns', { orderId: r.order.id, reasonCode: 'size_issue', items: [{ orderItemId: itemId, qty: 1 }] })).status).toBe(409);
    const done = expectStatus(await s.owner.client.post(`/api/returns/${ret.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: rd.items[0].id, disposition: 'restock', qty: 1 }] }), 200).body;
    expect(done.status).toBe('completed');
    // 完了後は届いた 1 個だけを返品済みとして数える → 後から届いた 1 個を新しい返品で受け付けられる（2 個目以上は不可）
    const returnable = expectStatus(await s.owner.client.get(`/api/orders/${r.order.id}/returnable`), 200).body;
    expect(returnable.items[0].returnableQty).toBe(1);
    expect((await s.owner.client.post('/api/returns', { orderId: r.order.id, reasonCode: 'size_issue', items: [{ orderItemId: itemId, qty: 2 }] })).status).toBe(409);
    const late = expectStatus(await s.owner.client.post('/api/returns', { orderId: r.order.id, reasonCode: 'size_issue', items: [{ orderItemId: itemId, qty: 1 }], internalNote: '2 個目が後から届いた' }), 200).body;
    expectStatus(await s.owner.client.post(`/api/returns/${late.id}/authorize`, {}), 200);
    const ld = expectStatus(await s.owner.client.get(`/api/returns/${late.id}`), 200).body;
    expectStatus(await s.owner.client.post(`/api/returns/${late.id}/receive`, { warehouseId: s.warehouseId, items: [{ returnItemId: ld.items[0].id, receivedQty: 1 }] }), 200);
    expectStatus(await s.owner.client.post(`/api/returns/${late.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: ld.items[0].id, disposition: 'restock', qty: 1 }] }), 200);
    expect((await availability(s.owner.client, s.products['SKU-A']!)).onHand).toBe(10); // 出荷 2 → 返品 1 + 1
    await expectIntegrity(env, s.orgId);
  });

  it('moving stock between sellable (pick) and quarantine/damaged locations requires a reason; the quantity limit is the movable stock', async () => {
    const s = await setupBasicOrg(env);
    const all = (expectStatus(await s.owner.client.get(`/api/warehouses/${s.warehouseId}/locations`), 200).body.items as any[]);
    const pick = all.find((l) => l.code === 'A-01').id;
    const pick2 = all.find((l) => l.code === 'A-02').id;
    const quarantine = all.find((l) => l.kind === 'quarantine').id;
    await receive(s.owner.client, pick, s.products['SKU-A']!, 5);
    const move = (from: string, to: string, qty: number, reason?: string) =>
      s.owner.client.post('/api/inventory/transfers', { fromLocationId: from, toLocationId: to, productId: s.products['SKU-A'], qty, reason, requestId: randomUUID() });
    // 販売可能 → 返品保留（売れる在庫が減る）: 理由なしは拒否
    const noReason = await move(pick, quarantine, 2);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    expectStatus(await move(pick, quarantine, 2, '外箱つぶれ・要確認'), 200);
    expect((await availability(s.owner.client, s.products['SKU-A']!)).available).toBe(3);
    // 返品保留 → 販売可能（再確認の結果）: 理由必須、移動できるのは保留中の 2 個まで
    expect((await move(quarantine, pick, 1)).status).toBe(400);
    expect((await move(quarantine, pick, 3, '再確認で問題なし')).status).toBe(409);
    expectStatus(await move(quarantine, pick, 2, '再確認で問題なし'), 200);
    expect((await availability(s.owner.client, s.products['SKU-A']!)).available).toBe(5);
    // 販売可能な棚どうしは理由不要
    expectStatus(await move(pick, pick2, 1), 200);
    // 監査ログには移動元・移動先の種類が残る（理由の本文は在庫移動の行に残る）
    const a = expectStatus(await s.owner.client.get('/api/audit?action=inventory.transfer&limit=10'), 200).body.items as any[];
    expect(a.some((x) => x.summary.includes('pick → quarantine'))).toBe(true);
    await expectIntegrity(env, s.orgId);
  });

  it('backup verify reports photos that were missing when the backup was made; a too-large file gives one clear error, not a bogus "truncated" one', async () => {
    const s = await setupBasicOrg(env);
    // 写真の記録はあるがファイルが保存先にない（DATA_DIR の指定違いを想定）
    await env.tx(s.orgId, (tx) =>
      tx.exec(
        `INSERT INTO attachments (organization_id, id, storage_key, filename, content_type, size_bytes, sha256, created_by)
         VALUES ($1, $2, $3, 'photo.jpg', 'image/jpeg', 10, $4, $5)`,
        [s.orgId, randomUUID(), `${randomUUID()}/${randomUUID()}`, 'a'.repeat(64), s.owner.userId],
      ),
    );
    const lines: string[] = [];
    let missing = -1;
    for await (const l of exportOrganizationLines(env.deps.pool, new MemoryStorage(), s.orgId, (x) => void (missing = x.missingFiles))) lines.push(l);
    expect(missing).toBe(1);
    const buf = gzipSync(Buffer.from(lines.join('')));
    const v = await verifyBackup(linesFromGzipBuffer(buf));
    expect(v.ok).toBe(true);
    expect(v.missingFiles).toBe(1);
    // 展開後の上限を小さくして検証 → 「上限を超えています」だけ（途中で切れたファイル扱いにしない）
    const small = await verifyBackup(linesFromGzipBuffer(buf, 200));
    expect(small.ok).toBe(false);
    expect(small.errors.some((e) => e.includes('上限を超えています'))).toBe(true);
    expect(small.errors.some((e) => e.includes('trailer'))).toBe(false);
  });
});
