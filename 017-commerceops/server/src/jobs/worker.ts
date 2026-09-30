import { hostname } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../http.js';
import { claimJob, completeJob, enqueue, failJob, recoverStaleJobs, type JobRow } from './queue.js';
import { jobHandlers } from './handlers.js';
import './register.js';

export interface WorkerHandle {
  stop(): Promise<void>;
  /** テスト用: キューが空になるまで処理 */
  drain(): Promise<number>;
}

const MAINTENANCE_INTERVAL_MS = 60_000;

export async function runJob(deps: AppDeps, job: JobRow): Promise<unknown> {
  const handler = jobHandlers[job.type];
  if (!handler) throw new Error(`no handler for job type ${job.type}`);
  return handler(deps, job);
}

/** 1 件処理。処理したら true */
export async function processOne(deps: AppDeps, workerId: string, log?: FastifyBaseLogger): Promise<boolean> {
  const job = await claimJob(deps.pool, workerId);
  if (!job) return false;
  try {
    const result = await runJob(deps, job);
    await completeJob(deps.pool, job.id, result);
  } catch (err) {
    log?.error({ jobId: job.id, type: job.type, err: (err as Error).message }, 'job failed');
    await failJob(deps.pool, job, err);
  }
  return true;
}

export function startWorker(deps: AppDeps, log?: FastifyBaseLogger, concurrency = 2): WorkerHandle {
  const workerId = `${hostname()}:${process.pid}`;
  let stopped = false;
  let lastMaintenance = 0;

  const loops: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    loops.push(
      (async () => {
        while (!stopped) {
          try {
            if (i === 0 && Date.now() - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
              lastMaintenance = Date.now();
              await recoverStaleJobs(deps.pool);
              await enqueue(deps.pool, { type: 'maintenance.tick', dedupeKey: 'maintenance.tick', maxAttempts: 1 });
            }
            const did = await processOne(deps, `${workerId}#${i}`, log);
            if (!did) await new Promise((r) => setTimeout(r, 1000));
          } catch (err) {
            log?.error({ err: (err as Error).message }, 'worker loop error');
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      })(),
    );
  }

  return {
    async stop() {
      stopped = true;
      await Promise.all(loops);
    },
    async drain() {
      let n = 0;
      while (await processOne(deps, `${workerId}#drain`, log)) n++;
      return n;
    },
  };
}
