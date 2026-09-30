import type { Pool, PoolClient } from './pool.js';
import { isRetryableTxError } from '../lib/errors.js';

export interface Actor {
  userId: string | null;
  type: 'user' | 'system' | 'job';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export const SYSTEM_ACTOR: Actor = { userId: null, type: 'system' };

/**
 * テナント（組織）スコープのトランザクション。
 * app.org_id を SET LOCAL 相当で設定し、RLS により他組織の行は不可視になる。
 */
export class Tx {
  constructor(
    public readonly client: PoolClient,
    public readonly orgId: string,
    public readonly actor: Actor,
  ) {}

  async many<T = Record<string, any>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const r = await this.client.query(sql, params as unknown[]);
    return r.rows as T[];
  }

  async maybeOne<T = Record<string, any>>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const r = await this.client.query(sql, params as unknown[]);
    if (r.rows.length > 1) throw new Error(`expected at most one row, got ${r.rows.length}`);
    return (r.rows[0] as T) ?? null;
  }

  async one<T = Record<string, any>>(sql: string, params: readonly unknown[] = []): Promise<T> {
    const r = await this.client.query(sql, params as unknown[]);
    if (r.rows.length !== 1) throw new Error(`expected exactly one row, got ${r.rows.length}`);
    return r.rows[0] as T;
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    const r = await this.client.query(sql, params as unknown[]);
    return r.rowCount ?? 0;
  }

  /** トランザクション内のセーブポイント（部分的な失敗を握りつぶしたい場合のみ使う） */
  async savepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const r = await fn();
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return r;
    } catch (e) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    }
  }
}

export interface TenantTxOptions {
  /** 40001/40P01（シリアライズ失敗/デッドロック）時の再試行回数 */
  retries?: number;
}

export async function withTenant<T>(
  pool: Pool,
  orgId: string,
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
  opts: TenantTxOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
        [orgId, actor.userId ?? ''],
      );
      const result = await fn(new Tx(client, orgId, actor));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt < retries && isRetryableTxError(err)) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** 組織コンテキストを持たないシステム用トランザクション（認証・組織作成・Job キュー） */
export async function withSystem<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
