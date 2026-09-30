import { withTenant } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';

/**
 * 取込ステージング（個人情報を含む正規化データ）の保持期限処理。
 * - プレビューのまま 24 時間経過 → expired
 * - 確定/取消/期限切れから 7 日経過 → 正規化データを削除（件数・判定結果は残す）
 */
export async function purgeImportStaging(deps: AppDeps): Promise<{ orgs: number; expired: number; purged: number }> {
  const orgs = (await deps.pool.query(`SELECT id FROM organizations WHERE status = 'active'`)).rows as { id: string }[];
  let expired = 0;
  let purged = 0;
  for (const o of orgs) {
    await withTenant(deps.pool, o.id, { userId: null, type: 'job' }, async (tx) => {
      expired += await tx.exec(
        `UPDATE import_batches SET status = 'expired' WHERE organization_id = $1 AND status = 'previewed' AND created_at < now() - interval '24 hours'`,
        [tx.orgId],
      );
      purged += await tx.exec(
        `UPDATE import_batch_orders bo SET normalized = NULL
           FROM import_batches b
          WHERE bo.organization_id = $1 AND b.organization_id = bo.organization_id AND b.id = bo.batch_id AND bo.normalized IS NOT NULL
            AND b.status IN ('committed', 'cancelled', 'expired') AND COALESCE(b.committed_at, b.created_at) < now() - interval '7 days'`,
        [tx.orgId],
      );
    });
  }
  return { orgs: orgs.length, expired, purged };
}
