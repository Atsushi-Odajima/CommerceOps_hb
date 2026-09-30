import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withSystem } from '../db/tx.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { randomToken, sha256Buf, sha256Hex } from '../lib/hash.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../lib/password.js';
import { uuidv7 } from '../lib/uuid.js';
import { parse } from '../lib/validate.js';
import { requireAuth } from '../http.js';
import { ROLE_LABELS } from './permissions.js';
import { clearSessionCookie, setSessionCookie } from './plugin.js';
import { createSession, destroySession, destroyUserSessions } from './session.js';
import { createOrganizationWithOwner, findUserByEmail, insertUser, upsertMembership } from '../modules/orgs/service.js';

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

const LoginBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

const PasswordField = z.string().min(1).max(200);

async function recordSecurityEvent(
  app: FastifyInstance,
  e: { userId?: string | null; email?: string; type: string; ip?: string; userAgent?: string },
) {
  await app.deps.pool.query(
    `INSERT INTO security_events (id, user_id, email_hash, event_type, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      uuidv7(),
      e.userId ?? null,
      e.email ? sha256Hex(e.email.toLowerCase()).slice(0, 32) : null,
      e.type,
      e.ip ?? null,
      (e.userAgent ?? '').slice(0, 300) || null,
    ],
  );
}

async function membershipsOf(app: FastifyInstance, userId: string) {
  const r = await app.deps.pool.query(
    `SELECT m.organization_id, o.name, m.role, o.is_sample
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
      ORDER BY o.is_sample, m.created_at`,
    [userId],
  );
  return r.rows.map((row) => ({
    organizationId: row.organization_id as string,
    name: row.name as string,
    role: row.role as string,
    roleLabel: ROLE_LABELS[row.role as keyof typeof ROLE_LABELS],
    isSample: row.is_sample as boolean,
  }));
}

export function meResponse(app: FastifyInstance, auth: NonNullable<import('fastify').FastifyRequest['auth']>, memberships: unknown) {
  return {
    user: { id: auth.userId, name: auth.userName, email: auth.email },
    organization: auth.org
      ? {
          id: auth.org.id,
          name: auth.org.name,
          timezone: auth.org.timezone,
          isSample: auth.org.isSample,
          settings: auth.org.settings,
        }
      : null,
    role: auth.role,
    roleLabel: auth.role ? ROLE_LABELS[auth.role] : null,
    permissions: [...auth.permissions],
    warehouseIds: auth.warehouseIds,
    csrfToken: auth.csrfToken,
    memberships,
  };
}

export async function authRoutes(app: FastifyInstance) {
  const { pool, config } = app.deps;
  const sessionCfg = { idleHours: config.SESSION_IDLE_HOURS, absoluteDays: config.SESSION_ABSOLUTE_DAYS };

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = parse(LoginBody, req.body);
      const user = await findUserByEmail(pool, body.email);
      const locked = user?.locked_until && new Date(user.locked_until) > new Date();
      const ok = await verifyPassword(body.password, user?.status === 'active' ? user.password_hash : null);

      if (!user || !ok || locked || user.status !== 'active') {
        if (user && !locked) {
          await pool.query(
            `UPDATE users
                SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                    locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
                    updated_at = now()
              WHERE id = $1`,
            [user.id, LOCK_THRESHOLD, LOCK_MINUTES],
          );
        }
        await recordSecurityEvent(app, {
          userId: user?.id,
          email: body.email,
          type: locked ? 'login_locked' : 'login_failed',
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが正しくありません');
      }

      await pool.query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1`,
        [user.id],
      );
      const memberships = await membershipsOf(app, user.id);
      const recent = await pool.query(
        `SELECT s.organization_id FROM sessions s
           JOIN memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id AND m.status = 'active'
          WHERE s.user_id = $1 AND s.organization_id IS NOT NULL
          ORDER BY s.last_seen_at DESC LIMIT 1`,
        [user.id],
      );
      const orgId = recent.rows[0]?.organization_id ?? memberships[0]?.organizationId ?? null;
      const { token } = await createSession(pool, user.id, orgId, sessionCfg, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await recordSecurityEvent(app, { userId: user.id, type: 'login_success', ip: req.ip, userAgent: req.headers['user-agent'] });
      setSessionCookie(app, reply, token);
      // 新しいセッションの内容を返す
      const { loadSession } = await import('./session.js');
      const auth = await loadSession(pool, token, sessionCfg);
      if (!auth) throw unauthorized();
      return meResponse(app, auth, memberships);
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) await destroySession(pool, req.auth.sessionId);
    clearSessionCookie(app, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const auth = requireAuth(req);
    return meResponse(app, auth, await membershipsOf(app, auth.userId));
  });

  app.post('/api/auth/switch-org', async (req) => {
    const auth = requireAuth(req);
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), req.body);
    const m = await pool.query(
      `SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active' AND o.status = 'active'`,
      [organizationId, auth.userId],
    );
    if (!m.rowCount) throw new AppError(403, 'NOT_A_MEMBER', 'この組織のメンバーではありません');
    const csrf = randomToken(24);
    await pool.query('UPDATE sessions SET organization_id = $2, csrf_token = $3 WHERE id = $1', [
      auth.sessionId,
      organizationId,
      csrf,
    ]);
    return { ok: true };
  });

  app.post('/api/auth/change-password', async (req) => {
    const auth = requireAuth(req);
    const body = parse(z.object({ currentPassword: PasswordField, newPassword: PasswordField }), req.body);
    const u = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [auth.userId])).rows[0];
    if (!(await verifyPassword(body.currentPassword, u?.password_hash))) {
      throw badRequest('INVALID_PASSWORD', '現在のパスワードが正しくありません');
    }
    const weak = validatePasswordStrength(body.newPassword);
    if (weak) throw badRequest('WEAK_PASSWORD', weak);
    await pool.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [
      auth.userId,
      await hashPassword(body.newPassword),
    ]);
    await destroyUserSessions(pool, auth.userId, auth.sessionId);
    await recordSecurityEvent(app, { userId: auth.userId, type: 'password_changed', ip: req.ip });
    return { ok: true };
  });

  // ---- 招待 ----
  const TokenBody = z.object({ token: z.string().min(20).max(200) });

  async function findInvitation(token: string) {
    const r = await pool.query(
      `SELECT i.*, o.name AS org_name FROM invitations i JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [sha256Buf(token)],
    );
    return r.rows[0] ?? null;
  }

  app.post('/api/auth/invitations/preview', async (req) => {
    const { token } = parse(TokenBody, req.body);
    const inv = await findInvitation(token);
    if (!inv) throw new AppError(404, 'INVITATION_INVALID', '招待リンクが無効か期限切れです');
    const existing = await findUserByEmail(pool, inv.email);
    return {
      organizationName: inv.org_name,
      email: inv.email,
      name: inv.name,
      role: inv.role,
      roleLabel: ROLE_LABELS[inv.role as keyof typeof ROLE_LABELS],
      existingUser: !!existing && existing.status === 'active',
    };
  });

  app.post('/api/auth/invitations/accept', async (req, reply) => {
    const body = parse(
      TokenBody.extend({ name: z.string().trim().min(1).max(100).optional(), password: PasswordField }),
      req.body,
    );
    const inv = await findInvitation(body.token);
    if (!inv) throw new AppError(404, 'INVITATION_INVALID', '招待リンクが無効か期限切れです');
    const existing = await findUserByEmail(pool, inv.email);
    let userId: string;
    if (existing && existing.status === 'disabled') {
      throw new AppError(403, 'ACCOUNT_DISABLED', 'このアカウントは無効化されています');
    }
    if (existing && existing.status === 'active') {
      // 既存ユーザーは自分のパスワードで本人確認（パスワード未設定のアカウントは常に不一致）
      if (!(await verifyPassword(body.password, existing.password_hash))) {
        throw badRequest('INVALID_PASSWORD', '既存アカウントのパスワードが正しくありません');
      }
      userId = existing.id;
    } else {
      if (existing) {
        // パスワード未設定の既存アカウント（復元で作成された等）が他の組織に所属している場合、
        // 招待の承諾でパスワードを設定させない（招待リンクは発行した Owner も開けるため、他組織のアカウント乗っ取りになる）
        const other = await pool.query(
          `SELECT 1 FROM memberships WHERE user_id = $1 AND organization_id <> $2 LIMIT 1`,
          [existing.id, inv.organization_id],
        );
        if (other.rowCount) {
          throw new AppError(
            409,
            'ACCOUNT_NEEDS_RESET',
            'このメールアドレスのアカウントは他の組織にも所属しています。所属先から発行されたパスワード再設定リンクでパスワードを設定してから、招待を承諾してください',
          );
        }
      }
      const weak = validatePasswordStrength(body.password);
      if (weak) throw badRequest('WEAK_PASSWORD', weak);
      userId = await withSystem(pool, async (client) => {
        if (existing) {
          await client.query(
            `UPDATE users SET name = $2, password_hash = $3, status = 'active', password_changed_at = now(), updated_at = now() WHERE id = $1`,
            [existing.id, body.name ?? existing.name, await hashPassword(body.password)],
          );
          return existing.id as string;
        }
        return insertUser(client, { email: inv.email, name: body.name ?? inv.name ?? inv.email, password: body.password });
      });
    }
    await withSystem(pool, async (client) => {
      const upd = await client.query(
        `UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [inv.id],
      );
      if (!upd.rowCount) throw new AppError(409, 'INVITATION_USED', 'この招待は既に使用されています');
      await upsertMembership(client, inv.organization_id, userId, inv.role, inv.warehouse_ids);
    });
    const { token } = await createSession(pool, userId, inv.organization_id, sessionCfg, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(app, reply, token);
    await recordSecurityEvent(app, { userId, type: 'invitation_accepted', ip: req.ip });
    return { ok: true };
  });

  // ---- パスワードリセット（Owner が発行したリンク） ----
  app.post('/api/auth/password-reset', async (req) => {
    const body = parse(TokenBody.extend({ newPassword: PasswordField }), req.body);
    const weak = validatePasswordStrength(body.newPassword);
    if (weak) throw badRequest('WEAK_PASSWORD', weak);
    const hash = await hashPassword(body.newPassword);
    const userId = await withSystem(pool, async (client) => {
      const r = await client.query(
        `UPDATE password_resets SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256Buf(body.token)],
      );
      if (!r.rowCount) throw new AppError(404, 'RESET_INVALID', 'リセットリンクが無効か期限切れです');
      const uid = r.rows[0].user_id as string;
      await client.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL,
                          status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, updated_at = now()
          WHERE id = $1 AND status <> 'disabled'`,
        [uid, hash],
      );
      await destroyUserSessions(client, uid);
      return uid;
    });
    await recordSecurityEvent(app, { userId, type: 'password_reset', ip: req.ip });
    return { ok: true };
  });

  // ---- セルフサインアップ（ALLOW_SIGNUP=true の場合のみ） ----
  app.post(
    '/api/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (!config.ALLOW_SIGNUP) throw new AppError(404, 'NOT_FOUND', 'Not found');
      const body = parse(
        z.object({
          organizationName: z.string().trim().min(1).max(200),
          name: z.string().trim().min(1).max(100),
          email: z.email().max(254),
          password: PasswordField,
        }),
        req.body,
      );
      const weak = validatePasswordStrength(body.password);
      if (weak) throw badRequest('WEAK_PASSWORD', weak);
      if (await findUserByEmail(pool, body.email)) {
        throw new AppError(409, 'EMAIL_TAKEN', 'このメールアドレスは既に登録されています');
      }
      const { organizationId, userId } = await createOrganizationWithOwner(pool, {
        orgName: body.organizationName,
        ownerEmail: body.email,
        ownerName: body.name,
        ownerPassword: body.password,
      });
      const { token } = await createSession(pool, userId, organizationId, sessionCfg, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setSessionCookie(app, reply, token);
      return { ok: true };
    },
  );
}
