import { withSystem } from '../../src/db/tx.js';
import { hashPassword } from '../../src/lib/password.js';
import { uuidv7 } from '../../src/lib/uuid.js';
import type { Role } from '../../src/auth/permissions.js';
import { insertOrganization, upsertMembership } from '../../src/modules/orgs/service.js';
import { TestClient, type TestEnv } from './env.js';

export const TEST_PASSWORD = 'Test-Passw0rd-2026';
let cachedHash: Promise<string> | null = null;
const passwordHash = () => (cachedHash ??= hashPassword(TEST_PASSWORD));

let seq = 0;
export const uniq = (prefix = 'x') => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface TestUser {
  userId: string;
  email: string;
  client: TestClient;
}

export async function createUserRow(env: TestEnv, email: string, name: string): Promise<string> {
  const id = uuidv7();
  const hash = await passwordHash();
  await env.deps.pool.query(
    `INSERT INTO users (id, email, name, password_hash, status, password_changed_at) VALUES ($1, $2, $3, $4, 'active', now())`,
    [id, email, name, hash],
  );
  return id;
}

export async function createOrg(env: TestEnv, name = uniq('Org ')): Promise<{ orgId: string; owner: TestUser }> {
  const orgId = await withSystem(env.deps.pool, (c) => insertOrganization(c, { name }));
  const owner = await addMember(env, orgId, 'owner');
  return { orgId, owner };
}

export async function addMember(
  env: TestEnv,
  orgId: string,
  role: Role,
  opts: { warehouseIds?: string[] | null; login?: boolean } = {},
): Promise<TestUser> {
  const email = `${uniq(role)}@example.test`;
  const userId = await createUserRow(env, email, `${role} user`);
  await withSystem(env.deps.pool, (c) => upsertMembership(c, orgId, userId, role, opts.warehouseIds ?? null));
  const client = new TestClient(env.app);
  if (opts.login !== false) {
    await client.login(email, TEST_PASSWORD);
    // 複数組織に所属している場合に備えて明示的に切替
    const me = await client.get('/api/auth/me');
    if (me.body.organization?.id !== orgId) {
      await client.post('/api/auth/switch-org', { organizationId: orgId });
      await client.refreshMe();
    }
  }
  return { userId, email, client };
}
