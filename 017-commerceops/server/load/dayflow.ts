/**
 * 1 日 50 / 500 / 5,000 注文相当の業務を実 API で流し、工程ごとの所要時間と API の応答時間を測る。
 *   npx tsx load/dayflow.ts --db postgres://.../commerceops_load --volumes 50,500,5000 [--pickers 4 --packers 4] [--scarce 0]
 * 各規模ごとに新しい組織を作る（既存データの量の影響は scale.ts で別に測る）。結果は load/results/dayflow-*.json。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SYSTEM_ACTOR, withTenant } from '../src/db/tx.js';
import { checkIntegrity } from '../src/modules/integrity/check.js';
import { addUser, createLoadEnv, newOrg, Timings } from './lib.js';
import { runFlow, setupMaster } from './flow.js';
import { analyzeChangedTables } from '../src/jobs/analyze.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: process.env.LOAD_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_load' },
    volumes: { type: 'string', default: '50,500,5000' },
    pickers: { type: 'string', default: '4' },
    packers: { type: 'string', default: '4' },
    scarce: { type: 'string', default: '0' },
    // 工程の区切りで統計情報を更新する（実運用では保守処理が 1 時間ごとに実行。1 日分を数分で流すため代わりに呼ぶ）
    analyze: { type: 'boolean', default: false },
    tag: { type: 'string', default: '' },
  },
});

const env = await createLoadEnv(values.db!);
const results: any[] = [];
try {
  for (const v of values.volumes!.split(',').map(Number)) {
    const timings = new Timings();
    const stamp = Date.now().toString(36);
    const { orgId, owner } = await newOrg(env, `負荷検証 ${v}件/日 ${stamp}`, `load-${v}-${stamp}@example.invalid`, timings);
    const master = await setupMaster(owner, { skus: 40, stockPerSku: Math.max(200, v * 2), scarceSkus: Number(values.scarce) });
    const pickers = await Promise.all(Array.from({ length: Number(values.pickers) }, (_, i) => addUser(env, orgId, `picker${i}-${v}-${stamp}@example.invalid`, 'picker', timings)));
    const packers = await Promise.all(Array.from({ length: Number(values.packers) }, (_, i) => addUser(env, orgId, `packer${i}-${v}-${stamp}@example.invalid`, 'packer', timings)));
    timings.clear();
    let analyzeMs = 0;
    const t0 = performance.now();
    const r = await runFlow(owner, master, {
      orders: v,
      seed: v,
      extPrefix: `D${v}-${stamp}-`,
      date: new Date().toISOString().slice(0, 10) + ' 09:00:00',
      pickers,
      packers,
      searchSamples: 10,
      between: values.analyze
        ? async () => {
            const a0 = performance.now();
            await analyzeChangedTables(env.deps, 500);
            analyzeMs += performance.now() - a0;
          }
        : undefined,
    });
    const totalMs = Math.round(performance.now() - t0 - analyzeMs);
    const it0 = performance.now();
    const violations = await withTenant(env.pool, orgId, SYSTEM_ACTOR, (tx) => checkIntegrity(tx));
    const integrityMs = Math.round(performance.now() - it0);
    const row = { volume: v, totalMs, analyzeMs: Math.round(analyzeMs), steps: r.steps, counts: r.counts, integrity: { violations: violations.length, ms: integrityMs }, api: timings.summary() };
    results.push(row);
    console.log(`\n=== ${v} orders/day: total ${(totalMs / 1000).toFixed(1)}s, integrity ${violations.length ? 'NG ' + JSON.stringify(violations.slice(0, 3)) : 'OK'} (${integrityMs}ms)${values.analyze ? `, analyze ${Math.round(analyzeMs)}ms (not included)` : ''}`);
    console.log('steps (ms):', JSON.stringify(r.steps));
    console.log('counts:', JSON.stringify(r.counts));
    for (const [k, s] of Object.entries(row.api)) console.log(`  ${k.padEnd(24)} n=${String(s.n).padStart(6)} p50=${String(s.p50).padStart(7)}ms p95=${String(s.p95).padStart(7)}ms max=${String(s.max).padStart(7)}ms`);
  }
} finally {
  await env.close();
}
mkdirSync(new URL('../../load/results/', import.meta.url), { recursive: true });
const out = new URL(`../../load/results/dayflow-${values.tag || new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ createdAt: new Date().toISOString(), db: values.db!.replace(/:[^:@/]+@/, ':***@'), results }, null, 2));
console.log(`\nresults: ${out.pathname}`);
