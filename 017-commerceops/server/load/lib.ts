/**
 * 負荷・規模検証の共通部品（本番ビルドには含まれない）。
 * アプリをプロセス内で起動し（app.inject）、実際の API（認可・検証・トランザクション・RLS を含む）を呼んで所要時間を測る。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { withSystem } from '../src/db/tx.js';
import type { AppDeps } from '../src/http.js';
import { MemoryStorage } from '../src/modules/attachments/storage.js';
import { createOrganizationWithOwner, findUserByEmail, insertUser, upsertMembership } from '../src/modules/orgs/service.js';
import type { Role } from '../src/auth/permissions.js';

export const LOAD_PASSWORD = 'Load-Test-Passw0rd-2026';

export interface LoadEnv {
  app: FastifyInstance;
  deps: AppDeps;
  pool: Pool;
  close(): Promise<void>;
}

export async function createLoadEnv(databaseUrl: string, poolMax = 24): Promise<LoadEnv> {
  const config = loadConfig({
    NODE_ENV: 'test', // rate limit を外す（負荷の測定対象は処理そのもの）
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
    RUN_WORKER: 'false',
    APP_BASE_URL: 'http://localhost',
  } as NodeJS.ProcessEnv);
  const pool = createPool({ connectionString: databaseUrl, max: poolMax, applicationName: 'commerceops-load' });
  await migrate(pool);
  const numberingPool = createPool({ connectionString: databaseUrl, max: 4 });
  const deps: AppDeps = { config, pool, numberingPool, storage: new MemoryStorage() };
  const app = await buildApp(deps, { logger: false });
  await app.ready();
  return {
    app,
    deps,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
      await numberingPool.end();
    },
  };
}

/** 計測値の集計（ラベルごとの件数・合計・p50/p95/max） */
export class Timings {
  private readonly m = new Map<string, number[]>();
  add(label: string, ms: number) {
    let a = this.m.get(label);
    if (!a) this.m.set(label, (a = []));
    a.push(ms);
  }
  summary() {
    const out: Record<string, { n: number; totalMs: number; p50: number; p95: number; max: number }> = {};
    for (const [k, a] of this.m) {
      const s = [...a].sort((x, y) => x - y);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
      out[k] = { n: s.length, totalMs: Math.round(s.reduce((x, y) => x + y, 0)), p50: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1]!) };
    }
    return out;
  }
  clear() {
    this.m.clear();
  }
}

export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export interface Res<T = any> {
  status: number;
  body: T;
  text: string;
  ms: number;
}

/** Cookie + CSRF を保持する API クライアント（ラベル付きで所要時間を記録） */
export class Client {
  cookie = '';
  csrf = '';
  userId = '';
  constructor(
    public readonly app: FastifyInstance,
    public readonly timings: Timings = new Timings(),
  ) {}

  async request<T = any>(method: string, url: string, body?: unknown, label?: string, raw?: { payload: Buffer; contentType: string }): Promise<Res<T>> {
    const headers: Record<string, string> = { 'x-requested-with': 'CommerceOps' };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    if (raw) headers['content-type'] = raw.contentType;
    const t0 = performance.now();
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(raw ? { payload: raw.payload } : body !== undefined ? { payload: body as object } : {}),
    });
    const ms = performance.now() - t0;
    if (label) this.timings.add(label, ms);
    const sc = res.headers['set-cookie'];
    for (const c of Array.isArray(sc) ? sc : sc ? [sc] : []) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      if (name && name.includes('co_sid')) this.cookie = rest.join('=') ? `${name}=${rest.join('=')}` : '';
    }
    const ct = String(res.headers['content-type'] ?? '');
    return { status: res.statusCode, body: (ct.includes('json') ? res.json() : undefined) as T, text: res.body, ms };
  }

  /** 2xx 以外は例外 */
  async ok<T = any>(method: string, url: string, body?: unknown, label?: string): Promise<T> {
    const r = await this.request<T>(method, url, body, label);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${r.text.slice(0, 400)}`);
    return r.body;
  }
  get<T = any>(url: string, label?: string) {
    return this.ok<T>('GET', url, undefined, label);
  }
  post<T = any>(url: string, body: unknown = {}, label?: string) {
    return this.ok<T>('POST', url, body, label);
  }
  patch<T = any>(url: string, body: unknown = {}, label?: string) {
    return this.ok<T>('PATCH', url, body, label);
  }

  async upload<T = any>(url: string, fields: Record<string, string>, content: Buffer, filename: string, label?: string): Promise<T> {
    const boundary = '----load' + randomUUID().replace(/-/g, '');
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`));
    const r = await this.request<T>('POST', url, undefined, label, { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` });
    if (r.status !== 200) throw new Error(`upload ${url} → ${r.status} ${r.text.slice(0, 400)}`);
    return r.body;
  }

  async login(email: string, password = LOAD_PASSWORD, orgId?: string) {
    const r = await this.request('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.text}`);
    this.csrf = r.body.csrfToken;
    this.userId = r.body.user.id;
    if (orgId && r.body.organization?.id !== orgId) {
      await this.post('/api/auth/switch-org', { organizationId: orgId });
      const me = await this.get('/api/auth/me');
      this.csrf = me.csrfToken;
    }
    return this;
  }
}

/** 組織 + Owner を作ってログイン済みクライアントを返す */
export async function newOrg(env: LoadEnv, name: string, email: string, timings?: Timings) {
  const { organizationId } = await createOrganizationWithOwner(env.pool, { orgName: name, ownerEmail: email, ownerName: 'Load Owner', ownerPassword: LOAD_PASSWORD });
  const owner = await new Client(env.app, timings).login(email, LOAD_PASSWORD, organizationId);
  return { orgId: organizationId, owner };
}

export async function addUser(env: LoadEnv, orgId: string, email: string, role: Role, timings?: Timings) {
  await withSystem(env.pool, async (c) => {
    const existing = await findUserByEmail(c, email);
    const uid = existing?.id ?? (await insertUser(c, { email, name: `${role} (load)`, password: LOAD_PASSWORD }));
    await upsertMembership(c, orgId, uid, role, null);
  });
  return new Client(env.app, timings).login(email, LOAD_PASSWORD, orgId);
}

/** 標準テンプレート形式の注文 CSV（UTF-8 BOM） */
export const STD_HEADERS = ['注文番号', '注文日時', '購入者名', '購入者メール', '購入者電話', '送付先氏名', '郵便番号', '都道府県', '市区町村', '住所1', '住所2', '送付先電話', '配送方法', '備考', 'SKU', '商品名', '数量', '単価'];

const cell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csvOf(rows: Record<string, string | number>[]): Buffer {
  const lines = [STD_HEADERS.join(','), ...rows.map((r) => STD_HEADERS.map((h) => cell(r[h])).join(','))];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

const SEI = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本'];
const MEI = ['太郎', '花子', '一郎', '美咲', '健太', '陽子', '翔', '愛', '大輔', '結衣', '直樹', '由美'];
const PREF = [
  ['東京都', '渋谷区', '150-0001'],
  ['大阪府', '大阪市北区', '530-0001'],
  ['神奈川県', '横浜市中区', '231-0001'],
  ['愛知県', '名古屋市中区', '460-0001'],
  ['福岡県', '福岡市中央区', '810-0001'],
  ['北海道', '札幌市中央区', '060-0001'],
] as const;

/** 疑似乱数（再現可能） */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** 架空の注文（1〜5 明細、平均 3 明細） */
export function fakeOrderRows(ext: string, skus: string[], r: () => number, date: string): Record<string, string | number>[] {
  const name = `${SEI[Math.floor(r() * SEI.length)]} ${MEI[Math.floor(r() * MEI.length)]}`;
  const [pref, city, zip] = PREF[Math.floor(r() * PREF.length)]!;
  const lines = 1 + Math.floor(r() * 5); // 1..5（平均 3）
  const chosen = new Set<string>();
  while (chosen.size < lines) chosen.add(skus[Math.floor(r() * skus.length)]!);
  // 注文単位の値（同じ注文の行では同じでなければならない）
  const header = {
    注文番号: ext,
    注文日時: date,
    購入者名: name,
    購入者メール: `${ext.toLowerCase()}@example.invalid`,
    購入者電話: `090-${String(1000 + Math.floor(r() * 9000))}-${String(1000 + Math.floor(r() * 9000))}`,
    送付先氏名: name,
    郵便番号: zip,
    都道府県: pref,
    市区町村: city,
    住所1: `架空町${1 + Math.floor(r() * 9)}-${1 + Math.floor(r() * 20)}-${1 + Math.floor(r() * 30)}`,
    住所2: '',
    送付先電話: '',
    配送方法: r() < 0.8 ? '宅配便' : 'メール便',
    備考: '',
  };
  return [...chosen].map((sku) => ({
    ...header,
    SKU: sku,
    商品名: `商品 ${sku}`,
    数量: 1 + Math.floor(r() * 3),
    単価: 500 + Math.floor(r() * 50) * 100,
  }));
}
