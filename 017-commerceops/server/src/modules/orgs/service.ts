import type { Pool, PoolClient } from '../../db/pool.js';
import { withSystem } from '../../db/tx.js';
import { hashPassword } from '../../lib/password.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { Role } from '../../auth/permissions.js';
import { conflict } from '../../lib/errors.js';

export interface NewOrg {
  name: string;
  timezone?: string;
  isSample?: boolean;
  settings?: Record<string, unknown>;
}

export async function insertOrganization(client: PoolClient, org: NewOrg): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO organizations (id, name, timezone, is_sample, settings) VALUES ($1, $2, $3, $4, $5)`,
    [id, org.name, org.timezone ?? 'Asia/Tokyo', org.isSample ?? false, JSON.stringify(org.settings ?? {})],
  );
  return id;
}

export async function findUserByEmail(client: PoolClient | Pool, email: string) {
  const r = await client.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return r.rows[0] ?? null;
}

export async function insertUser(
  client: PoolClient,
  u: { email: string; name: string; password?: string | null; status?: 'active' | 'invited' },
): Promise<string> {
  const existing = await findUserByEmail(client, u.email);
  if (existing) throw conflict('EMAIL_TAKEN', 'このメールアドレスは既に登録されています');
  const id = uuidv7();
  const hash = u.password ? await hashPassword(u.password) : null;
  await client.query(
    `INSERT INTO users (id, email, name, password_hash, status, password_changed_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`,
    [id, u.email.trim(), u.name.trim(), hash, u.status ?? (hash ? 'active' : 'invited')],
  );
  return id;
}

export async function upsertMembership(
  client: PoolClient,
  organizationId: string,
  userId: string,
  role: Role,
  warehouseIds: string[] | null = null,
) {
  await client.query(
    `INSERT INTO memberships (organization_id, user_id, role, warehouse_ids)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, warehouse_ids = EXCLUDED.warehouse_ids, status = 'active', updated_at = now()`,
    [organizationId, userId, role, warehouseIds],
  );
}

/** 組織 + Owner ユーザーを作成（CLI の初期セットアップ / セルフサインアップ / テスト用） */
export async function createOrganizationWithOwner(
  pool: Pool,
  input: { orgName: string; timezone?: string; isSample?: boolean; ownerEmail: string; ownerName: string; ownerPassword: string },
): Promise<{ organizationId: string; userId: string }> {
  return withSystem(pool, async (client) => {
    const organizationId = await insertOrganization(client, {
      name: input.orgName,
      timezone: input.timezone,
      isSample: input.isSample,
    });
    const existing = await findUserByEmail(client, input.ownerEmail);
    const userId =
      existing?.id ??
      (await insertUser(client, { email: input.ownerEmail, name: input.ownerName, password: input.ownerPassword }));
    await upsertMembership(client, organizationId, userId, 'owner');
    return { organizationId, userId };
  });
}
