/**
 * 整合性チェック（在庫台帳・引当・Pick/Pack・出荷・返品・参照関係）。読み取りのみ。
 *   npm run integrity -w server -- --all
 *   npm run integrity -w server -- --org <組織ID>
 * 本番（ビルド済み）: node dist/scripts/integrity-cli.js --all
 * 違反があれば内容を表示して終了コード 1（監視・定期実行に使える）。
 */
import { parseArgs } from 'node:util';
import { createPool } from '../db/pool.js';
import { SYSTEM_ACTOR, withTenant } from '../db/tx.js';
import { checkIntegrity } from '../modules/integrity/check.js';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    all: { type: 'boolean', default: false },
  },
});

async function main() {
  if (!values.org && !values.all) {
    console.error('usage: integrity (--all | --org <組織ID>)');
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool({ connectionString: url, max: 2, ssl: ['1', 'true'].includes(process.env.DATABASE_SSL ?? ''), applicationName: 'commerceops-integrity' });
  let bad = 0;
  try {
    const orgs = values.all
      ? (await pool.query('SELECT id, name FROM organizations ORDER BY created_at')).rows
      : (await pool.query('SELECT id, name FROM organizations WHERE id = $1', [values.org])).rows;
    if (!orgs.length) throw new Error('organization not found');
    for (const o of orgs) {
      const started = Date.now();
      const violations = await withTenant(pool, o.id, SYSTEM_ACTOR, (tx) => checkIntegrity(tx));
      const ms = Date.now() - started;
      if (violations.length) {
        bad++;
        console.log(`NG  ${o.name} (${o.id})  ${violations.length} violation(s)  ${ms}ms`);
        for (const v of violations.slice(0, 50)) console.log(`    ${JSON.stringify(v)}`);
      } else {
        console.log(`OK  ${o.name} (${o.id})  ${ms}ms`);
      }
    }
  } finally {
    await pool.end();
  }
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
