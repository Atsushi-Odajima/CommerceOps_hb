/**
 * Phase0 PoC: マルチテナント(RLS/複合FK)・認証/CSRF・RBAC マップ・引当競合（条件付き UPDATE）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, SYSTEM_ACTOR } from '../src/db/tx.js';
import { uuidv7 } from '../src/lib/uuid.js';
import { ROLE_PERMISSIONS } from '../src/auth/permissions.js';
import { createTestEnv, TestClient, type TestEnv } from './helpers/env.js';
import { createOrg, TEST_PASSWORD, uniq } from './helpers/factory.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function insertWarehouse(orgId: string, code = uniq('W').slice(0, 12)) {
  const id = uuidv7();
  await env.tx(orgId, (tx) =>
    tx.exec(`INSERT INTO warehouses (organization_id, id, code, name) VALUES ($1, $2, $3, $4)`, [orgId, id, code, code]),
  );
  return id;
}

describe('PoC: multi-tenant isolation (RLS FORCE + composite FK)', () => {
  it('rows of org A are invisible in org B context, even without WHERE organization_id', async () => {
    const a = await createOrg(env);
    const b = await createOrg(env);
    const whA = await insertWarehouse(a.orgId);
    const visibleInB = await env.tx(b.orgId, (tx) => tx.many('SELECT id FROM warehouses WHERE id = $1', [whA]));
    expect(visibleInB).toHaveLength(0);
    const visibleInA = await env.tx(a.orgId, (tx) => tx.many('SELECT id FROM warehouses WHERE id = $1', [whA]));
    expect(visibleInA).toHaveLength(1);
    // B のコンテキストから A の行を更新・削除しても 0 行
    const updated = await env.tx(b.orgId, (tx) => tx.exec(`UPDATE warehouses SET name = 'hacked' WHERE id = $1`, [whA]));
    expect(updated).toBe(0);
    const deleted = await env.tx(b.orgId, (tx) => tx.exec(`DELETE FROM warehouses WHERE id = $1`, [whA]));
    expect(deleted).toBe(0);
  });

  it('cannot insert a row for another organization (WITH CHECK)', async () => {
    const a = await createOrg(env);
    const b = await createOrg(env);
    await expect(
      env.tx(b.orgId, (tx) =>
        tx.exec(`INSERT INTO warehouses (organization_id, id, code, name) VALUES ($1, $2, 'X1', 'x')`, [a.orgId, uuidv7()]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('composite FK prevents a child row in org B from referencing a parent in org A', async () => {
    const a = await createOrg(env);
    const b = await createOrg(env);
    const whA = await insertWarehouse(a.orgId);
    await expect(
      env.tx(b.orgId, (tx) =>
        tx.exec(
          `INSERT INTO locations (organization_id, id, warehouse_id, code, barcode) VALUES ($1, $2, $3, 'A-01', 'A-01')`,
          [b.orgId, uuidv7(), whA],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('no tenant context => no tenant rows visible', async () => {
    const a = await createOrg(env);
    await insertWarehouse(a.orgId);
    const c = await env.deps.pool.connect();
    try {
      const r = await c.query('SELECT count(*)::int AS n FROM warehouses');
      expect(r.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });
});

describe('PoC: authentication, session, CSRF', () => {
  it('login → me → logout; CSRF header and token are enforced on state-changing requests', async () => {
    const { owner } = await createOrg(env);
    const client = new TestClient(env.app);
    // x-requested-with なし → 403
    const noHeader = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: owner.email, password: TEST_PASSWORD },
    });
    expect(noHeader.statusCode).toBe(403);

    const me = await client.login(owner.email, TEST_PASSWORD);
    expect(me.role).toBe('owner');
    expect(me.permissions).toContain('users.manage');
    expect((await client.get('/api/auth/me')).status).toBe(200);

    // CSRF トークン不一致 → 403
    const bad = await client.post('/api/auth/switch-org', { organizationId: me.organization.id }, { 'x-csrf-token': 'wrong' });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('CSRF_TOKEN_INVALID');

    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('wrong password 5 times locks the account (generic error message)', async () => {
    const { owner } = await createOrg(env);
    const client = new TestClient(env.app);
    for (let i = 0; i < 5; i++) {
      const r = await client.post('/api/auth/login', { email: owner.email, password: 'wrong-password-x' });
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe('メールアドレスまたはパスワードが正しくありません');
    }
    // 正しいパスワードでもロック中は拒否
    const locked = await client.post('/api/auth/login', { email: owner.email, password: TEST_PASSWORD });
    expect(locked.status).toBe(401);
  });

  it('session cookie is HttpOnly + SameSite=Lax', async () => {
    const { owner } = await createOrg(env);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-requested-with': 'CommerceOps' },
      payload: { email: owner.email, password: TEST_PASSWORD },
    });
    const sc = String(res.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
  });
});

describe('PoC: RBAC permission map', () => {
  it('matches the documented matrix for critical denials', () => {
    expect(ROLE_PERMISSIONS.picker.has('returns.inspect')).toBe(false);
    expect(ROLE_PERMISSIONS.support.has('inventory.adjust')).toBe(false);
    expect(ROLE_PERMISSIONS.support.has('users.manage')).toBe(false);
    expect(ROLE_PERMISSIONS.picker.has('orders.read')).toBe(false);
    expect(ROLE_PERMISSIONS.picker.has('orders.read_pii')).toBe(false);
    expect(ROLE_PERMISSIONS.packer.has('orders.read_pii')).toBe(false);
    expect(ROLE_PERMISSIONS.packer.has('orders.read_ship_to')).toBe(true);
    expect(ROLE_PERMISSIONS.ops_manager.has('users.manage')).toBe(false);
    expect(ROLE_PERMISSIONS.ops_manager.has('pack.force_complete')).toBe(true);
    expect(ROLE_PERMISSIONS.packer.has('pack.force_complete')).toBe(false);
    expect(ROLE_PERMISSIONS.owner.size).toBeGreaterThan(30);
  });
});

describe('PoC: allocation race (conditional UPDATE + CHECK constraint)', () => {
  it('20 concurrent allocations of the last unit => exactly one succeeds', async () => {
    const { orgId } = await createOrg(env);
    const wh = await insertWarehouse(orgId);
    const loc = uuidv7();
    const prod = uuidv7();
    const bal = uuidv7();
    await env.tx(orgId, async (tx) => {
      await tx.exec(`INSERT INTO locations (organization_id, id, warehouse_id, code, barcode) VALUES ($1,$2,$3,'A','A')`, [
        orgId,
        loc,
        wh,
      ]);
      await tx.exec(`INSERT INTO products (organization_id, id, sku, name) VALUES ($1,$2,'SKU-1','p')`, [orgId, prod]);
      await tx.exec(
        `INSERT INTO inventory_balances (organization_id, id, warehouse_id, location_id, product_id, on_hand) VALUES ($1,$2,$3,$4,$5,1)`,
        [orgId, bal, wh, loc, prod],
      );
    });
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTenant(env.deps.pool, orgId, SYSTEM_ACTOR, async (tx) => {
          // 少し待ってから更新し、ロック競合を起こしやすくする
          await tx.exec('SELECT pg_sleep(0.01)');
          return tx.exec(
            `UPDATE inventory_balances SET allocated = allocated + 1 WHERE id = $1 AND on_hand - allocated - held >= 1`,
            [bal],
          );
        }),
      ),
    );
    expect(attempts.filter((n) => n === 1)).toHaveLength(1);
    const row = await env.tx(orgId, (tx) => tx.one('SELECT on_hand, allocated FROM inventory_balances WHERE id = $1', [bal]));
    expect(row).toEqual({ on_hand: 1, allocated: 1 });
  });

  it('CHECK constraint rejects over-allocation even for an unconditional UPDATE', async () => {
    const { orgId } = await createOrg(env);
    const wh = await insertWarehouse(orgId);
    const loc = uuidv7();
    const prod = uuidv7();
    const bal = uuidv7();
    await env.tx(orgId, async (tx) => {
      await tx.exec(`INSERT INTO locations (organization_id, id, warehouse_id, code, barcode) VALUES ($1,$2,$3,'A','A')`, [
        orgId,
        loc,
        wh,
      ]);
      await tx.exec(`INSERT INTO products (organization_id, id, sku, name) VALUES ($1,$2,'SKU-1','p')`, [orgId, prod]);
      await tx.exec(
        `INSERT INTO inventory_balances (organization_id, id, warehouse_id, location_id, product_id, on_hand, allocated) VALUES ($1,$2,$3,$4,$5,1,1)`,
        [orgId, bal, wh, loc, prod],
      );
    });
    await expect(
      env.tx(orgId, (tx) => tx.exec('UPDATE inventory_balances SET allocated = allocated + 1 WHERE id = $1', [bal])),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
