import pg from 'pg';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_test';
/** 「空の環境への復元」テスト用の別 DB（存在しない場合、そのテストはスキップされる） */
export const TEST_RESTORE_DATABASE_URL =
  process.env.TEST_RESTORE_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_test_restore';

async function reset(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.end();
  const pool = createPool({ connectionString: url, max: 2 });
  await migrate(pool);
  await pool.end();
}

export default async function setup() {
  // テスト DB を毎回まっさらにしてマイグレーションを適用
  await reset(TEST_DATABASE_URL);
  try {
    await reset(TEST_RESTORE_DATABASE_URL);
    process.env.TEST_RESTORE_DB_READY = '1';
  } catch {
    process.env.TEST_RESTORE_DB_READY = '0';
  }
}
