import type { Tx } from '../db/tx.js';

/**
 * 一覧の総件数は上限（1 万件）で打ち切って数える。大きな組織で「全件の件数」を毎回数えると一覧が遅くなるため。
 * 上限を超えた場合は totalCapped = true（画面は「10,000 件以上」と表示し、絞り込みを促す）。
 */
export const LIST_COUNT_CAP = 10_000;

export async function cappedCount(tx: Tx, fromWhere: string, params: readonly unknown[], opts: { prefix?: string; cap?: number } = {}) {
  const cap = opts.cap ?? LIST_COUNT_CAP;
  const n = (await tx.one<{ n: number }>(`${opts.prefix ?? ''}SELECT count(*)::int AS n FROM (SELECT 1 ${fromWhere} LIMIT ${cap + 1}) x`, params)).n;
  return { total: Math.min(n, cap), totalCapped: n > cap };
}
