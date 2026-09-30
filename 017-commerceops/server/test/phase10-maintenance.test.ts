import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers/env.js';
import { locationsOf, manualOrder, receive, setupBasicOrg } from './helpers/scenario.js';
import { analyzeChangedTables, analyzeTables } from '../src/jobs/analyze.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('Phase10 maintenance: statistics refresh for newly added tenant data', () => {
  it('analyzes only allow-listed business tables that changed; names outside the list are never put into SQL', async () => {
    const s = await setupBasicOrg(env);
    const locs = await locationsOf(s.owner.client, s.warehouseId);
    await receive(s.owner.client, locs['A-01']!, s.products['SKU-A']!, 5);
    await manualOrder(s.owner.client, s.channelId, 'AN-1', [{ sku: 'SKU-A', quantity: 1 }]);
    // 変更行数の統計は非同期に反映されるため、しきい値 0（= 全業務テーブル）で許可リストと ANALYZE の実行を確認する
    const r = await analyzeChangedTables(env.deps, 0);
    expect(r.analyzed).toContain('orders');
    expect(r.analyzed.every((t) => !['users', 'sessions', 'jobs', 'schema_migrations'].includes(t))).toBe(true);
    const last = (await env.deps.pool.query(`SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'orders'`)).rows[0].last_analyze;
    expect(Date.now() - new Date(last).getTime()).toBeLessThan(60_000);
    // 許可リスト外（システム表・細工した名前）は無視される
    expect((await analyzeTables(env.deps, ['pg_class', 'orders; DROP TABLE orders', 'users', 'orders'])).analyzed).toEqual(['orders']);
  });
});
