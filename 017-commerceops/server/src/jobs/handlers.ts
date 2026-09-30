import type { AppDeps } from '../http.js';
import type { JobRow } from './queue.js';
import { purgeExpiredSessions } from '../auth/session.js';

export type JobHandler = (deps: AppDeps, job: JobRow) => Promise<unknown>;

/** ジョブ種別 → ハンドラ。各モジュールは registerJobHandler で追加する */
export const jobHandlers: Record<string, JobHandler> = {
  'maintenance.tick': async (deps) => {
    const results: Record<string, unknown> = {};
    results.sessionsPurged = await purgeExpiredSessions(deps.pool);
    for (const [name, fn] of Object.entries(maintenanceTasks)) {
      try {
        results[name] = await fn(deps);
      } catch (e) {
        results[name] = { error: (e as Error).message };
      }
    }
    return results;
  },
};

/** 1 分ごとの保守処理（claim タイムアウト解除、取込ステージング削除など） */
export const maintenanceTasks: Record<string, (deps: AppDeps) => Promise<unknown>> = {};

export function registerJobHandler(type: string, handler: JobHandler) {
  jobHandlers[type] = handler;
}

export function registerMaintenanceTask(name: string, fn: (deps: AppDeps) => Promise<unknown>) {
  maintenanceTasks[name] = fn;
}
