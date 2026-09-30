import type { Pool } from '../db/pool.js';

export const NUMBER_PREFIX = {
  order: 'SO',
  fulfillment: 'F',
  wave: 'W',
  pick_task: 'PT',
  shipment: 'SH',
  return: 'RT',
  exchange: 'EX',
  exception: 'EXC',
  import_batch: 'IMP',
} as const;

export type NumberKind = keyof typeof NUMBER_PREFIX;

export function formatNumber(kind: NumberKind, n: number): string {
  return `${NUMBER_PREFIX[kind]}-${String(n).padStart(6, '0')}`;
}

/**
 * 組織内連番をまとめて払い出す。
 * 専用の小さな接続プールで即コミットするため、業務トランザクションが長くてもカウンタ行を長時間ロックしない
 * （欠番は許容。ロールバックされた番号は再利用しない）。
 */
export async function nextNumbers(numberingPool: Pool, orgId: string, kind: NumberKind, count = 1): Promise<string[]> {
  if (count <= 0) return [];
  const client = await numberingPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const r = await client.query(
      `INSERT INTO counters (organization_id, name, value) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, name) DO UPDATE SET value = counters.value + EXCLUDED.value
       RETURNING value`,
      [orgId, kind, count],
    );
    await client.query('COMMIT');
    const last = Number(r.rows[0].value);
    const out: string[] = [];
    for (let n = last - count + 1; n <= last; n++) out.push(formatNumber(kind, n));
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
