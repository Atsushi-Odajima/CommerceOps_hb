/**
 * サンプル組織「Sample Commerce」を作成する（本番データと分離: organizations.is_sample = true。画面上部に「サンプル組織」と表示）。
 *   npm run seed:sample -w server -- [--owner-email owner@example.com] [--force]
 *   （ビルド済み / Docker: node dist/scripts/seed-sample.js [--owner-email ...]）
 * 業務はすべて実際の API（アプリをこのプロセス内で起動）で流すので、在庫・引当・Pick・梱包・出荷・返品の数量は本番と同じ規則で整合する。
 * 役割ごとのサンプル用アカウント（パスワードは 1 回だけ表示）を作る。--owner-email の既存ユーザーもサンプル組織の Owner に加える。
 * 既に Sample Commerce がある場合は何もしない（--force で 2 つ目を作る）。個人名・住所・電話・メールはすべて架空。
 * シナリオの説明は buyer-docs/サンプル業務説明.txt。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { withSystem, withTenant, SYSTEM_ACTOR } from '../db/tx.js';
import { LocalDiskStorage } from '../modules/attachments/storage.js';
import { findUserByEmail, insertOrganization, insertUser, upsertMembership } from '../modules/orgs/service.js';
import { STANDARD_TEMPLATE_MAPPING } from '../modules/channels/routes.js';
import { checkIntegrity } from '../modules/integrity/check.js';
import type { Role } from '../auth/permissions.js';

const { values } = parseArgs({
  options: {
    'owner-email': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

const ORG_NAME = 'Sample Commerce';

/** アプリをプロセス内で呼ぶ API クライアント（Cookie + CSRF） */
class Client {
  cookie = '';
  csrf = '';
  constructor(private readonly app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, raw?: { payload: Buffer; contentType: string }) {
    const headers: Record<string, string> = { 'x-requested-with': 'CommerceOps' };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    if (raw) headers['content-type'] = raw.contentType;
    const res = await this.app.inject({ method: method as 'GET', url: `/api${url}`, headers, ...(raw ? { payload: raw.payload } : body !== undefined ? { payload: body as object } : {}) });
    const sc = res.headers['set-cookie'];
    for (const c of Array.isArray(sc) ? sc : sc ? [sc] : []) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      if (name && name.includes('co_sid')) this.cookie = `${name}=${rest.join('=')}`;
    }
    const json = String(res.headers['content-type'] ?? '').includes('json') ? res.json() : undefined;
    return { status: res.statusCode, body: json as any };
  }
  async ok(method: string, url: string, body?: unknown) {
    const r = await this.req(method, url, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
  get = (url: string) => this.ok('GET', url);
  post = (url: string, body: unknown = {}) => this.ok('POST', url, body);
  patch = (url: string, body: unknown = {}) => this.ok('PATCH', url, body);
  /** 想定どおりの拒否（誤 scan・重複取込など）を確かめる */
  async expectReject(method: string, url: string, body: unknown, statuses: number[]) {
    const r = await this.req(method, url, body);
    if (!statuses.includes(r.status)) throw new Error(`${method} ${url}: expected ${statuses.join('/')} but got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
  async upload(url: string, fields: Record<string, string>, content: Buffer, filename: string) {
    const boundary = '----sample' + randomUUID().replace(/-/g, '');
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`));
    return this.req('POST', url, undefined, { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` });
  }
  async login(email: string, password: string) {
    const r = await this.req('POST', '/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
    this.csrf = r.body.csrfToken;
    return this;
  }
  async switchOrg(orgId: string) {
    await this.post('/auth/switch-org', { organizationId: orgId });
    this.csrf = (await this.get('/auth/me')).csrfToken;
  }
}

const ean13 = (d12: string) => d12 + String((10 - ([...d12].reduce((a, ch, i) => a + Number(ch) * (i % 2 ? 3 : 1), 0) % 10)) % 10);

/** 商品マスター（JAN は店内用の 200 番台 = 実在の商品コードと重ならない）。stock: [東京, 大阪] の初期在庫 */
const PRODUCTS: { sku: string; name: string; variant?: string; group?: string; stock: [number, number]; loc: string }[] = [
  ...['白', '黒', 'ネイビー'].flatMap((c, ci) =>
    ['S', 'M', 'L'].map((sz, si) => ({ sku: `SC-TS-${['WH', 'BK', 'NV'][ci]}-${sz}`, name: 'ベーシック Tシャツ', variant: `${c} / ${sz}`, group: 'SC-TS', stock: [30, 10] as [number, number], loc: `A-0${1 + ((ci * 3 + si) % 8)}` })),
  ),
  { sku: 'SC-HD-GY-M', name: 'スウェット パーカー', variant: 'グレー / M', group: 'SC-HD', stock: [12, 6], loc: 'B-01' },
  { sku: 'SC-HD-GY-L', name: 'スウェット パーカー', variant: 'グレー / L', group: 'SC-HD', stock: [2, 3], loc: 'B-01' }, // 2 倉庫に分かれて在庫（分割引当）
  { sku: 'SC-HD-BK-M', name: 'スウェット パーカー', variant: '黒 / M', group: 'SC-HD', stock: [12, 6], loc: 'B-02' },
  { sku: 'SC-HD-BK-L', name: 'スウェット パーカー', variant: '黒 / L', group: 'SC-HD', stock: [12, 6], loc: 'B-02' },
  { sku: 'SC-MUG-WH', name: 'ロゴ マグカップ', variant: '白', group: 'SC-MUG', stock: [24, 12], loc: 'B-03' },
  { sku: 'SC-MUG-BL', name: 'ロゴ マグカップ', variant: '青', group: 'SC-MUG', stock: [2, 0], loc: 'B-03' }, // 数量 3 の注文に 2 個 → 一部引当
  { sku: 'SC-TOTE-NT', name: 'キャンバス トートバッグ', variant: '生成', group: 'SC-TOTE', stock: [20, 10], loc: 'B-04' },
  { sku: 'SC-TOTE-BK', name: 'キャンバス トートバッグ', variant: '黒', group: 'SC-TOTE', stock: [20, 10], loc: 'B-04' },
  { sku: 'SC-STK-SET', name: 'ステッカー 5 枚セット', stock: [50, 20], loc: 'A-08' },
  { sku: 'SC-CAP-BK', name: 'ロゴ キャップ', variant: '黒', group: 'SC-CAP', stock: [15, 5], loc: 'B-05' },
  { sku: 'SC-CAP-BG', name: 'ロゴ キャップ', variant: 'ベージュ', group: 'SC-CAP', stock: [3, 4], loc: 'B-05' }, // 現物不足（Short）→ 大阪へ再割当
  { sku: 'SC-SOCKS-M', name: 'リブ ソックス', variant: 'M', group: 'SC-SOCKS', stock: [30, 10], loc: 'A-07' },
  { sku: 'SC-SOCKS-L', name: 'リブ ソックス', variant: 'L', group: 'SC-SOCKS', stock: [0, 0], loc: 'A-07' }, // 後日入荷（分割発送）
  { sku: 'SC-TMB-350', name: 'ステンレス タンブラー 350ml', stock: [10, 5], loc: 'B-06' },
  { sku: 'SC-NOTE-A5', name: 'ドット ノート', variant: 'A5', group: 'SC-NOTE', stock: [40, 20], loc: 'A-06' },
  { sku: 'SC-NOTE-B5', name: 'ドット ノート', variant: 'B5', group: 'SC-NOTE', stock: [40, 20], loc: 'A-06' },
  { sku: 'SC-PEN-BK', name: 'ゲルインク ボールペン', variant: '黒', group: 'SC-PEN', stock: [60, 30], loc: 'A-05' },
  { sku: 'SC-PEN-RD', name: 'ゲルインク ボールペン', variant: '赤', group: 'SC-PEN', stock: [60, 30], loc: 'A-05' },
  { sku: 'SC-PEN-BL', name: 'ゲルインク ボールペン', variant: '青', group: 'SC-PEN', stock: [60, 30], loc: 'A-05' },
  { sku: 'SC-LIMITED', name: '限定 ピンバッジ', stock: [1, 0], loc: 'A-04' }, // 最後の 1 個を 2 チャネルが同時に注文
  { sku: 'SC-BACKORDER', name: '取り寄せ ブランケット', stock: [0, 0], loc: 'B-06' }, // 在庫なし → 欠品
];

const CSV_HEADER = ['注文番号', '注文日時', '購入者名', '購入者メール', '購入者電話', '送付先氏名', '郵便番号', '都道府県', '市区町村', '住所1', '住所2', '送付先電話', '配送方法', '備考', 'SKU', '商品名', '数量', '単価'];
interface CsvOrder {
  ext: string;
  name: string;
  zip: string;
  pref: string;
  city: string;
  addr1: string;
  lines: [string, number][];
  method?: string;
  note?: string;
}
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function ordersCsv(orders: CsvOrder[], date: string) {
  const rows = orders.flatMap((o) =>
    o.lines.map(([sku, qty]) => {
      const p = PRODUCTS.find((x) => x.sku === sku)!;
      return [o.ext, date, o.name, `${o.ext.toLowerCase()}@example.invalid`, '090-0000-0000', o.name, o.zip, o.pref, o.city, o.addr1, '', '090-0000-0000', o.method ?? '宅配便', o.note ?? '', sku, `${p.name}${p.variant ? ` ${p.variant}` : ''}`, qty, 1500];
    }),
  );
  return Buffer.from('﻿' + [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
}
// 架空の購入者（実在しない住所: 番地は「架空町」）
const P = {
  a: { name: '山田 花子', zip: '150-0001', pref: '東京都', city: '渋谷区', addr1: '架空町1-2-3' },
  b: { name: '佐藤 太郎', zip: '530-0001', pref: '大阪府', city: '大阪市北区', addr1: '架空町4-5-6' },
  c: { name: '鈴木 一郎', zip: '231-0001', pref: '神奈川県', city: '横浜市中区', addr1: '架空町7-8-9' },
  d: { name: '高橋 美咲', zip: '460-0001', pref: '愛知県', city: '名古屋市中区', addr1: '架空町2-4-6' },
  e: { name: '田中 健太', zip: '810-0001', pref: '福岡県', city: '福岡市中央区', addr1: '架空町3-6-9' },
  f: { name: '伊藤 陽子', zip: '060-0001', pref: '北海道', city: '札幌市中央区', addr1: '架空町1-1-1' },
};

async function main() {
  const base = loadConfig();
  // この処理だけで多数の API を呼ぶため、プロセス内のアプリはレート制限を緩める（外部には公開しない）
  const config = loadConfig(process.env, { RATE_LIMIT_MAX: 1_000_000, LOGIN_RATE_LIMIT_MAX: 1000, RUN_WORKER: false });
  const pool = createPool({ connectionString: base.DATABASE_URL, max: 8, ssl: base.DATABASE_SSL });
  const numberingPool = createPool({ connectionString: base.DATABASE_URL, max: 2, ssl: base.DATABASE_SSL, applicationName: 'commerceops-numbering' });
  try {
    await migrate(pool);
    const existing = (await pool.query(`SELECT id FROM organizations WHERE is_sample AND name = $1 ORDER BY created_at LIMIT 1`, [ORG_NAME])).rows[0];
    if (existing && !values.force) {
      console.log(`Sample Commerce は既にあります（組織 ID: ${existing.id}）。作り直す場合は --force で 2 つ目を作成してください。`);
      return;
    }
    const suffix = randomBytes(3).toString('hex');
    const accounts: { role: Role; label: string; email: string; password: string }[] = (
      [
        ['owner', 'Owner'],
        ['ops_manager', 'Operations Manager'],
        ['picker', 'Picker'],
        ['packer', 'Packer'],
        ['support', 'Customer Support'],
      ] as [Role, string][]
    ).map(([role, label]) => ({ role, label, email: `sample-${role.replace('_', '-')}-${suffix}@example.invalid`, password: `Smp-${randomBytes(9).toString('base64url')}-7` }));
    const orgId = await withSystem(pool, async (c) => {
      const id = await insertOrganization(c, { name: ORG_NAME, isSample: true });
      for (const a of accounts) await upsertMembership(c, id, await insertUser(c, { email: a.email, name: `サンプル ${a.label}`, password: a.password }), a.role, null);
      if (values['owner-email']) {
        const u = await findUserByEmail(c, values['owner-email']);
        if (!u) throw new Error(`--owner-email のユーザー ${values['owner-email']} が見つかりません（先に create-owner で作成してください）`);
        await upsertMembership(c, id, u.id, 'owner', null);
      }
      return id;
    });
    const app = await buildApp({ config, pool, numberingPool, storage: new LocalDiskStorage(config.DATA_DIR) }, { logger: false });
    await app.ready();
    try {
      const as = async (role: Role) => {
        const a = accounts.find((x) => x.role === role)!;
        const cl = await new Client(app).login(a.email, a.password);
        await cl.switchOrg(orgId);
        return cl;
      };
      const owner = await as('owner');
      const manager = await as('ops_manager');
      const picker = await as('picker');
      const packer = await as('packer');
      const support = await as('support');
      const log = (m: string) => console.log(`  - ${m}`);
      console.log(`Sample Commerce を作成しています（組織 ID: ${orgId}）`);

      // ---- マスター ----
      const wh: Record<'TKY' | 'OSK', string> = { TKY: '', OSK: '' };
      const loc: Record<'TKY' | 'OSK', Record<string, string>> = { TKY: {}, OSK: {} };
      for (const [code, name, prio, lines] of [
        ['TKY', 'Warehouse Tokyo（東京倉庫）', 10, [...Array.from({ length: 8 }, (_, i) => `A-0${i + 1},A,${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `B-0${i + 1},B,${i + 11}`)]],
        ['OSK', 'Warehouse Osaka（大阪倉庫）', 20, [...Array.from({ length: 8 }, (_, i) => `A-0${i + 1},A,${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `B-0${i + 1},B,${i + 11}`)]],
      ] as const) {
        wh[code] = (await owner.post('/warehouses', { code, name, priority: prio })).id;
        await owner.post(`/warehouses/${wh[code]}/locations/bulk`, { lines });
        for (const l of (await owner.get(`/warehouses/${wh[code]}/locations?kind=pick`)).items as { id: string; code: string }[]) loc[code][l.code] = l.id;
      }
      const ch: Record<'WEB' | 'MPA' | 'MAN', string> = { WEB: '', MPA: '', MAN: '' };
      const profile: Record<'WEB' | 'MPA', string> = { WEB: '', MPA: '' };
      for (const [code, name, type] of [
        ['WEB', 'Web Store', 'own_site'],
        ['MPA', 'Marketplace A', 'other'],
        ['MAN', 'Manual', 'manual'],
      ] as const) {
        ch[code] = (await owner.post('/channels', { name, code, type })).id;
        if (code !== 'MAN') profile[code] = (await owner.post('/import-profiles', { channelId: ch[code], name: `${name} 標準CSV`, mapping: STANDARD_TEMPLATE_MAPPING, dateFormat: 'yyyy-MM-dd HH:mm:ss' })).id;
      }
      const productId: Record<string, string> = {};
      const jan: Record<string, string> = {};
      for (const [i, p] of PRODUCTS.entries()) {
        jan[p.sku] = ean13(`200000000${String(i + 1).padStart(3, '0')}`);
        productId[p.sku] = (await owner.post('/products', { sku: p.sku, name: p.name, variant: p.variant ?? null, groupCode: p.group ?? null, weightG: 200, barcodes: [{ code: jan[p.sku] }] })).id;
        for (const [k, w] of (['TKY', 'OSK'] as const).entries()) {
          if (p.stock[k] > 0) await owner.post('/inventory/receipts', { locationId: loc[w][p.loc]!, productId: productId[p.sku], qty: p.stock[k], reason: '初期在庫（サンプル）', requestId: randomUUID() });
        }
      }
      log(`倉庫 2（東京・大阪）/ ロケーション 28 / チャネル 3（Web Store・Marketplace A・Manual）/ 商品 ${PRODUCTS.length} SKU / 初期在庫`);

      // ---- 注文 ----
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const webOrders: CsvOrder[] = [
        { ext: 'W-10001', ...P.a, lines: [['SC-LIMITED', 1], ['SC-STK-SET', 1]] },
        { ext: 'W-10002', ...P.b, lines: [['SC-TS-WH-M', 2], ['SC-SOCKS-M', 1]] },
        { ext: 'W-10003', ...P.c, lines: [['SC-HD-BK-M', 1]] },
        { ext: 'W-10004', ...P.d, lines: [['SC-MUG-WH', 1], ['SC-NOTE-A5', 2]] },
        { ext: 'W-10005', ...P.e, lines: [['SC-MUG-BL', 3]] },
        { ext: 'W-10006', ...P.f, lines: [['SC-BACKORDER', 1], ['SC-PEN-BK', 2]] },
        { ext: 'W-10007', ...P.a, lines: [['SC-TS-NV-L', 1], ['SC-TOTE-NT', 1], ['SC-SOCKS-L', 1]] },
        { ext: 'W-10008', ...P.b, lines: [['SC-CAP-BG', 2]] },
        { ext: 'W-10009', ...P.c, lines: [['SC-CAP-BG', 1], ['SC-PEN-RD', 1]] },
        { ext: 'W-10010', ...P.d, lines: [['SC-TS-BK-S', 1], ['SC-TS-BK-M', 1], ['SC-TMB-350', 1]] },
        { ext: 'W-10011', ...P.e, lines: [['SC-TOTE-BK', 1], ['SC-NOTE-B5', 1], ['SC-PEN-BL', 3]] },
        { ext: 'W-10012', ...P.f, zip: '1234', lines: [['SC-TS-WH-S', 1]], note: '郵便番号の桁が足りない（要確認のサンプル）' },
      ];
      const webCsv = ordersCsv(webOrders, `${today} 09:00:00`);
      const pv = await owner.upload('/imports/preview', { profileId: profile.WEB }, webCsv, 'web-store-orders.csv');
      if (pv.status !== 200) throw new Error(`import preview ${pv.status} ${JSON.stringify(pv.body)}`);
      await owner.post(`/imports/${pv.body.batchId}/commit`, { applyUpdateIds: [] });
      // 同じファイルをもう一度取り込む → 拒否（重複取込の防止）
      const dup = await owner.upload('/imports/preview', { profileId: profile.WEB }, webCsv, 'web-store-orders.csv');
      if (dup.status !== 409) throw new Error(`duplicate file should be rejected, got ${dup.status}`);
      // 別ファイルに同じ注文（内容同一）と、同じ注文番号で内容が違う注文（更新候補）が混ざっている
      const web2 = ordersCsv(
        [webOrders[1]!, webOrders[3]!, { ...webOrders[2]!, lines: [['SC-HD-BK-M', 2]] }, { ext: 'W-10013', ...P.b, lines: [['SC-TS-WH-L', 1], ['SC-STK-SET', 2]] }, { ext: 'W-10014', ...P.c, lines: [['SC-HD-GY-M', 1]] }],
        `${today} 09:00:00`,
      );
      const pv2 = await owner.upload('/imports/preview', { profileId: profile.WEB }, web2, 'web-store-orders-afternoon.csv');
      if (pv2.status !== 200) throw new Error(`import preview 2 ${pv2.status}`);
      await owner.post(`/imports/${pv2.body.batchId}/commit`, { applyUpdateIds: [] }); // 更新候補は適用しない（注文 W-10003 は元のまま）
      log('注文 CSV 取込（Web Store 12 件）→ 同じファイルの再取込は拒否 → 午後のファイル（同一 2 件はスキップ、W-10003 は内容違いの更新候補として保留、新規 2 件）');

      const mpaOrders: CsvOrder[] = [
        { ext: 'M-20001', ...P.d, lines: [['SC-LIMITED', 1]] },
        { ext: 'M-20002', ...P.e, lines: [['SC-TS-WH-L', 1], ['SC-CAP-BK', 1]] },
        { ext: 'M-20003', ...P.f, lines: [['SC-HD-GY-L', 4]] },
        { ext: 'M-20004', ...P.a, lines: [['SC-TOTE-NT', 2]] },
        { ext: 'M-20005', ...P.b, lines: [['SC-TS-NV-M', 1], ['SC-PEN-BK', 1]] },
      ];
      const pvm = await owner.upload('/imports/preview', { profileId: profile.MPA }, ordersCsv(mpaOrders, `${today} 10:30:00`), 'marketplace-a-orders.csv');
      if (pvm.status !== 200) throw new Error(`import preview mpa ${pvm.status}`);
      await owner.post(`/imports/${pvm.body.batchId}/commit`, { applyUpdateIds: [] });
      const manual = async (ext: string, who: (typeof P)[keyof typeof P], lines: [string, number][]) =>
        manager.post('/orders', {
          channelId: ch.MAN,
          order: {
            externalOrderId: ext,
            customer: { name: who.name, email: `${ext.toLowerCase()}@example.invalid` },
            shipTo: { name: who.name, postalCode: who.zip, prefecture: who.pref, city: who.city, address1: who.addr1, phone: '090-0000-0000' },
            lines: lines.map(([sku, quantity]) => ({ sku, quantity })),
          },
        });
      const tel1 = await manual('TEL-0001', P.c, [['SC-NOTE-A5', 1], ['SC-PEN-BK', 1]]);
      const tel2 = await manual('TEL-0002', P.d, [['SC-TMB-350', 1]]);
      const tel3 = await manual('TEL-0003', P.e, [['SC-TS-BK-L', 1]]);
      log('Marketplace A の CSV 取込 5 件、電話注文（Manual）3 件');

      const orders = new Map<string, any>();
      for (let offset = 0; ; offset += 200) {
        const page = await owner.get(`/orders?limit=200&offset=${offset}`);
        for (const o of page.items) orders.set(o.externalOrderId, o);
        if (page.items.length < 200) break;
      }
      const id = (ext: string) => orders.get(ext)!.id as string;

      // ---- 引当 ----
      // 最後の 1 個（SC-LIMITED）を 2 チャネルの注文が同時に要求 → 片方だけ確保、もう片方は欠品
      const race = await Promise.all([manager.post(`/orders/${id('W-10001')}/allocate`, {}), manager.post(`/orders/${id('M-20001')}/allocate`, {})]);
      log(`最後の 1 個の同時引当: W-10001 → ${race[0].outcome} / M-20001 → ${race[1].outcome}（片方だけが確保）`);
      // 電話注文 1 件を保留（住所の番地確認）、1 件を引当後にキャンセル
      await support.post(`/orders/${tel2.id}/holds`, { reasonCode: 'address_check', note: '番地の確認待ち（サンプル）' });
      await manager.post(`/orders/${tel3.id}/allocate`, {});
      await manager.post(`/orders/${tel3.id}/cancel`, { reason: '顧客都合（電話でキャンセルの連絡）', confirm: true });
      // 一括引当（残り全部）
      await manager.post('/allocation/run-now', {});
      // 2 倉庫に分かれた在庫: M-20003（パーカー L × 4、東京 2・大阪 3）→ 一部を大阪で確保 → 人が「残りを東京から」を確定
      const split = await manager.get(`/orders/${id('M-20003')}`);
      if (split.status !== 'allocated') await manager.post(`/orders/${id('M-20003')}/allocate`, { warehouseId: wh.TKY });
      // 分割発送: W-10007 は SC-SOCKS-L が未入荷 → 揃った分を先行出荷
      await manager.post(`/orders/${id('W-10007')}/release`, {});
      log('一括引当: 一部引当（W-10005 マグ 3 個に在庫 2）、欠品（W-10006 取り寄せ品）、2 倉庫への分割引当（M-20003）、先行出荷（W-10007）、保留（TEL-0002）、キャンセル（TEL-0003）');

      // ---- Wave・Pick（東京）----
      const pvw = await manager.post('/waves/preview', { warehouseId: wh.TKY });
      const waveTargets = ['W-10002', 'W-10004', 'W-10007', 'W-10008', 'W-10009', 'W-10010', 'M-20002', 'M-20003'];
      const ffIds: string[] = pvw.fulfillments.filter((f: any) => waveTargets.includes(f.externalOrderId ?? '') || waveTargets.some((e) => f.orderNumber && orders.get(e)?.orderNumber === f.orderNumber)).map((f: any) => f.id);
      const wave = await manager.post('/waves', { warehouseId: wh.TKY, fulfillmentIds: ffIds, label: '午前便', splitMode: 'zone' });
      const wd = await manager.get(`/waves/${wave.waveId}`);
      for (const t of wd.tasks as { id: string }[]) {
        const v = await picker.post(`/pick-tasks/${t.id}/claim`, {});
        let misScanned = false;
        for (const g of v.groups) {
          await picker.post(`/pick-tasks/${t.id}/scan-location`, { clientEventId: randomUUID(), code: g.locationBarcode ?? g.locationCode, expectedLocationId: g.locationId, inputMethod: 'scanner' });
          if (!misScanned) {
            // 誤 scan: 棚の隣の商品を読んだ → 拒否され記録される（数量は増えない）
            const other = PRODUCTS.find((p) => p.sku !== g.sku && p.loc !== PRODUCTS.find((x) => x.sku === g.sku)?.loc)!;
            await picker.expectReject('POST', `/pick-tasks/${t.id}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: jan[other.sku], qty: 1, inputMethod: 'scanner' }, [422]);
            misScanned = true;
          }
          if (g.sku === 'SC-CAP-BG' && g.remaining > 1) {
            // 現物不足: 棚に 3 個あるはずが 2 個しかない → 2 個ピックして残りを Short
            await picker.post(`/pick-tasks/${t.id}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: jan[g.sku], qty: 2, inputMethod: 'scanner' });
            await picker.post(`/pick-tasks/${t.id}/short`, { clientEventId: randomUUID(), locationId: g.locationId, productId: productId[g.sku], reasonCode: 'not_found', note: '棚に見当たらない（サンプル）' });
            continue;
          }
          if (g.remaining > 0) await picker.post(`/pick-tasks/${t.id}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: jan[g.sku], qty: g.remaining, inputMethod: 'scanner' });
        }
      }
      log(`Wave（東京・午前便）${wd.tasks.length} タスク: 誤 scan（拒否・記録）、キャップ ベージュの現物不足 → Short（調査中へ移し在庫は減らさない）`);
      // Short の解決: 大阪倉庫へ再割当
      const shortFfs = (await manager.get(`/fulfillments?warehouseId=${wh.TKY}&limit=200`)).items.filter((f: any) => f.hasShort);
      for (const f of shortFfs) await manager.post(`/fulfillments/${f.id}/resolve-short`, { action: 'reallocate', warehouseId: wh.OSK, note: '大阪倉庫から出荷（サンプル）' });

      // ---- 梱包・出荷 ----
      const picked = (await manager.get(`/fulfillments?status=picked&warehouseId=${wh.TKY}&limit=200`)).items as any[];
      const shipments: { id: string; orderNumber: string }[] = [];
      for (const [i, f] of picked.entries()) {
        const { sessionId } = await packer.post('/pack/open', { fulfillmentId: f.id });
        const s = await packer.get(`/pack/sessions/${sessionId}`);
        if (i === 0) {
          // 梱包の誤 scan: 注文に無い商品 → 赤い警告・記録
          await packer.expectReject('POST', `/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: jan['SC-LIMITED'], inputMethod: 'scanner' }, [422]);
        }
        for (const [k, it] of (s.items as any[]).entries()) {
          if (it.remaining <= 0) continue;
          if (i === 1 && k === 1) await packer.post(`/pack/sessions/${sessionId}/next-box`, { clientEventId: randomUUID() }); // 2 箱に分けて梱包
          for (let n = 0; n < it.remaining; n++) await packer.post(`/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: jan[it.sku], inputMethod: 'scanner' });
        }
        const done = await packer.post(`/pack/sessions/${sessionId}/complete`, { requestId: randomUUID() });
        for (const sh of done.shipments) shipments.push({ id: sh.id, orderNumber: f.orderNumber });
      }
      // W-10010 と M-20003（東京分）の荷物は「出荷待ち」のまま残す（出荷画面で追跡番号入力 → 出荷確定を試せる）
      const keepPending = new Set([orders.get('W-10010')?.orderNumber, orders.get('M-20003')?.orderNumber]);
      let seq = 0;
      for (const sh of shipments.filter((x) => !keepPending.has(x.orderNumber))) {
        await manager.patch(`/shipments/${sh.id}`, { carrier: 'yamato', trackingNumber: `9900${String(1000_0000 + seq++).padStart(8, '0')}` });
        await manager.post(`/shipments/${sh.id}/confirm`, {});
      }
      const pendingCount = shipments.filter((x) => keepPending.has(x.orderNumber)).length;
      log(`梱包 ${picked.length} 件（誤 scan 1 回、2 箱に分けた梱包 1 件）→ 出荷確定 ${shipments.length - pendingCount} 荷物、出荷待ち ${pendingCount} 荷物（W-10010・M-20003 の東京分）`);

      // ---- 分割発送の 2 回目: SC-SOCKS-L が入荷 → 引当 → Wave → Pick → 梱包 → 出荷 ----
      await owner.post('/inventory/receipts', { locationId: loc.TKY['A-07']!, productId: productId['SC-SOCKS-L'], qty: 6, reason: '入荷（サンプル）', requestId: randomUUID() });
      await manager.post(`/orders/${id('W-10007')}/allocate`, {});
      const w7 = await manager.get(`/orders/${id('W-10007')}`);
      const ff2 = (w7.fulfillments as any[]).filter((f) => f.status === 'ready').map((f) => f.id);
      if (ff2.length) {
        const w2 = await manager.post('/waves', { warehouseId: wh.TKY, fulfillmentIds: ff2, label: '入荷分' });
        for (const t of (await manager.get(`/waves/${w2.waveId}`)).tasks as { id: string }[]) {
          const v = await picker.post(`/pick-tasks/${t.id}/claim`, {});
          for (const g of v.groups) if (g.remaining > 0) await picker.post(`/pick-tasks/${t.id}/pick`, { clientEventId: randomUUID(), locationId: g.locationId, code: jan[g.sku], qty: g.remaining, inputMethod: 'scanner' });
        }
        for (const f of ff2) {
          const { sessionId } = await packer.post('/pack/open', { fulfillmentId: f });
          for (const it of (await packer.get(`/pack/sessions/${sessionId}`)).items as any[]) for (let n = 0; n < it.remaining; n++) await packer.post(`/pack/sessions/${sessionId}/scan`, { clientEventId: randomUUID(), code: jan[it.sku], inputMethod: 'scanner' });
          const done = await packer.post(`/pack/sessions/${sessionId}/complete`, { requestId: randomUUID() });
          for (const sh of done.shipments) {
            await manager.patch(`/shipments/${sh.id}`, { carrier: 'yamato', trackingNumber: `9900${String(2000_0000 + seq++).padStart(8, '0')}` });
            await manager.post(`/shipments/${sh.id}/confirm`, {});
          }
        }
      }
      log('分割発送: W-10007 は先に 2 商品を出荷 → ソックス L の入荷後に 2 回目の出荷で完了');

      // ---- 返品・交換 ----
      const shippedOrder = async (ext: string) => {
        const d = await support.get(`/orders/${id(ext)}`);
        return d.status === 'shipped' ? d : null;
      };
      const r1o = await shippedOrder('W-10002');
      if (r1o) {
        const it = r1o.items[0];
        const r = await support.post('/returns', { orderId: r1o.id, reasonCode: 'size_issue', items: [{ orderItemId: it.id, qty: 1 }], customerNote: 'サイズが合わなかった（サンプル）' });
        await support.post(`/returns/${r.id}/authorize`, {});
        const rd = await manager.get(`/returns/${r.id}`);
        await packer.post(`/returns/${r.id}/receive`, { warehouseId: wh.TKY, items: [{ returnItemId: rd.items[0].id, receivedQty: 1 }] });
        await manager.post(`/returns/${r.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: rd.items[0].id, disposition: 'restock', qty: 1 }] });
        log(`返品（Restock）: ${r1o.orderNumber} → 到着（在庫はまだ増えない）→ 検品で再販可 → 在庫に戻る`);
      }
      const r2o = await shippedOrder('W-10004');
      if (r2o) {
        const it = r2o.items[0];
        const r = await support.post('/returns', { orderId: r2o.id, reasonCode: 'damaged_in_transit', items: [{ orderItemId: it.id, qty: 1 }], customerNote: '取っ手が欠けていた（サンプル）' });
        await support.post(`/returns/${r.id}/authorize`, {});
        const rd = await manager.get(`/returns/${r.id}`);
        await packer.post(`/returns/${r.id}/receive`, { warehouseId: wh.TKY, items: [{ returnItemId: rd.items[0].id, receivedQty: 1 }] });
        await manager.post(`/returns/${r.id}/inspect`, { clientRequestId: randomUUID(), lines: [{ returnItemId: rd.items[0].id, disposition: 'damaged', qty: 1, reason: '取っ手の欠け' }] });
        const ex = await support.post(`/returns/${r.id}/exchange`, { items: [{ sku: it.sku, quantity: 1, originalOrderItemId: it.id }] });
        await manager.post(`/orders/${ex.replacementOrderId}/allocate`, {});
        log(`破損返品 → 交換: ${r2o.orderNumber} → 破損として販売可能在庫に戻さない → 交換品の注文（通常の引当 → Wave → Pick → 梱包 → 出荷の流れで処理待ち）`);
      }
      const r3o = await shippedOrder('M-20002');
      if (r3o) {
        await support.post('/returns', { orderId: r3o.id, reasonCode: 'changed_mind', items: [{ orderItemId: r3o.items[0].id, qty: 1 }] });
        log(`返品の受付のみ: ${r3o.orderNumber}（承認待ち）`);
      }
      // 取込後の内容違い（引当済みの注文を別内容で再取込）→ 競合の例外（注文は変更されない）
      const conflictCsv = ordersCsv([{ ...mpaOrders[3]!, lines: [['SC-TOTE-NT', 3]] }], `${today} 10:30:00`);
      const pvc = await owner.upload('/imports/preview', { profileId: profile.MPA }, conflictCsv, 'marketplace-a-orders-revised.csv');
      if (pvc.status === 200) await owner.post(`/imports/${pvc.body.batchId}/commit`, { applyUpdateIds: [] });
      log('引当済みの M-20004 を別内容で再取込 → 競合として例外キューへ（注文は上書きしない）');

      const violations = await withTenant(pool, orgId, SYSTEM_ACTOR, (tx) => checkIntegrity(tx));
      if (violations.length) throw new Error(`整合性チェックで問題: ${JSON.stringify(violations.slice(0, 3))}`);
      const counts = await owner.get('/orders/status-counts');
      console.log(`\n完了（整合性チェック OK）。注文の状態: ${JSON.stringify(counts.counts ?? counts)}`);
      console.log('\nサンプル用アカウント（パスワードはこの表示のみ。サンプル以外の組織には所属していません）:');
      for (const a of accounts) console.log(`  ${a.label.padEnd(20)} ${a.email}  ${a.password}`);
      if (values['owner-email']) console.log(`  ${values['owner-email']} もサンプル組織の Owner に追加しました（画面右上の組織の切り替えで選べます）`);
      console.log('\nシナリオの説明: buyer-docs/サンプル業務説明.txt');
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
    await numberingPool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
