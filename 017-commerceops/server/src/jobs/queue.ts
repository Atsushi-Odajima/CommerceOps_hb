import type { Pool, PoolClient } from '../db/pool.js';

export interface JobRow {
  id: number;
  organization_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
  result: unknown;
  created_at: Date;
  finished_at: Date | null;
}

export interface EnqueueInput {
  type: string;
  organizationId?: string | null;
  payload?: Record<string, unknown>;
  /** queued/running の間は同じキーのジョブを重複登録しない（二重実行防止） */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** 返り値: 新規登録したジョブ ID、dedupe で既存がある場合はその既存ジョブ ID（deduped=true） */
export async function enqueue(db: Pool | PoolClient, input: EnqueueInput): Promise<{ id: number; deduped: boolean }> {
  const r = await db.query(
    `INSERT INTO jobs (organization_id, type, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.organizationId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
      input.runAt ?? null,
      input.maxAttempts ?? 5,
    ],
  );
  if (r.rows[0]) return { id: Number(r.rows[0].id), deduped: false };
  const existing = await db.query(
    `SELECT id FROM jobs WHERE dedupe_key = $1 AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
    [input.dedupeKey],
  );
  return { id: Number(existing.rows[0]?.id ?? 0), deduped: true };
}

export async function claimJob(pool: Pool, workerId: string, types?: string[]): Promise<JobRow | null> {
  const r = await pool.query(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now() AND ($2::text[] IS NULL OR type = ANY($2))
         ORDER BY run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING *`,
    [workerId, types ?? null],
  );
  return (r.rows[0] as JobRow) ?? null;
}

export async function completeJob(pool: Pool, id: number, result: unknown): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now(), locked_by = NULL WHERE id = $1`,
    [id, JSON.stringify(result ?? null)],
  );
}

export async function failJob(pool: Pool, job: JobRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const dead = job.attempts >= job.max_attempts;
  const backoffSec = Math.min(3600, 2 ** job.attempts * 5);
  await pool.query(
    `UPDATE jobs
        SET status = $2, last_error = $3, locked_by = NULL,
            run_at = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $4) ELSE run_at END,
            finished_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
      WHERE id = $1`,
    [job.id, dead ? 'dead' : 'queued', message.slice(0, 2000), backoffSec],
  );
}

/** ワーカー停止などで running のまま残ったジョブを再キュー */
export async function recoverStaleJobs(pool: Pool, staleMinutes = 15): Promise<number> {
  const r = await pool.query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`,
    [staleMinutes],
  );
  return r.rowCount ?? 0;
}

export async function getJob(pool: Pool, id: number, organizationId: string): Promise<JobRow | null> {
  const r = await pool.query('SELECT * FROM jobs WHERE id = $1 AND organization_id = $2', [id, organizationId]);
  return (r.rows[0] as JobRow) ?? null;
}
