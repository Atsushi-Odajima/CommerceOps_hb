import type { AppDeps } from '../http.js';

/**
 * 運用データの保持期限（業務データ・監査ログは削除しない）。
 * - 完了した Job: 7 日（失敗して打ち切った Job は調査用に 30 日）
 * - ログイン等のセキュリティイベント: 365 日
 * - 使用済み・期限切れのパスワード再設定トークン: 30 日
 * 期限は OPERATIONS.md §8 に記載。
 */
export const RETENTION = { succeededJobsDays: 7, deadJobsDays: 30, securityEventsDays: 365, passwordResetsDays: 30 } as const;

export async function purgeOperationalData(deps: Pick<AppDeps, 'pool'>, r = RETENTION): Promise<{ jobs: number; securityEvents: number; passwordResets: number }> {
  const jobs = await deps.pool.query(
    `DELETE FROM jobs
      WHERE (status = 'succeeded' AND finished_at < now() - make_interval(days => $1))
         OR (status IN ('dead', 'failed') AND COALESCE(finished_at, created_at) < now() - make_interval(days => $2))`,
    [r.succeededJobsDays, r.deadJobsDays],
  );
  const sec = await deps.pool.query(`DELETE FROM security_events WHERE created_at < now() - make_interval(days => $1)`, [r.securityEventsDays]);
  const pr = await deps.pool.query(
    `DELETE FROM password_resets WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - make_interval(days => $1)`,
    [r.passwordResetsDays],
  );
  return { jobs: jobs.rowCount ?? 0, securityEvents: sec.rowCount ?? 0, passwordResets: pr.rowCount ?? 0 };
}
