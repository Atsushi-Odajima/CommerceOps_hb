/**
 * 1 日分の業務を実 API で流す: 取込 → 一括引当 → Wave → Pick → 梱包 → 出荷確定 → 検索 →（任意）返品・交換。
 * テンプレート組織の作成（状態の分布つき）と、1 日 50 / 500 / 5,000 注文の所要時間の測定の両方に使う。
 */
import { randomUUID } from 'node:crypto';
import { STANDARD_TEMPLATE_MAPPING } from '../src/modules/channels/routes.js';
import { Client, csvOf, fakeOrderRows, rng, round, Timings } from './lib.js';

export interface Master {
  channelIds: string[];
  profileIds: string[];
  warehouses: { id: string; code: string }[];
  skus: string[];
}

/** 倉庫（2）・ロケーション・商品・チャネル（3）・Import Profile・在庫 */
export async function setupMaster(owner: Client, opts: { skus: number; stockPerSku: number; scarceSkus?: number }): Promise<Master> {
  const mapping = STANDARD_TEMPLATE_MAPPING;
  const channelIds: string[] = [];
  const profileIds: string[] = [];
  for (const [name, code, type] of [
    ['Web Store', 'WEB', 'own_site'],
    ['Marketplace A', 'MPA', 'other'],
    ['Manual', 'MAN', 'manual'],
  ] as const) {
    const ch = await owner.post('/api/channels', { name, code, type });
    channelIds.push(ch.id);
    profileIds.push((await owner.post('/api/import-profiles', { channelId: ch.id, name: `${name} 標準CSV`, mapping, dateFormat: 'yyyy-MM-dd HH:mm:ss' })).id);
  }
  const warehouses: { id: string; code: string }[] = [];
  for (const [i, code] of ['TKY', 'OSK'].entries()) {
    const id = (await owner.post('/api/warehouses', { code, name: `${code} 倉庫`, priority: 10 * (i + 1) })).id;
    await owner.post(`/api/warehouses/${id}/locations/bulk`, { lines: Array.from({ length: 20 }, (_, j) => `A-${String(j + 1).padStart(2, '0')},A,${j + 1}`) });
    warehouses.push({ id, code });
  }
  const skus: string[] = [];
  const productIds: string[] = [];
  for (let i = 1; i <= opts.skus; i++) {
    const sku = `LD-${String(i).padStart(3, '0')}`;
    const jan = `4900000${String(i).padStart(5, '0')}`;
    productIds.push((await owner.post('/api/products', { sku, name: `負荷検証商品 ${i}`, barcodes: [{ code: jan + ean13Check(jan) }] })).id);
    skus.push(sku);
  }
  for (const wh of warehouses) {
    const locs = (await owner.get(`/api/warehouses/${wh.id}/locations?kind=pick`)).items as { id: string; code: string }[];
    for (const [i, pid] of productIds.entries()) {
      const scarce = i < (opts.scarceSkus ?? 0);
      const qty = scarce ? (wh.code === 'TKY' ? 3 : 0) : wh.code === 'TKY' ? opts.stockPerSku : Math.floor(opts.stockPerSku / 4);
      if (qty > 0) await owner.post('/api/inventory/receipts', { locationId: locs[i % locs.length]!.id, productId: pid, qty, reason: '初期在庫（負荷検証）' });
    }
  }
  return { channelIds, profileIds, warehouses, skus };
}

function ean13Check(d12: string) {
  const s = [...d12].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 ? 3 : 1), 0);
  return String((10 - (s % 10)) % 10);
}

export interface FlowOptions {
  orders: number;
  seed: number;
  extPrefix: string;
  /** 注文日時（取込 CSV に書く値） */
  date: string;
  /** 取込に使うチャネルの順番（0..2） */
  channelIndex?: number;
  /** 状態の分布（テンプレート用）。未指定は「全件出荷まで」 */
  cancelRatio?: number;
  holdRatio?: number;
  leaveReadyRatio?: number;
  leaveUnpickedRatio?: number;
  leaveUnpackedRatio?: number;
  leaveUnshippedRatio?: number;
  shortRatio?: number;
  returnRatio?: number;
  exchangeRatio?: number;
  /** 工程の区切りごとに呼ぶ（例: 統計情報の更新 = 実運用で 1 時間ごとに走る保守処理の代わり。所要時間は工程の時間に含めない） */
  between?: (step: string) => Promise<void>;
  /** 同時に作業する人数（Picker / Packer） */
  pickers: Client[];
  packers: Client[];
  searchSamples?: number;
}

export interface FlowResult {
  steps: Record<string, number>;
  counts: Record<string, number>;
}

async function parallel<T>(items: T[], workers: number, fn: (item: T, w: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, workers) }, async (_, w) => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        await fn(items[idx]!, w);
      }
    }),
  );
}

export async function runFlow(owner: Client, master: Master, o: FlowOptions): Promise<FlowResult> {
  const r = rng(o.seed);
  const steps: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const t = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      steps[name] = round((steps[name] ?? 0) + performance.now() - t0, 0);
    }
  };
  const ch = o.channelIndex ?? 0;

  // 1) 取込（CSV 1 ファイル。5,000 注文 ≒ 15,000 行）
  const rows = Array.from({ length: o.orders }, (_, i) => fakeOrderRows(`${o.extPrefix}${String(i + 1).padStart(6, '0')}`, master.skus, r, o.date)).flat();
  const imported = await t('import', async () => {
    const pv = await owner.upload('/api/imports/preview', { profileId: master.profileIds[ch]! }, csvOf(rows), `${o.extPrefix}.csv`, 'import.preview');
    await owner.post(`/api/imports/${pv.batchId}/commit`, { applyUpdateIds: [] }, 'import.commit');
    return pv;
  });
  counts.importedOrders = o.orders;
  await o.between?.('import');
  counts.importedLines = rows.length;
  void imported;
  const ordersOfDay = async (status?: string) => {
    const out: any[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await owner.get(`/api/orders?limit=200&offset=${offset}&q=${encodeURIComponent(o.extPrefix)}${status ? `&status=${status}` : ''}`, 'orders.list');
      out.push(...page.items);
      if (page.items.length < 200) return out;
    }
  };

  // 2) 取消・保留（テンプレート用）
  if (o.cancelRatio || o.holdRatio) {
    const all = await ordersOfDay();
    const nCancel = Math.round(all.length * (o.cancelRatio ?? 0));
    const nHold = Math.round(all.length * (o.holdRatio ?? 0));
    await t('cancel_hold', async () => {
      for (const x of all.slice(0, nCancel)) await owner.post(`/api/orders/${x.id}/cancel`, { reason: '顧客都合', confirm: true }, 'order.cancel');
      for (const x of all.slice(nCancel, nCancel + nHold)) await owner.post(`/api/orders/${x.id}/holds`, { reasonCode: 'customer_confirm', note: '確認待ち' }, 'order.hold');
    });
    counts.cancelled = nCancel;
    counts.held = nHold;
  }

  // 3) 一括引当（1 回 500 件。進まなくなるまで繰り返す）
  await t('allocate', async () => {
    let runs = 0;
    for (;;) {
      const s = await owner.post('/api/allocation/run-now', {}, 'allocation.run_now');
      runs++;
      counts.allocFull = (counts.allocFull ?? 0) + s.full;
      counts.allocPartial = (counts.allocPartial ?? 0) + s.partial;
      counts.allocNone = (counts.allocNone ?? 0) + s.none;
      if (s.full === 0 || runs > Math.ceil(o.orders / 500) + 5) break;
    }
    counts.allocationRuns = runs;
  });
  await o.between?.('allocate');

  // 4) Wave（倉庫ごと、1 Wave 最大 100 件）
  const waveIds: string[] = [];
  await t('waves', async () => {
    for (const wh of master.warehouses) {
      for (;;) {
        const pv = await owner.post('/api/waves/preview', { warehouseId: wh.id }, 'waves.preview');
        let ids: string[] = pv.fulfillments.map((f: any) => f.id).filter((id: string) => id);
        if (o.leaveReadyRatio) ids = ids.filter(() => r() >= o.leaveReadyRatio!);
        if (!ids.length) break;
        const w = await owner.post('/api/waves', { warehouseId: wh.id, fulfillmentIds: ids.slice(0, 100) }, 'waves.create');
        waveIds.push(w.waveId);
        if (pv.fulfillments.length < 100 && o.leaveReadyRatio) break;
      }
    }
  });
  counts.waves = waveIds.length;
  await o.between?.('waves');

  // 5) Pick（Picker が並行してタスクを担当 → ロケーション scan → 商品 scan）
  const tasks: string[] = [];
  for (const id of waveIds) tasks.push(...(await owner.get(`/api/waves/${id}`, 'waves.detail')).tasks.map((x: any) => x.id));
  const pickTasks = o.leaveUnpickedRatio ? tasks.filter(() => r() >= o.leaveUnpickedRatio!) : tasks;
  counts.pickTasks = pickTasks.length;
  let shorts = 0;
  await t('pick', () =>
    parallel(pickTasks, o.pickers.length, async (taskId, w) => {
      const p = o.pickers[w]!;
      const v = await p.post(`/api/pick-tasks/${taskId}/claim`, {}, 'pick.claim');
      for (const g of v.groups) {
        const need = g.required - g.picked - g.short;
        if (need <= 0) continue;
        await p.post(`/api/pick-tasks/${taskId}/scan-location`, { clientEventId: randomUUID(), code: g.locationBarcode ?? g.locationCode, expectedLocationId: g.locationId, inputMethod: 'scanner' }, 'pick.scan_location');
        if (o.shortRatio && r() < o.shortRatio) {
          await p.post(`/api/pick-tasks/${taskId}/short`, { clientEventId: randomUUID(), locationId: g.locationId, productId: g.productId, reasonCode: 'not_found' }, 'pick.short');
          shorts++;
          continue;
        }
        await p.post(`/api/pick-tasks/${taskId}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: g.barcodes[1] ?? g.sku, qty: need, inputMethod: 'scanner' }, 'pick.scan_item');
      }
    }),
  );
  counts.shortPicks = shorts;
  await o.between?.('pick');

  // 6) 梱包（Packer が並行: 開始 → 1 個目 scan → 残りはまとめ入力 → 完了）
  const packQueue: string[] = [];
  for (const wh of master.warehouses) {
    for (let offset = 0; ; offset += 200) {
      const q = await owner.get(`/api/fulfillments?status=picked&warehouseId=${wh.id}&limit=200&offset=${offset}`, 'fulfillments.list');
      packQueue.push(...q.items.map((f: any) => f.id));
      if (q.items.length < 200) break;
    }
  }
  const toPack = o.leaveUnpackedRatio ? packQueue.filter(() => r() >= o.leaveUnpackedRatio!) : packQueue;
  const shipmentIds: string[] = [];
  await t('pack', () =>
    parallel(toPack, o.packers.length, async (fid, w) => {
      const p = o.packers[w]!;
      const { sessionId } = await p.post('/api/pack/open', { fulfillmentId: fid }, 'pack.open');
      const s = await p.get(`/api/pack/sessions/${sessionId}`, 'pack.view');
      for (const it of s.items) {
        if (it.remaining <= 0) continue;
        await p.post(`/api/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: it.barcodes?.[0] ?? it.sku, inputMethod: 'scanner' }, 'pack.scan');
        if (it.remaining > 1) await p.post(`/api/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: it.sku, qty: it.remaining - 1, inputMethod: 'manual' }, 'pack.scan_qty');
      }
      const done = await p.post(`/api/pack/sessions/${sessionId}/complete`, { requestId: randomUUID() }, 'pack.complete');
      shipmentIds.push(...done.shipments.map((x: any) => x.id));
    }),
  );
  counts.packed = toPack.length;
  await o.between?.('pack');

  // 7) 出荷確定（追跡番号の入力 → 確定）
  const toShip = o.leaveUnshippedRatio ? shipmentIds.filter(() => r() >= o.leaveUnshippedRatio!) : shipmentIds;
  let trackingSeq = Math.floor(r() * 1e9);
  await t('ship', () =>
    parallel(toShip, o.packers.length, async (sid, w) => {
      const p = o.packers[w]!;
      void p;
      await owner.patch(`/api/shipments/${sid}`, { carrier: 'yamato', trackingNumber: `${o.extPrefix.replace(/[^A-Z0-9]/gi, '')}${(trackingSeq++).toString().padStart(10, '0')}` }, 'ship.tracking');
      await owner.post(`/api/shipments/${sid}/confirm`, {}, 'ship.confirm');
    }),
  );
  counts.shipped = toShip.length;

  // 8) 検索（注文番号・外部注文番号・顧客名・郵便番号・追跡番号・SKU）
  const samples = o.searchSamples ?? 10;
  if (samples > 0) {
    const some = (await owner.get(`/api/orders?limit=${samples}&q=${encodeURIComponent(o.extPrefix)}`, 'orders.list')).items as any[];
    await t('search', async () => {
      for (const x of some) {
        await owner.get(`/api/search?q=${encodeURIComponent(x.orderNumber)}`, 'search.order_number');
        await owner.get(`/api/search?q=${encodeURIComponent(x.externalOrderId)}`, 'search.external_id');
        await owner.get(`/api/orders/${x.id}`, 'orders.detail');
      }
      for (const q of ['佐藤', '150-0001', 'LD-001', 'YAMATO'.slice(0, 3)]) await owner.get(`/api/search?q=${encodeURIComponent(q)}`, 'search.text');
      await owner.get('/api/orders?limit=50', 'orders.list_default');
      await owner.get('/api/orders/status-counts', 'orders.status_counts');
      await owner.get('/api/dashboard/home', 'dashboard.home');
    });
  }

  // 9) 返品・交換（テンプレート用）
  if (o.returnRatio) {
    const shipped = (await ordersOfDay('shipped')).slice(0, Math.round(o.orders * o.returnRatio));
    await t('returns', async () => {
      for (const [i, x] of shipped.entries()) {
        const d = await owner.get(`/api/orders/${x.id}`, 'orders.detail');
        const it = d.items.find((y: any) => y.shippedQty > 0);
        if (!it) continue;
        const ret = await owner.post('/api/returns', { orderId: x.id, reasonCode: i % 3 === 0 ? 'damaged_in_transit' : 'defective', items: [{ orderItemId: it.id, qty: 1 }] }, 'return.create');
        if (i % 10 === 9) continue; // 受付のみ
        await owner.post(`/api/returns/${ret.id}/authorize`, {}, 'return.authorize');
        if (i % 10 === 8) continue; // 承認まで
        const rd = await owner.get(`/api/returns/${ret.id}`, 'return.detail');
        await owner.post(`/api/returns/${ret.id}/receive`, { warehouseId: d.fulfillments[0]?.warehouseId ?? master.warehouses[0]!.id, items: [{ returnItemId: rd.items[0].id, receivedQty: 1 }] }, 'return.receive');
        const damaged = i % 3 === 0;
        await owner.post(
          `/api/returns/${ret.id}/inspect`,
          { clientRequestId: randomUUID(), lines: [{ returnItemId: rd.items[0].id, disposition: damaged ? 'damaged' : 'restock', qty: 1, reason: damaged ? '外箱破損' : undefined }] },
          'return.inspect',
        );
        if (o.exchangeRatio && r() < o.exchangeRatio / (o.returnRatio ?? 1)) {
          await owner.post(`/api/returns/${ret.id}/exchange`, { items: [{ sku: it.sku, quantity: 1, originalOrderItemId: it.id }] }, 'exchange.create');
          counts.exchanges = (counts.exchanges ?? 0) + 1;
        }
        counts.returnsCompleted = (counts.returnsCompleted ?? 0) + 1;
      }
    });
    counts.returns = shipped.length;
  }
  return { steps, counts };
}

export const newTimings = () => new Timings();
