import type { Pool, PoolClient } from '../db/pool.js';
import { randomToken, sha256Buf } from '../lib/hash.js';
import { uuidv7 } from '../lib/uuid.js';
import { isRole, permissionsFor } from './permissions.js';
import { parseOrgSettings, type AuthContext } from './context.js';

export interface SessionConfig {
  idleHours: number;
  absoluteDays: number;
}

export async function createSession(
  client: PoolClient | Pool,
  userId: string,
  organizationId: string | null,
  cfg: SessionConfig,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; sessionId: string; csrfToken: string }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const sessionId = uuidv7();
  await client.query(
    `INSERT INTO sessions (id, token_hash, user_id, organization_id, csrf_token, idle_expires_at, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), now() + make_interval(days => $7), $8, $9)`,
    [
      sessionId,
      sha256Buf(token),
      userId,
      organizationId,
      csrfToken,
      cfg.idleHours,
      cfg.absoluteDays,
      meta.ip ?? null,
      (meta.userAgent ?? '').slice(0, 300) || null,
    ],
  );
  return { token, sessionId, csrfToken };
}

export async function loadSession(pool: Pool, token: string, cfg: SessionConfig): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const r = await pool.query(
    `SELECT s.id, s.user_id, s.organization_id, s.csrf_token, s.last_seen_at,
            u.name AS user_name, u.email, u.status AS user_status,
            m.role, m.warehouse_ids, m.status AS membership_status,
            o.name AS org_name, o.timezone, o.is_sample, o.settings, o.status AS org_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id
       LEFT JOIN organizations o ON o.id = s.organization_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.idle_expires_at > now()`,
    [sha256Buf(token)],
  );
  const row = r.rows[0];
  if (!row || row.user_status !== 'active') return null;

  // 最終アクセスの更新は 60 秒に 1 回まで（書き込み削減）
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await pool.query(
      `UPDATE sessions SET last_seen_at = now(), idle_expires_at = LEAST(expires_at, now() + make_interval(hours => $2))
        WHERE id = $1`,
      [row.id, cfg.idleHours],
    );
  }

  const hasOrg =
    row.organization_id && row.membership_status === 'active' && row.org_status === 'active' && isRole(row.role);
  return {
    sessionId: row.id,
    userId: row.user_id,
    userName: row.user_name,
    email: row.email,
    csrfToken: row.csrf_token,
    org: hasOrg
      ? {
          id: row.organization_id,
          name: row.org_name,
          timezone: row.timezone,
          isSample: row.is_sample,
          settings: parseOrgSettings(row.settings),
        }
      : null,
    role: hasOrg ? row.role : null,
    permissions: hasOrg ? permissionsFor(row.role) : new Set(),
    warehouseIds: hasOrg ? (row.warehouse_ids ?? null) : null,
  };
}

export async function destroySession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function destroyUserSessions(client: PoolClient | Pool, userId: string, exceptSessionId?: string) {
  await client.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)', [
    userId,
    exceptSessionId ?? null,
  ]);
}

export async function purgeExpiredSessions(pool: Pool): Promise<number> {
  const r = await pool.query('DELETE FROM sessions WHERE expires_at < now() OR idle_expires_at < now()');
  return r.rowCount ?? 0;
}
