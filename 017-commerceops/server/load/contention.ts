/**
 * 同時実行（競合）の検証: 多数の作業者が同じ注文・在庫・Wave・タスク・梱包・荷物・返品へ「同時に」操作し、
 * 再送（同じ冪等キーの同時送信）も混ぜて、過剰引当・二重投入・二重 claim・二重計上・二重減算・二重 Restock が起きず、
 * 整合性チェックが通ることを実 API（認可・検証・トランザクション・RLS を含む）で確かめる。本番ビルドには含まれない。
 *
 *   npx tsx load/contention.ts [--db postgres://.../commerceops_load] [--orders 300] [--workers 16] [--tag v1]
 * 結果は load/results/contention-<tag>.json。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SYSTEM_ACTOR, withTenant } from '../src/db/tx.js';
import { checkIntegrity } from '../src/modules/integrity/check.js';
import { addUser, Client, createLoadEnv, csvOf, fakeOrderRows, newOrg, rng, round, Timings } from './lib.js';
import { setupMaster } from './flow.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: process.env.LOAD_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_load' },
    orders: { type: 'string', default: '300' },
    workers: { type: 'string', default: '16' },
    tag: { type: 'string', default: '' },
  },
});
const N = Number(values.orders);
const W = Number(values.workers);

const env = await createLoadEnv(values.db!, 32);
const timings = new Timings();
const outcomes: Record<string, Record<string, number>> = {};
const serverErrors: string[] = [];
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const steps: Record<string, number> = {};

/** 応答を「ok / 409 CODE / 422 CODE ...」で数える（5xx は失敗として記録） */
async function call(c: Client, step: string, method: string, url: string, body?: unknown) {
  const r = await c.request(method, url, body, step);
  const key = r.status >= 200 && r.status < 300 ? 'ok' : `${r.status} ${r.body?.error?.code ?? ''}`.trim();
  const o = (outcomes[step] ??= {});
  o[key] = (o[key] ?? 0) + 1;
  if (r.status >= 500) serverErrors.push(`${step}: ${method} ${url} → ${r.status} ${r.text.slice(0, 200)}`);
  return r;
}
async function pool<T>(items: T[], workers: number, fn: (item: T, w: number) => Promise<unknown>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, async (_, w) => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        await fn(items[idx]!, w);
      }
    }),
  );
}
async function step<T>(name: string, fn: () => Promise<T>) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    steps[name] = round(performance.now() - t0, 0);
    console.log(`${name}: ${steps[name]}ms ${JSON.stringify(outcomes)}`);
  }
}
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? 'OK ' : 'NG '} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
}

const out: any = { createdAt: new Date().toISOString(), orders: N, workers: W };
try {
  const stamp = Date.now().toString(36);
  const { orgId, owner } = await newOrg(env, `競合検証 ${stamp}`, `contention-${stamp}@example.invalid`, timings);
  const q = <R = any>(sql: string, params: unknown[] = []) => withTenant(env.pool, orgId, SYSTEM_ACTOR, (tx) => tx.many<R>(sql, [orgId, ...params]));
  // 10 SKU（うち 3 SKU は東京に 3 個だけ = 激しい取り合い）。需要は在庫を上回る
  const master = await setupMaster(owner, { skus: 10, stockPerSku: 60, scarceSkus: 3 });
  const pickers = await Promise.all(Array.from({ length: 8 }, (_, i) => addUser(env, orgId, `cpick${i}-${stamp}@example.invalid`, 'picker', timings)));
  const packers = await Promise.all(Array.from({ length: 8 }, (_, i) => addUser(env, orgId, `cpack${i}-${stamp}@example.invalid`, 'packer', timings)));
  const managers = await Promise.all(Array.from({ length: 3 }, (_, i) => addUser(env, orgId, `cmgr${i}-${stamp}@example.invalid`, 'ops_manager', timings)));
  const r = rng(17);
  const ext = `CT-${stamp}-`;
  const rows = Array.from({ length: N }, (_, i) => fakeOrderRows(`${ext}${String(i + 1).padStart(5, '0')}`, master.skus, r, '2026-09-30 09:00:00')).flat();
  const pv = await owner.upload('/api/imports/preview', { profileId: master.profileIds[0]! }, csvOf(rows), `${ext}.csv`);
  await owner.post(`/api/imports/${pv.batchId}/commit`, { applyUpdateIds: [] });
  const orders: { id: string; orderNumber: string }[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await owner.get(`/api/orders?limit=200&offset=${offset}&q=${encodeURIComponent(ext)}`);
    orders.push(...page.items);
    if (page.items.length < 200) break;
  }
  out.importedOrders = orders.length;
  out.importedLines = rows.length;
  const demand = await q<{ sku: string; qty: number }>(`SELECT sku, SUM(quantity)::int AS qty FROM order_items WHERE organization_id = $1 GROUP BY sku ORDER BY sku`);
  const stock = await q<{ sku: string; qty: number }>(
    `SELECT p.sku, SUM(b.on_hand)::int AS qty FROM inventory_balances b JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id WHERE b.organization_id = $1 GROUP BY p.sku ORDER BY p.sku`,
  );
  out.demandVsStock = demand.map((d) => ({ sku: d.sku, demand: d.qty, stock: stock.find((s) => s.sku === d.sku)?.qty ?? 0 }));

  // 1) 引当: 一括引当 3 本 + 注文ごとの引当（全注文を W 並列）+ 取消 30 件 を同時に
  const cancelIds = new Set(orders.filter(() => r() < 30 / N).map((o) => o.id));
  await step('1_allocation_race', () =>
    Promise.all([
      ...[0, 1, 2].map((i) => call(managers[i]!, 'allocation.run_now', 'POST', '/api/allocation/run-now', {})),
      pool(orders, W, (o, w) => call(w % 2 ? owner : managers[w % 3]!, 'orders.allocate', 'POST', `/api/orders/${o.id}/allocate`, {})),
      pool([...cancelIds], 4, (id) => call(managers[0]!, 'orders.cancel', 'POST', `/api/orders/${id}/cancel`, { reason: '競合検証', confirm: true })),
    ]),
  );
  // 取消がすべて引当より先に終わると取消の競合にならないので、引当済みになった注文の取消も同時に
  const late = (await q<{ id: string }>(`SELECT id FROM orders WHERE organization_id = $1 AND status = 'allocated' ORDER BY random() LIMIT 10`)).map((x) => x.id);
  await step('1b_cancel_vs_allocation_run', () =>
    Promise.all([
      call(managers[1]!, 'allocation.run_now', 'POST', '/api/allocation/run-now', {}),
      pool(late, 5, (id) => call(managers[2]!, 'orders.cancel', 'POST', `/api/orders/${id}/cancel`, { reason: '競合検証（引当済み）', confirm: true })),
    ]),
  );
  {
    const bad = await q(`SELECT id, on_hand, allocated, held FROM inventory_balances WHERE organization_id = $1 AND (allocated < 0 OR allocated > on_hand - held OR on_hand < 0)`);
    check('引当: どの棚でも Allocated ≤ OnHand − 調査中（過剰引当なし）', bad.length === 0, bad.slice(0, 5));
    const over = await q(
      `SELECT p.sku, SUM(a.quantity - a.shipped_qty - a.released_qty)::int AS open, (SELECT SUM(on_hand)::int FROM inventory_balances b WHERE b.organization_id = $1 AND b.product_id = p.id) AS on_hand
         FROM allocations a JOIN products p ON p.organization_id = a.organization_id AND p.id = a.product_id
        WHERE a.organization_id = $1 AND a.status = 'active' GROUP BY p.id, p.sku HAVING SUM(a.quantity - a.shipped_qty - a.released_qty) > (SELECT SUM(on_hand) FROM inventory_balances b WHERE b.organization_id = $1 AND b.product_id = p.id)`,
    );
    check('引当: SKU ごとの引当合計 ≤ 在庫合計（最後の数個の取り合いでも超えない）', over.length === 0, over);
    const cancelledWithAlloc = await q(
      `SELECT o.order_number FROM orders o WHERE o.organization_id = $1 AND o.status = 'cancelled'
          AND EXISTS (SELECT 1 FROM allocations a WHERE a.organization_id = o.organization_id AND a.order_id = o.id AND a.status = 'active' AND a.quantity - a.shipped_qty - a.released_qty > 0)`,
    );
    check('引当: 取消した注文に有効な引当が残らない（取消と引当の同時実行）', cancelledWithAlloc.length === 0, cancelledWithAlloc);
    const itemMismatch = await q(
      `SELECT oi.id FROM order_items oi WHERE oi.organization_id = $1
          AND oi.allocated_qty <> COALESCE((SELECT SUM(a.quantity - a.shipped_qty - a.released_qty) FROM allocations a WHERE a.organization_id = oi.organization_id AND a.order_item_id = oi.id AND a.status = 'active'), 0)`,
    );
    check('引当: 注文明細の引当数 = 有効な引当（未出荷・未解放）の合計', itemMismatch.length === 0, itemMismatch.slice(0, 5));
    out.afterAllocation = (await q(`SELECT status, count(*)::int AS n FROM orders WHERE organization_id = $1 GROUP BY status ORDER BY status`)).reduce((m: any, x: any) => ({ ...m, [x.status]: x.n }), {});
  }

  // 2) Wave: 2 人の管理者が同じ Fulfillment 群で同時に Wave を作る → どちらか一方だけ
  const waveIds: string[] = [];
  await step('2_wave_race', async () => {
    for (const wh of master.warehouses) {
      const pvw = await owner.post('/api/waves/preview', { warehouseId: wh.id });
      const ids: string[] = pvw.fulfillments.map((f: any) => f.id).filter(Boolean);
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const rs = await Promise.all([0, 1].map((m) => call(managers[m]!, 'waves.create', 'POST', '/api/waves', { warehouseId: wh.id, fulfillmentIds: chunk, splitMode: 'lines', linesPerTask: 8 })));
        const wins = rs.filter((x) => x.status === 200);
        if (wins.length !== 1) check(`Wave: 同じ対象での同時作成は 1 件だけ成功（${wh.code} ${i}）`, false, rs.map((x) => x.status));
        waveIds.push(...wins.map((x) => x.body.waveId));
      }
    }
  });
  {
    const dup = await q(`SELECT fulfillment_id FROM wave_fulfillments WHERE organization_id = $1 AND removed_at IS NULL GROUP BY fulfillment_id HAVING count(*) > 1`);
    check('Wave: 1 つの Fulfillment が 2 つの Wave に入らない', dup.length === 0 && waveIds.length > 0, { dup: dup.length, waves: waveIds.length });
  }

  // 3) Pick: 8 人が全タスクを同時に claim → 各タスク 1 人だけ。scan は同じ clientEventId で 2 回同時送信 + 超過 scan
  const tasks: string[] = [];
  for (const id of waveIds) tasks.push(...(await owner.get(`/api/waves/${id}`)).tasks.map((t: any) => t.id));
  const winner = new Map<string, Client>();
  await step('3_claim_race', () =>
    pool(tasks, 4, async (tid) => {
      const rs = await Promise.all(pickers.map((p) => call(p, 'pick.claim', 'POST', `/api/pick-tasks/${tid}/claim`, {}).then((x) => ({ p, x }))));
      const wins = rs.filter((y) => y.x.status === 200);
      if (wins.length !== 1) check(`Pick: 同時 claim は 1 人だけ（${tid}）`, false, rs.map((y) => y.x.status));
      else winner.set(tid, wins[0]!.p);
    }),
  );
  check('Pick: すべてのタスクで同時 claim の成功は 1 人だけ', winner.size === tasks.length, { tasks: tasks.length, claimed: winner.size });
  await step('3b_pick_resend', () =>
    pool(tasks, 8, async (tid) => {
      const p = winner.get(tid);
      if (!p) return;
      const v = (await call(p, 'pick.view', 'GET', `/api/pick-tasks/${tid}`)).body;
      for (const g of v.groups) {
        const need = g.required - g.picked - g.short;
        if (need <= 0) continue;
        await call(p, 'pick.scan_location', 'POST', `/api/pick-tasks/${tid}/scan-location`, { clientEventId: randomUUID(), code: g.locationBarcode ?? g.locationCode, expectedLocationId: g.locationId, inputMethod: 'scanner' });
        const body = { clientEventId: randomUUID(), locationId: g.locationId, code: g.barcodes[1] ?? g.sku, qty: need, inputMethod: 'scanner' };
        await Promise.all([call(p, 'pick.scan_item (再送含む)', 'POST', `/api/pick-tasks/${tid}/pick`, body), call(p, 'pick.scan_item (再送含む)', 'POST', `/api/pick-tasks/${tid}/pick`, body)]);
      }
      // 完了後の超過 scan は拒否される
      const g0 = v.groups[0];
      if (g0) await call(p, 'pick.over_scan', 'POST', `/api/pick-tasks/${tid}/pick`, { clientEventId: randomUUID(), locationId: g0.locationId, code: g0.barcodes[1] ?? g0.sku, qty: 1, inputMethod: 'scanner' });
    }),
  );
  {
    const lines = await q(`SELECT id, required_qty, picked_qty FROM pick_task_lines WHERE organization_id = $1 AND picked_qty <> required_qty AND status <> 'cancelled'`);
    check('Pick: 再送（同時）でも数量は二重加算されない（picked = required）', lines.length === 0, lines.slice(0, 5));
    const ev = await q(
      `SELECT l.id FROM pick_task_lines l WHERE l.organization_id = $1
          AND l.picked_qty <> COALESCE((SELECT SUM(e.qty) FROM pick_events e WHERE e.organization_id = l.organization_id AND e.pick_task_line_id = l.id AND e.event_type IN ('pick', 'correction')), 0)`,
    );
    check('Pick: タスク行の数量 = Pick イベントの合計', ev.length === 0, ev.slice(0, 5));
  }

  // 4) 梱包: 2 人の Packer が同じ Fulfillment を同時に開く → 1 人だけ。scan・完了も同じ冪等キーで同時再送
  const picked = (await q<{ id: string }>(`SELECT id FROM fulfillments WHERE organization_id = $1 AND status = 'picked' ORDER BY id`)).map((x) => x.id);
  const shipmentIds: string[] = [];
  await step('4_pack_race', () =>
    pool(picked, 4, async (fid, w) => {
      const pair = [packers[(2 * w) % 8]!, packers[(2 * w + 1) % 8]!];
      const rs = await Promise.all(pair.map((p) => call(p, 'pack.open', 'POST', '/api/pack/open', { fulfillmentId: fid }).then((x) => ({ p, x }))));
      const wins = rs.filter((y) => y.x.status === 200);
      if (wins.length !== 1) {
        check(`梱包: 同じ Fulfillment を同時に開けるのは 1 人（${fid}）`, false, rs.map((y) => y.x.status));
        if (!wins.length) return;
      }
      const { p, x } = wins[0]!;
      const sid = x.body.sessionId;
      const s = (await call(p, 'pack.view', 'GET', `/api/pack/sessions/${sid}`)).body;
      for (const it of s.items) {
        if (it.remaining <= 0) continue;
        const one = { clientEventId: randomUUID(), code: it.barcodes?.[0] ?? it.sku, inputMethod: 'scanner' };
        await Promise.all([call(p, 'pack.scan (再送含む)', 'POST', `/api/pack/sessions/${sid}/scan`, one), call(p, 'pack.scan (再送含む)', 'POST', `/api/pack/sessions/${sid}/scan`, one)]);
        if (it.remaining > 1) {
          const rest = { clientEventId: randomUUID(), code: it.sku, qty: it.remaining - 1, inputMethod: 'manual' };
          await Promise.all([call(p, 'pack.scan (再送含む)', 'POST', `/api/pack/sessions/${sid}/scan`, rest), call(p, 'pack.scan (再送含む)', 'POST', `/api/pack/sessions/${sid}/scan`, rest)]);
        }
      }
      const done = { requestId: randomUUID() };
      const cs = await Promise.all([0, 1].map(() => call(p, 'pack.complete (再送含む)', 'POST', `/api/pack/sessions/${sid}/complete`, done)));
      const ok = cs.find((c) => c.status === 200);
      if (ok) for (const sh of ok.body.shipments) if (!shipmentIds.includes(sh.id)) shipmentIds.push(sh.id);
    }),
  );
  {
    const bad = await q(
      `SELECT fi.id, fi.picked_qty, fi.packed_qty FROM fulfillment_items fi JOIN fulfillments f ON f.organization_id = fi.organization_id AND f.id = fi.fulfillment_id
        WHERE fi.organization_id = $1 AND f.id = ANY($2::uuid[]) AND fi.packed_qty <> fi.picked_qty`,
      [picked],
    );
    check('梱包: 再送（同時）でも梱包数は二重加算されない（packed = picked）', bad.length === 0, bad.slice(0, 5));
    const two = await q(`SELECT fulfillment_id FROM pack_sessions WHERE organization_id = $1 AND status = 'completed' GROUP BY fulfillment_id HAVING count(*) > 1`);
    check('梱包: 完了の同時再送で梱包セッション・荷物が二重に作られない', two.length === 0, two);
    const shipQty = await q(
      `SELECT fi.id FROM fulfillment_items fi WHERE fi.organization_id = $1 AND fi.fulfillment_id = ANY($2::uuid[])
          AND fi.packed_qty <> COALESCE((SELECT SUM(si.quantity) FROM shipment_items si JOIN shipments s ON s.organization_id = si.organization_id AND s.id = si.shipment_id
                                          WHERE si.organization_id = fi.organization_id AND si.fulfillment_item_id = fi.id AND s.status <> 'cancelled'), 0)`,
      [picked],
    );
    check('梱包: 荷物の数量 = 梱包数', shipQty.length === 0, shipQty.slice(0, 5));
  }

  // 5) 出荷確定: 1 荷物に 3 本同時 + 50 件ずつのまとめ確定も同時に
  await step('5_ship_race', async () => {
    let seq = 0;
    await pool(shipmentIds, 8, (sid) => call(owner, 'ship.tracking', 'PATCH', `/api/shipments/${sid}`, { carrier: 'yamato', trackingNumber: `9${stamp.replace(/\D/g, '').slice(0, 3)}${String(seq++).padStart(8, '0')}` }));
    const batches: string[][] = [];
    for (let i = 0; i < shipmentIds.length; i += 50) batches.push(shipmentIds.slice(i, i + 50));
    await Promise.all([
      pool(shipmentIds, 8, (sid, w) =>
        Promise.all([0, 1, 2].map((k) => call(k === 0 ? owner : managers[(w + k) % 3]!, 'ship.confirm (再送含む)', 'POST', `/api/shipments/${sid}/confirm`, {}))),
      ),
      pool(batches, 2, (b) => call(managers[2]!, 'ship.bulk_confirm', 'POST', '/api/shipments/bulk-confirm', { shipmentIds: b })),
    ]);
  });
  {
    const ship = await q(
      `SELECT (SELECT COALESCE(-SUM(on_hand_delta), 0)::int FROM inventory_movements WHERE organization_id = $1 AND movement_type = 'ship') AS decremented,
              (SELECT COALESCE(SUM(si.quantity), 0)::int FROM shipment_items si JOIN shipments s ON s.organization_id = si.organization_id AND s.id = si.shipment_id
                WHERE si.organization_id = $1 AND s.status = 'shipped') AS shipped_units,
              (SELECT count(*)::int FROM shipments WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'shipped') AS shipped`,
      [shipmentIds],
    );
    check('出荷: 同時確定・まとめ確定の重なりでも OnHand の減算は 1 回（減算数 = 出荷数量）', ship[0].decremented === ship[0].shipped_units && ship[0].shipped === shipmentIds.length, ship[0]);
    out.shipped = ship[0];
  }

  // 6) 返品: 同じ明細の全数返品を 2 本同時 → 1 本だけ。到着 2 本同時（冪等）→ 検品（Restock）を同じ clientRequestId で 3 本同時
  const shippedOrders = (await q<{ id: string }>(`SELECT id FROM orders WHERE organization_id = $1 AND status = 'shipped' ORDER BY random() LIMIT 40`)).map((x) => x.id);
  const beforeOnHand = (await q(`SELECT COALESCE(SUM(on_hand), 0)::int AS n FROM inventory_balances WHERE organization_id = $1`))[0].n;
  let expectedRestock = 0;
  await step('6_return_race', () =>
    pool(shippedOrders, 8, async (oid, w) => {
      const d = (await call(owner, 'orders.detail', 'GET', `/api/orders/${oid}`)).body;
      const it = d.items.find((y: any) => y.shippedQty > 0);
      if (!it) return;
      const req = { orderId: oid, reasonCode: 'size_issue', items: [{ orderItemId: it.id, qty: it.shippedQty }] };
      const rs = await Promise.all([owner, managers[w % 3]!].map((c) => call(c, 'return.create (同時)', 'POST', '/api/returns', req)));
      const wins = rs.filter((x) => x.status === 200);
      if (wins.length !== 1) check(`返品: 同じ明細の全数返品の同時申請は 1 本だけ（${d.orderNumber}）`, false, rs.map((x) => `${x.status} ${x.body?.error?.code ?? ''}`));
      if (!wins.length) return;
      const retId = wins[0]!.body.id;
      await call(owner, 'return.authorize', 'POST', `/api/returns/${retId}/authorize`, {});
      const rd = (await call(owner, 'return.detail', 'GET', `/api/returns/${retId}`)).body;
      const recv = { warehouseId: d.fulfillments[0]?.warehouseId ?? master.warehouses[0]!.id, items: [{ returnItemId: rd.items[0].id, receivedQty: it.shippedQty }] };
      await Promise.all([packers[w % 8]!, managers[(w + 1) % 3]!].map((c) => call(c, 'return.receive (同時)', 'POST', `/api/returns/${retId}/receive`, recv)));
      const insp = { clientRequestId: randomUUID(), lines: [{ returnItemId: rd.items[0].id, disposition: 'restock', qty: it.shippedQty }] };
      const is = await Promise.all([0, 1, 2].map((k) => call(k ? managers[(w + k) % 3]! : owner, 'return.inspect (再送含む)', 'POST', `/api/returns/${retId}/inspect`, insp)));
      if (is.some((x) => x.status === 200)) expectedRestock += it.shippedQty;
    }),
  );
  {
    const afterOnHand = (await q(`SELECT COALESCE(SUM(on_hand), 0)::int AS n FROM inventory_balances WHERE organization_id = $1`))[0].n;
    check('返品: 検品の同時再送でも Restock は 1 回（OnHand の増加 = Restock 数量）', afterOnHand - beforeOnHand === expectedRestock && expectedRestock > 0, { beforeOnHand, afterOnHand, expectedRestock });
    const mv = await q(
      `SELECT i.id FROM return_inspections i WHERE i.organization_id = $1 AND i.disposition = 'restock'
          AND (SELECT count(*) FROM inventory_movements m WHERE m.organization_id = i.organization_id AND m.reference_type = 'return_inspection' AND m.reference_id = i.id) <> 1`,
    );
    check('返品: Restock 判定 1 件ごとに在庫移動がちょうど 1 行', mv.length === 0, mv.slice(0, 5));
    const overReturn = await q(
      `SELECT oi.id FROM order_items oi WHERE oi.organization_id = $1
          AND oi.shipped_qty < COALESCE((SELECT SUM(CASE WHEN r.status = 'completed' THEN ri.received_qty ELSE ri.requested_qty END) FROM return_items ri JOIN returns r ON r.organization_id = ri.organization_id AND r.id = ri.return_id
                                          WHERE ri.organization_id = oi.organization_id AND ri.order_item_id = oi.id AND r.status <> 'cancelled'), 0)`,
    );
    check('返品: 同時申請でも返品数量の合計は出荷数量を超えない', overReturn.length === 0, overReturn.slice(0, 5));
  }

  // 7) 全体の整合性（台帳 = 残高、引当・Pick・梱包・出荷・返品の各数量の不変条件）
  const violations = await withTenant(env.pool, orgId, SYSTEM_ACTOR, (tx) => checkIntegrity(tx));
  check('整合性チェック（全不変条件）', violations.length === 0, violations.slice(0, 5));
  check('サーバーエラー（5xx）なし', serverErrors.length === 0, serverErrors.slice(0, 5));
  out.orgId = orgId;
  out.tasks = tasks.length;
  out.waves = waveIds.length;
  out.packed = picked.length;
  out.shipments = shipmentIds.length;
  out.returns = shippedOrders.length;
} finally {
  out.steps = steps;
  out.outcomes = outcomes;
  out.checks = checks;
  out.serverErrors = serverErrors;
  out.api = timings.summary();
  await env.close();
  mkdirSync(new URL('../../load/results/', import.meta.url), { recursive: true });
  const file = new URL(`../../load/results/contention-${values.tag || new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(out, null, 2));
  const ng = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - ng}/${checks.length} checks passed → ${file.pathname}`);
  if (ng) process.exitCode = 1;
}
