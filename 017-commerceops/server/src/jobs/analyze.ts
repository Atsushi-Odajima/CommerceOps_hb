import type { AppDeps } from '../http.js';
import { BACKUP_TABLES } from '../modules/backup/format.js';

const ALLOWED = new Set<string>(BACKUP_TABLES);

/**
 * 統計情報の更新（保守: 15 分ごと）。前回の ANALYZE 以降に一定数以上の行が変わった業務テーブルだけを対象にする。
 * 組織が少ない DB では全組織が統計の「よく出る値」に入るため、後から作った組織（や復元した組織）は次の ANALYZE まで
 * 行数 1 と見積もられ、入れ子ループが行数の 2 乗で遅くなる（負荷検証で注文詳細 6ms → 293ms）。
 * PostgreSQL の自動 ANALYZE は大きなテーブルでは変更率 10% まで走らないため、変更行数の絶対値で補う。
 */
export async function analyzeChangedTables(deps: Pick<AppDeps, 'pool'>, minChanges = 500): Promise<{ analyzed: string[] }> {
  const rows = (
    await deps.pool.query(
      `SELECT relname FROM pg_stat_user_tables WHERE schemaname = current_schema() AND n_mod_since_analyze >= $1 ORDER BY n_mod_since_analyze DESC`,
      [minChanges],
    )
  ).rows as { relname: string }[];
  return analyzeTables(deps, rows.map((r) => r.relname));
}

/** 許可リストのテーブルだけ ANALYZE（テーブル名を SQL に埋め込むため） */
export async function analyzeTables(deps: Pick<AppDeps, 'pool'>, tables: readonly string[]): Promise<{ analyzed: string[] }> {
  const analyzed: string[] = [];
  for (const t of tables) {
    if (!ALLOWED.has(t)) continue;
    await deps.pool.query(`ANALYZE ${t}`);
    analyzed.push(t);
  }
  return { analyzed };
}
