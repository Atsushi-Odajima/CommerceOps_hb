/** 各モジュールの Job / 保守処理を登録（worker 起動時に import される） */
import { registerJobHandler, registerMaintenanceTask } from './handlers.js';
import { runAllocation } from '../modules/allocation/engine.js';
import { expirePickClaims } from '../modules/picking/service.js';
import { purgeImportStaging } from '../modules/imports/maintenance.js';
import { purgeOperationalData } from './retention.js';
import { analyzeChangedTables, analyzeTables } from './analyze.js';

registerMaintenanceTask('imports.purgeStaging', purgeImportStaging, 60);
registerMaintenanceTask('picking.expireClaims', expirePickClaims, 1);
registerMaintenanceTask('retention.purgeOperationalData', purgeOperationalData, 60);

// 統計情報の更新: 変更の多いテーブルを 15 分ごと / 組織の復元・大きな CSV 取込の直後（テーブル名は許可リストのみ）
registerMaintenanceTask('db.analyzeChangedTables', (deps) => analyzeChangedTables(deps), 15);
registerJobHandler('db.analyze', async (deps, job) => analyzeTables(deps, ((job.payload as { tables?: unknown }).tables as string[] | undefined) ?? []));

registerJobHandler('allocation.run', async (deps, job) => {
  if (!job.organization_id) throw new Error('organization required');
  const payload = job.payload as { trigger?: 'manual' | 'job' | 'import'; userId?: string | null; orderIds?: string[] };
  return runAllocation(deps, job.organization_id, { userId: payload.userId ?? null, type: 'job' }, {
    trigger: payload.trigger ?? 'job',
    orderIds: payload.orderIds,
  });
});
