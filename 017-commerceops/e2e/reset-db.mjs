// E2E 用 DB を空にする（スキーマはサーバー起動時のマイグレーションで作られる）。E2E 専用 DB 以外には使わない
import pg from 'pg';
const url = process.argv[2];
if (!url || !/commerceops_e2e/.test(url)) {
  console.error('refusing to reset a non-e2e database');
  process.exit(2);
}
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE');
await c.query('CREATE SCHEMA public');
await c.end();
