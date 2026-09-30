import type { AppDeps } from '../http.js';
import type { JobRow } from './queue.js';
import { purgeExpiredSessions } from '../auth/session.js';

export type JobHandler = (deps: AppDeps, job: JobRow) => Promise<unknown>;

/** ジョブ種別 → ハンドラ。各モジュールは registerJobHandler で追加する */
export const jobHandlers: Record<string, JobHandler> = {
  'maintenance.tick': async (deps) => {
    const results: Record<string, unknown> = {};
    results.sessionsPurged = await purgeExpiredSessions(deps.pool);
    for (const [name, task] of Object.entries(maintenanceTasks)) {
      if (Date.now() - task.lastRun < task.everyMinutes * 60_000) continue;
      task.lastRun = Date.now();
      try {
        results[name] = await task.fn(deps);
      } catch (e) {
        results[name] = { error: (e as Error).message };
      }
    }
    return results;
  },
};

/** 定期保守処理（claim タイムアウト解除、取込ステージング削除など）。everyMinutes ごとに実行 */
export const maintenanceTasks: Record<string, { fn: (deps: AppDeps) => Promise<unknown>; everyMinutes: number; lastRun: number }> = {};

export function registerJobHandler(type: string, handler: JobHandler) {
  jobHandlers[type] = handler;
}

export function registerMaintenanceTask(name: string, fn: (deps: AppDeps) => Promise<unknown>, everyMinutes = 1) {
  maintenanceTasks[name] = { fn, everyMinutes, lastRun: 0 };
}
