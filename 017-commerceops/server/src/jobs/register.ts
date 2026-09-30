/** 各モジュールの Job / 保守処理を登録（worker 起動時に import される） */
import { registerJobHandler, registerMaintenanceTask } from './handlers.js';
import { runAllocation } from '../modules/allocation/engine.js';
import { expirePickClaims } from '../modules/picking/service.js';
import { purgeImportStaging } from '../modules/imports/maintenance.js';

registerMaintenanceTask('imports.purgeStaging', purgeImportStaging, 60);
registerMaintenanceTask('picking.expireClaims', expirePickClaims, 1);

registerJobHandler('allocation.run', async (deps, job) => {
  if (!job.organization_id) throw new Error('organization required');
  const payload = job.payload as { trigger?: 'manual' | 'job' | 'import'; userId?: string | null; orderIds?: string[] };
  return runAllocation(deps, job.organization_id, { userId: payload.userId ?? null, type: 'job' }, {
    trigger: payload.trigger ?? 'job',
    orderIds: payload.orderIds,
  });
});
