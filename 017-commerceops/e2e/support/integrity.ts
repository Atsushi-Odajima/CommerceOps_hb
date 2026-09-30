import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_e2e';
export const E2E_RESTORE_DB = process.env.E2E_RESTORE_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_e2e_restore';

/** サーバーの整合性チェック CLI（npm run integrity）を E2E の DB に対して実行 */
export async function integrityOk(orgId: string, db = E2E_DB): Promise<boolean> {
  try {
    execFileSync('npx', ['tsx', 'src/scripts/integrity-cli.ts', '--org', orgId], { cwd: join(here, '../../server'), env: { ...process.env, DATABASE_URL: db }, stdio: 'pipe', timeout: 120_000 });
    return true;
  } catch (e) {
    console.error(String((e as { stdout?: Buffer }).stdout ?? e));
    return false;
  }
}

/** 検証用の読み取り（組織スコープ = RLS の app.org_id を設定） */
export async function sql<T = any>(orgId: string, text: string, params: unknown[] = [], db = E2E_DB): Promise<T[]> {
  const c = new pg.Client({ connectionString: db });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return r.rows as T[];
  } finally {
    await c.end();
  }
}
