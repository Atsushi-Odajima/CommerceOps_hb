import pg from 'pg';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_test';

export default async function setup() {
  // テスト DB を毎回まっさらにしてマイグレーションを適用
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.end();
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await migrate(pool);
  await pool.end();
}
