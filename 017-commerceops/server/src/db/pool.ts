import pg from 'pg';

// int8(bigint) → number（件数等。2^53 未満を前提）、numeric → number（単価表示用）
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// date / time は文字列のまま
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: opts.applicationName ?? 'commerceops',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  pool.on('error', (err) => {
    // アイドル接続のエラー（DB 再起動など）でプロセスを落とさない
    console.error('[pg pool] idle client error', err.message);
  });
  return pool;
}
