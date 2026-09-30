import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { withTenant, type Tx, SYSTEM_ACTOR, type Actor } from '../../src/db/tx.js';
import type { AppDeps } from '../../src/http.js';
import { MemoryStorage, type Storage } from '../../src/modules/attachments/storage.js';
import { TEST_DATABASE_URL } from '../setup/global.js';

export interface TestEnv {
  app: FastifyInstance;
  deps: AppDeps;
  tx<T>(orgId: string, fn: (tx: Tx) => Promise<T>, actor?: Actor): Promise<T>;
  close(): Promise<void>;
}

export async function createTestEnv(
  overrides: Record<string, string> = {},
  databaseUrl = TEST_DATABASE_URL,
  storage: Storage = new MemoryStorage(),
): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
    RUN_WORKER: 'false',
    APP_BASE_URL: 'http://localhost:5173',
    ...overrides,
  } as NodeJS.ProcessEnv);
  const pool = createPool({ connectionString: databaseUrl, max: 24 });
  const numberingPool = createPool({ connectionString: databaseUrl, max: 3 });
  const deps: AppDeps = { config, pool, numberingPool, storage };
  const app = await buildApp(deps, { logger: false });
  await app.ready();
  return {
    app,
    deps,
    tx: (orgId, fn, actor = SYSTEM_ACTOR) => withTenant(pool, orgId, actor, fn),
    close: async () => {
      await app.close();
      await pool.end();
      await numberingPool.end();
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
}

/** Cookie セッションと CSRF トークンを保持するテスト用 HTTP クライアント（app.inject を使用） */
export class TestClient {
  cookie = '';
  csrf = '';
  userId = '';
  constructor(public readonly app: FastifyInstance) {}

  async request<T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { 'x-requested-with': 'CommerceOps', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && !('x-csrf-token' in headers)) h['x-csrf-token'] = this.csrf;
    const res = await this.app.inject({
      method,
      url,
      headers: h,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const sc = res.headers['set-cookie'];
    for (const c of Array.isArray(sc) ? sc : sc ? [sc] : []) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (name && name.includes('co_sid')) this.cookie = value ? `${name}=${value}` : '';
    }
    let parsed: unknown = undefined;
    const ct = String(res.headers['content-type'] ?? '');
    if (ct.includes('application/json')) parsed = res.json();
    return { status: res.statusCode, body: parsed as T, headers: res.headers as ApiResponse['headers'], text: res.body };
  }

  get<T = any>(url: string) {
    return this.request<T>('GET', url);
  }
  post<T = any>(url: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.request<T>('POST', url, body, headers);
  }
  patch<T = any>(url: string, body: unknown = {}) {
    return this.request<T>('PATCH', url, body);
  }
  put<T = any>(url: string, body: unknown = {}) {
    return this.request<T>('PUT', url, body);
  }
  del<T = any>(url: string) {
    return this.request<T>('DELETE', url);
  }

  async login(email: string, password: string) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
    this.csrf = r.body.csrfToken;
    this.userId = r.body.user.id;
    return r.body;
  }

  async refreshMe() {
    const r = await this.get('/api/auth/me');
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}

/** 期待ステータスでなければ本文付きで失敗させる */
export function expectStatus<T>(res: ApiResponse<T>, status: number): ApiResponse<T> {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status} but got ${res.status}: ${res.text.slice(0, 800)}`);
  }
  return res;
}
