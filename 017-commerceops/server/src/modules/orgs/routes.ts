import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orgTx, perm, requireOrg } from '../../http.js';
import { withSystem } from '../../db/tx.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { randomToken, sha256Buf } from '../../lib/hash.js';
import { uuidv7 } from '../../lib/uuid.js';
import { parse } from '../../lib/validate.js';
import { OrgSettingsSchema, parseOrgSettings } from '../../auth/context.js';
import { PERMISSIONS, ROLES, ROLE_LABELS, isRole, permissionsFor } from '../../auth/permissions.js';
import { audit } from '../audit/audit.js';
import { destroyUserSessions } from '../../auth/session.js';

const RoleEnum = z.enum(ROLES);

export async function orgRoutes(app: FastifyInstance) {
  const { pool, config } = app.deps;

  app.get('/api/org', async (req) => {
    const auth = requireOrg(req);
    const r = await pool.query('SELECT id, name, timezone, is_sample, settings, created_at FROM organizations WHERE id = $1', [auth.org.id]);
    const o = r.rows[0];
    return { id: o.id, name: o.name, timezone: o.timezone, isSample: o.is_sample, settings: parseOrgSettings(o.settings), createdAt: o.created_at };
  });

  app.patch('/api/org', { preHandler: perm('org.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200).optional(),
        timezone: z.string().trim().max(60).optional(),
        settings: OrgSettingsSchema.optional(),
      }),
      req.body,
    );
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
      } catch {
        throw conflict('INVALID_TIMEZONE', 'タイムゾーンが不正です');
      }
    }
    await withSystem(pool, async (c) => {
      const cur = (await c.query('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [auth.org.id])).rows[0];
      await c.query('UPDATE organizations SET name = $2, timezone = $3, settings = $4, updated_at = now() WHERE id = $1', [
        auth.org.id,
        body.name ?? cur.name,
        body.timezone ?? cur.timezone,
        JSON.stringify(body.settings ?? parseOrgSettings(cur.settings)),
      ]);
    });
    await orgTx(req, (tx) => audit(tx, { action: 'org.update', entityType: 'organization', entityId: auth.org.id, metadata: { fields: Object.keys(body) } }));
    return { ok: true };
  });

  // ---------------- users / memberships ----------------
  app.get('/api/users', { preHandler: perm('users.manage') }, async (req) => {
    const auth = requireOrg(req);
    const r = await pool.query(
      `SELECT u.id, u.email, u.name, u.status AS user_status, u.last_login_at, m.role, m.warehouse_ids, m.status, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY m.status, m.role, u.name`,
      [auth.org.id],
    );
    return {
      items: r.rows.map((u) => ({
        userId: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        roleLabel: ROLE_LABELS[u.role as keyof typeof ROLE_LABELS],
        warehouseIds: u.warehouse_ids,
        status: u.status,
        userStatus: u.user_status,
        lastLoginAt: u.last_login_at,
        joinedAt: u.created_at,
      })),
    };
  });

  /** 作業割当の候補（指定権限を持つ有効メンバー。倉庫指定時はその倉庫にアクセスできる人のみ）。メール等は返さない */
  app.get('/api/users/assignable', { preHandler: perm('waves.manage', 'fulfillment.manage', 'exceptions.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(z.object({ perm: z.enum(PERMISSIONS), warehouseId: z.uuid().optional() }), req.query);
    const r = await pool.query(
      `SELECT u.id, u.name, m.role, m.warehouse_ids
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.status = 'active' AND u.status = 'active'
        ORDER BY u.name`,
      [auth.org.id],
    );
    const items = r.rows
      .filter((m) => isRole(m.role) && permissionsFor(m.role).has(q.perm))
      .filter((m) => !q.warehouseId || m.warehouse_ids === null || m.warehouse_ids.includes(q.warehouseId))
      .map((m) => ({ userId: m.id, name: m.name, role: m.role, roleLabel: ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] }));
    return { items };
  });

  app.patch('/api/users/:userId', { preHandler: perm('users.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { userId } = parse(z.object({ userId: z.uuid() }), req.params);
    const body = parse(
      z.object({
        role: RoleEnum.optional(),
        warehouseIds: z.array(z.uuid()).max(100).nullable().optional(),
        status: z.enum(['active', 'disabled']).optional(),
      }),
      req.body,
    );
    if (body.warehouseIds && body.warehouseIds.length) {
      await orgTx(req, async (tx) => {
        const n = (await tx.one('SELECT count(*)::int AS n FROM warehouses WHERE organization_id = $1 AND id = ANY($2)', [tx.orgId, body.warehouseIds])).n;
        if (n !== new Set(body.warehouseIds).size) throw conflict('INVALID_WAREHOUSE', '存在しない倉庫が指定されています');
      });
    }
    await withSystem(pool, async (c) => {
      // 同一組織の membership を行ロックし、最後の Owner を失わないことを保証
      const members = (
        await c.query(`SELECT user_id, role, status, warehouse_ids FROM memberships WHERE organization_id = $1 FOR UPDATE`, [auth.org.id])
      ).rows;
      const target = members.find((m) => m.user_id === userId);
      if (!target) throw notFound('メンバー');
      const newRole = body.role ?? target.role;
      const newStatus = body.status ?? target.status;
      const activeOwnersAfter = members.filter((m) =>
        m.user_id === userId ? newRole === 'owner' && newStatus === 'active' : m.role === 'owner' && m.status === 'active',
      ).length;
      if (activeOwnersAfter === 0) throw conflict('LAST_OWNER', '最後の Owner を降格・無効化することはできません');
      const newScope = body.warehouseIds === undefined ? target.warehouse_ids : body.warehouseIds && body.warehouseIds.length ? body.warehouseIds : null;
      await c.query(
        `UPDATE memberships SET role = $3, warehouse_ids = $4, status = $5, updated_at = now() WHERE organization_id = $1 AND user_id = $2`,
        [auth.org.id, userId, newRole, newScope, newStatus],
      );
      if (newStatus === 'disabled' || newRole !== target.role) {
        // 無効化・ロール変更したユーザーのこの組織のセッションを破棄（権限を即時反映）
        await c.query('DELETE FROM sessions WHERE user_id = $1 AND organization_id = $2 AND user_id <> $3', [userId, auth.org.id, auth.userId]);
      }
    });
    await orgTx(req, (tx) =>
      audit(tx, { action: 'user.membership_update', entityType: 'user', entityId: userId, metadata: { role: body.role, status: body.status, warehouseScope: body.warehouseIds === undefined ? undefined : body.warehouseIds === null ? 'all' : body.warehouseIds.length } }),
    );
    return { ok: true };
  });

  app.post('/api/users/:userId/password-reset', { preHandler: perm('users.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { userId } = parse(z.object({ userId: z.uuid() }), req.params);
    const token = randomToken(32);
    await withSystem(pool, async (c) => {
      const m = await c.query('SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2', [auth.org.id, userId]);
      if (!m.rowCount) throw notFound('メンバー');
      // パスワードを再設定できるのは、対象ユーザーが所属する全組織で自分が Owner の場合だけ
      // （他の組織にも所属するユーザーのパスワードを変えると、その組織へのアクセスを奪えてしまうため。
      //   無効化中の所属も含める: 後で有効に戻されると同じことになる）
      const foreign = await c.query(
        `SELECT 1 FROM memberships m WHERE m.user_id = $1 AND NOT EXISTS (
           SELECT 1 FROM memberships o WHERE o.organization_id = m.organization_id AND o.user_id = $2 AND o.role = 'owner' AND o.status = 'active')
         LIMIT 1`,
        [userId, auth.userId],
      );
      if (foreign.rowCount) {
        throw new AppError(
          409,
          'USER_IN_OTHER_ORGANIZATION',
          'このユーザーは他の組織にも所属しているため、パスワード再設定リンクを発行できません。本人に現在のパスワードでログインしてもらうか、サービス運用者に依頼してください',
        );
      }
      await c.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await c.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '24 hours')`, [
        sha256Buf(token),
        userId,
      ]);
    });
    await orgTx(req, (tx) => audit(tx, { action: 'user.password_reset_issued', entityType: 'user', entityId: userId }));
    return { url: `${config.APP_BASE_URL}/reset-password#t=${token}`, expiresInHours: 24 };
  });

  // ---------------- invitations ----------------
  app.get('/api/users/invitations', { preHandler: perm('users.manage') }, async (req) => {
    const auth = requireOrg(req);
    const r = await pool.query(
      `SELECT id, email, name, role, warehouse_ids, expires_at, accepted_at, revoked_at, created_at
         FROM invitations WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [auth.org.id],
    );
    return {
      items: r.rows.map((i) => ({
        id: i.id,
        email: i.email,
        name: i.name,
        role: i.role,
        roleLabel: ROLE_LABELS[i.role as keyof typeof ROLE_LABELS],
        warehouseIds: i.warehouse_ids,
        expiresAt: i.expires_at,
        status: i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at) < new Date() ? 'expired' : 'pending',
        createdAt: i.created_at,
      })),
    };
  });

  app.post('/api/users/invitations', { preHandler: perm('users.manage') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({
        email: z.email('メールアドレスの形式が不正です').max(254),
        name: z.string().trim().max(100).optional(),
        role: RoleEnum,
        warehouseIds: z.array(z.uuid()).max(100).nullable().default(null),
      }),
      req.body,
    );
    if (body.warehouseIds?.length) {
      await orgTx(req, async (tx) => {
        const n = (await tx.one('SELECT count(*)::int AS n FROM warehouses WHERE organization_id = $1 AND id = ANY($2)', [tx.orgId, body.warehouseIds])).n;
        if (n !== new Set(body.warehouseIds).size) throw conflict('INVALID_WAREHOUSE', '存在しない倉庫が指定されています');
      });
    }
    const existing = await pool.query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND lower(u.email) = lower($2) AND m.status = 'active'`,
      [auth.org.id, body.email],
    );
    if (existing.rowCount) throw conflict('ALREADY_MEMBER', 'このメールアドレスのユーザーは既にメンバーです');
    const token = randomToken(32);
    const id = uuidv7();
    await pool.query(
      `INSERT INTO invitations (id, organization_id, email, name, role, warehouse_ids, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '7 days', $8)`,
      [id, auth.org.id, body.email.toLowerCase(), body.name ?? null, body.role, body.warehouseIds, sha256Buf(token), auth.userId],
    );
    await orgTx(req, (tx) => audit(tx, { action: 'user.invite', entityType: 'invitation', entityId: id, metadata: { role: body.role } }));
    // 招待リンクはこの応答でのみ表示（DB にはハッシュのみ）。メール送信は行わない（Owner が本人へ渡す）
    return { id, url: `${config.APP_BASE_URL}/invite#t=${token}`, expiresInDays: 7 };
  });

  app.delete('/api/users/invitations/:id', { preHandler: perm('users.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const r = await pool.query(
      `UPDATE invitations SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [id, auth.org.id],
    );
    if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', '有効な招待が見つかりません');
    await orgTx(req, (tx) => audit(tx, { action: 'user.invite_revoke', entityType: 'invitation', entityId: id }));
    return { ok: true };
  });

  void destroyUserSessions;
}
