import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expectStatus, TestClient, type TestEnv } from './helpers/env.js';
import { addMember, createOrg, createUserRow, TEST_PASSWORD } from './helpers/factory.js';
import { uploadFile } from './helpers/scenario.js';
import { PNG_1PX, richOrg } from './helpers/rich.js';
import { expectIntegrity } from './helpers/integrity.js';
import { TEST_RESTORE_DATABASE_URL } from './setup/global.js';
import { withSystem } from '../src/db/tx.js';
import { upsertMembership } from '../src/modules/orgs/service.js';
import { LocalDiskStorage, type MemoryStorage } from '../src/modules/attachments/storage.js';
import { BACKUP_TABLES, EXCLUDED_TENANT_TABLES, PRIMARY_KEYS, USER_COLUMNS, type BackupTable } from '../src/modules/backup/format.js';
import { RAW_EXACT_TYPES } from '../src/modules/backup/export.js';
import { linesFromGzipBuffer, verifyBackup } from '../src/modules/backup/restore.js';

const run = promisify(execFile);

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

// ---------------------------------------------------------------- helpers

type Rows = Record<string, Record<string, unknown>[]>;

/** 組織の全バックアップ対象テーブルの行（organization_id と保存先キーを除く・時刻/金額は文字列のまま） */
async function snapshot(e: TestEnv, orgId: string, userMap: Map<string, string> = new Map()): Promise<Rows> {
  const out: Rows = {};
  await e.tx(orgId, async (tx) => {
    for (const t of BACKUP_TABLES) {
      const r = await tx.client.query({ text: `SELECT * FROM ${t} WHERE organization_id = $1 ORDER BY ${PRIMARY_KEYS[t].join(', ')}`, values: [orgId], types: RAW_EXACT_TYPES });
      out[t] = r.rows.map((row) => {
        const { organization_id: _o, ...d } = row;
        if (t === 'attachments') delete d.storage_key;
        for (const c of USER_COLUMNS[t] ?? []) if (typeof d[c] === 'string' && userMap.has(d[c] as string)) d[c] = userMap.get(d[c] as string);
        return d;
      });
    }
  });
  return out;
}

async function counts(e: TestEnv, orgId: string) {
  const s = await snapshot(e, orgId);
  return Object.fromEntries(Object.entries(s).map(([t, rows]) => [t, rows.length]));
}

/** Order → Fulfillment → Shipment → Return → Exchange → 交換品の注文 → 交換品の Shipment */
async function referenceChain(e: TestEnv, orgId: string) {
  return e.tx(orgId, (tx) =>
    tx.many(
      `SELECT o.order_number, o.external_order_id, f.fulfillment_number, s.shipment_number, s.tracking_number, r.return_number,
              e.exchange_number, ro.order_number AS replacement_number, ro.source_order_id = o.id AS replacement_links_back, rs.shipment_number AS replacement_shipment
         FROM orders o
         JOIN fulfillments f ON f.organization_id = o.organization_id AND f.order_id = o.id
         JOIN shipments s ON s.organization_id = o.organization_id AND s.fulfillment_id = f.id
         LEFT JOIN returns r ON r.organization_id = o.organization_id AND r.order_id = o.id
         LEFT JOIN exchanges e ON e.organization_id = o.organization_id AND e.return_id = r.id
         LEFT JOIN orders ro ON ro.organization_id = o.organization_id AND ro.id = e.replacement_order_id
         LEFT JOIN shipments rs ON rs.organization_id = o.organization_id AND rs.order_id = ro.id
        WHERE o.organization_id = $1
        ORDER BY 1, 3, 4, 6`,
      [orgId],
    ),
  );
}

async function exportViaHttp(client: TestClient): Promise<Buffer> {
  const res = await client.app.inject({
    method: 'POST',
    url: '/api/backup/export',
    headers: { cookie: client.cookie, 'x-csrf-token': client.csrf, 'x-requested-with': 'CommerceOps' },
  });
  if (res.statusCode !== 200) throw new Error(`export failed ${res.statusCode} ${res.body.slice(0, 300)}`);
  expect(res.headers['content-type']).toBe('application/gzip');
  expect(String(res.headers['content-disposition'])).toMatch(/commerceops-backup-\d{8}T\d{6}\.ndjson\.gz/);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.rawPayload;
}

const toLines = (file: Buffer) => gunzipSync(file).toString('utf8').split('\n').filter(Boolean);

/** 行を書き換えた後、件数・チェックサムを付け直す（悪意ある/壊れた「正しく署名された」ファイルの再現） */
function resign(lines: string[]): Buffer {
  const body = lines.filter((l) => JSON.parse(l).type !== 'trailer');
  const old = JSON.parse(lines.find((l) => JSON.parse(l).type === 'trailer')!);
  const all = createHash('sha256');
  const th = new Map<string, ReturnType<typeof createHash>>();
  const cnt: Record<string, number> = {};
  let users = 0;
  let memberships = 0;
  let files = 0;
  for (const l of body) {
    all.update(l + '\n');
    const o = JSON.parse(l);
    if (o.type === 'row') {
      if (!th.has(o.t)) th.set(o.t, createHash('sha256'));
      th.get(o.t)!.update(l + '\n');
      cnt[o.t] = (cnt[o.t] ?? 0) + 1;
    }
    if (o.type === 'user') users++;
    if (o.type === 'membership') memberships++;
    if (o.type === 'file') files++;
  }
  const tableSha256 = Object.fromEntries(BACKUP_TABLES.map((t) => [t, (th.get(t) ?? createHash('sha256')).digest('hex')]));
  const trailer = { ...old, counts: Object.fromEntries(BACKUP_TABLES.map((t) => [t, cnt[t] ?? 0])), tableSha256, users, memberships, files, sha256: all.digest('hex') };
  return gzipSync(Buffer.from([...body, JSON.stringify(trailer)].join('\n') + '\n'));
}

/** 名前で組織を数える（他のテストファイルが並行して組織を作るため、総数では比較しない） */
const orgsNamed = async (pattern: string) => Number((await env.deps.pool.query('SELECT count(*)::int AS n FROM organizations WHERE name LIKE $1', [pattern])).rows[0].n);

async function restoreDbReachable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: TEST_RESTORE_DATABASE_URL });
  try {
    await c.connect();
    await c.query('SELECT 1 FROM schema_migrations LIMIT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- tests

describe('Phase9 backup / restore (R26, E2E-9)', () => {
  it('backup format covers every tenant table, in FK order, with every user-id column and RLS on all of them', async () => {
    const q = (sql: string, p: unknown[] = []) => env.deps.pool.query(sql, p).then((r) => r.rows);
    const tenantTables = (await q(`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organization_id'`)).map((r) => r.table_name);
    expect(new Set(tenantTables)).toEqual(new Set([...BACKUP_TABLES, ...EXCLUDED_TENANT_TABLES]));
    // 親テーブルが子より先（復元時の FK 制約を満たす）
    const fks = await q(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'`);
    for (const f of fks) {
      const ci = BACKUP_TABLES.indexOf(f.child as BackupTable);
      const pi = BACKUP_TABLES.indexOf(f.parent as BackupTable);
      if (ci >= 0 && pi >= 0) expect(pi, `${f.child} -> ${f.parent}`).toBeLessThanOrEqual(ci);
      if (ci >= 0 && pi < 0) expect(['organizations', 'users']).toContain(f.parent);
    }
    // ユーザー ID を持つ列はすべて付け替え対象
    const userCols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'uuid' AND (column_name LIKE '%\\_by' OR column_name LIKE '%user\\_id') AND table_name = ANY($1)`,
      [BACKUP_TABLES],
    );
    const actual: Record<string, string[]> = {};
    for (const r of userCols) (actual[r.table_name] ??= []).push(r.column_name);
    for (const k of Object.keys(actual)) actual[k]!.sort();
    const declared = Object.fromEntries(Object.entries(USER_COLUMNS).map(([k, v]) => [k, [...v!].sort()]));
    expect(actual).toEqual(declared);
    // RLS（FORCE）がすべての組織テーブルに掛かっている
    const rls = await q(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`, [[...BACKUP_TABLES, 'backup_runs']]);
    expect(rls).toHaveLength(BACKUP_TABLES.length + 1);
    for (const r of rls) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it('R26: export → verify → restore as a new organization: every row, reference, audit entry and photo matches; source untouched', async () => {
    const s = await richOrg(env, 'BKUPA');
    await expectIntegrity(env, s.orgId);
    const file = await exportViaHttp(s.owner.client);
    const src = await snapshot(env, s.orgId);
    // データセットがすべてのテーブルを使っている（どれかが空だと「一致」の検証にならない）
    for (const t of BACKUP_TABLES) expect(src[t]!.length, `${t} should have rows`).toBeGreaterThan(0);
    const srcChain = await referenceChain(env, s.orgId);
    expect(srcChain.find((r) => r.external_order_id === 'FULL-1')).toMatchObject({ replacement_links_back: true });
    expect(srcChain.find((r) => r.external_order_id === 'FULL-1')!.replacement_shipment).toMatch(/^SH-/);

    // 検証（DB へは書かない）
    const orgName = (await env.deps.pool.query('SELECT name FROM organizations WHERE id = $1', [s.orgId])).rows[0].name as string;
    const restoredPattern = `${orgName}（復元 %`;
    const v = await uploadFile(s.owner.client, '/api/backup/verify', {}, file, 'backup.ndjson.gz');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true, errors: [], users: 5, files: 1 });
    expect(v.body.header).toMatchObject({ schemaVersion: 1, appVersion: '1.0.0', isSample: false });
    expect(v.body.counts).toEqual(Object.fromEntries(BACKUP_TABLES.map((t) => [t, src[t]!.length])));
    expect(await orgsNamed(restoredPattern)).toBe(0);
    const run1 = expectStatus(await s.owner.client.get('/api/backup/runs'), 200).body.items[0];
    expect(run1).toMatchObject({ kind: 'export', status: 'succeeded', fileSha256: v.body.sha256 });

    // 確認なしの復元は拒否
    expect((await uploadFile(s.owner.client, '/api/backup/restore', {}, file, 'backup.ndjson.gz')).status).toBe(400);
    const r = await uploadFile(s.owner.client, '/api/backup/restore', { confirm: 'true' }, file, 'backup.ndjson.gz');
    expect(r.status, r.text).toBe(200);
    expect(r.body.users).toEqual({ restored: 5, created: 0, matchedByEmail: 0, unlinked: 0 });
    expect(r.body.name).toMatch(/（復元 \d{4}-\d{2}-\d{2}）$/);
    const newOrg = r.body.organizationId as string;
    expect(await orgsNamed(restoredPattern)).toBe(1);

    // 行単位で一致（監査ログは「復元」の 1 行だけ増える）
    const dst = await snapshot(env, newOrg);
    const restoreAudit = dst.audit_logs!.filter((a) => a.action === 'backup.restore');
    expect(restoreAudit).toHaveLength(1);
    dst.audit_logs = dst.audit_logs!.filter((a) => a.action !== 'backup.restore');
    for (const t of BACKUP_TABLES) expect(dst[t], t).toEqual(src[t]);
    expect(await referenceChain(env, newOrg)).toEqual(srcChain);
    await expectIntegrity(env, newOrg);
    // 元の組織は変更されていない（増えたのは元組織側の監査ログ「復元を実行」だけ）
    const srcAfter = await snapshot(env, s.orgId);
    expect(srcAfter.audit_logs!.filter((a) => !src.audit_logs!.some((b) => b.id === a.id)).map((a) => a.action)).toEqual(['backup.restore_started_here']);
    srcAfter.audit_logs = src.audit_logs;
    expect(srcAfter).toEqual(src);

    // 画面（API）で見ても同じ: 復元した人は新しい組織の Owner。同じ ID で同じ注文・出荷・返品・写真
    const c = s.owner.client;
    const origOrder = expectStatus(await c.get(`/api/orders/${s.ids.orderId}`), 200).body;
    expectStatus(await c.post('/api/auth/switch-org', { organizationId: newOrg }), 200);
    await c.refreshMe();
    expect((await c.get('/api/auth/me')).body).toMatchObject({ organization: { id: newOrg }, role: 'owner' });
    const restoredOrder = expectStatus(await c.get(`/api/orders/${s.ids.orderId}`), 200).body;
    for (const k of ['orderNumber', 'status', 'items', 'shipments', 'fulfillments', 'returns', 'relatedOrders', 'shipTo'] as const) expect(restoredOrder[k], k).toEqual(origOrder[k]);
    const img = await c.app.inject({ method: 'GET', url: `/api/attachments/${s.ids.attachmentId}`, headers: { cookie: c.cookie } });
    expect(img.statusCode).toBe(200);
    expect(Buffer.compare(img.rawPayload, PNG_1PX)).toBe(0);
    const audits = expectStatus(await c.get('/api/audit?action=backup'), 200).body.items.map((a: any) => a.action);
    expect(audits).toEqual(['backup.restore', 'backup.export']);
    // 復元した組織でも通常業務を続けられる（番号は続きから）
    const next = expectStatus(await c.post(`/api/orders`, { channelId: s.ids.channelId, order: { externalOrderId: 'AFTER-RESTORE', customer: { name: 'x' }, shipTo: { name: 'x', postalCode: '150-0001', address1: '東京都渋谷区1-1', phone: '090' }, lines: [{ sku: 'SKU-B', quantity: 1 }] } }), 200).body;
    const maxSrc = Math.max(...src.orders!.map((o) => Number(String(o.order_number).replace(/\D/g, ''))));
    expect(Number(next.orderNumber.replace(/\D/g, ''))).toBe(maxSrc + 1);
    // 他のメンバー（ピッカー）も新しい組織に所属し、自分の組織を切り替えられる
    const pickerMe = await s.picker.client.post('/api/auth/switch-org', { organizationId: newOrg });
    expect(pickerMe.status).toBe(200);
  });

  it('E2E-9: restore into an EMPTY environment via the operator CLI; users matched by e-mail or created without password; data, audit, photo and references match', async (ctx) => {
    if (!(await restoreDbReachable())) ctx.skip();
    const s = await richOrg(env, 'BKUPE');
    const file = await exportViaHttp(s.owner.client);
    const src = await snapshot(env, s.orgId);
    const srcChain = await referenceChain(env, s.orgId);
    const dir = await mkdtemp(join(tmpdir(), 'co-restore-'));
    const dataDir = join(dir, 'data');
    const path = join(dir, 'backup.ndjson.gz');
    await writeFile(path, file);
    const renv = await createTestEnv({ DATA_DIR: dataDir }, TEST_RESTORE_DATABASE_URL, new LocalDiskStorage(dataDir));
    try {
      // 空の環境: 運用者のアカウントと、ピッカーと同じメールアドレスの既存アカウント（別 ID）だけがある
      const operatorId = await createUserRow(renv, 'dr-operator@example.test', 'DR 担当');
      const existingPickerId = await createUserRow(renv, s.picker.email, '既存アカウント');
      const cliEnv = { ...process.env, DATABASE_URL: TEST_RESTORE_DATABASE_URL, DATA_DIR: dataDir, LOG_LEVEL: 'silent' };
      const verifyOnly = await run('npx', ['tsx', 'src/scripts/restore-cli.ts', '--file', path, '--verify-only'], { cwd: process.cwd(), env: cliEnv, timeout: 90_000 });
      expect(verifyOnly.stdout).toContain('verify:       OK');
      const out = await run('npx', ['tsx', 'src/scripts/restore-cli.ts', '--file', path, '--actor-email', 'dr-operator@example.test'], { cwd: process.cwd(), env: cliEnv, timeout: 90_000 });
      const m = /restored:\s+(.+) \(([0-9a-f-]{36})\)/.exec(out.stdout);
      expect(m, out.stdout + out.stderr).not.toBeNull();
      const newOrg = m![2]!;
      expect(out.stdout).toContain('existing 0 / matched by email 1 / created (no password) 4');
      expect(out.stdout).not.toContain('password:'); // 既存の運用者アカウントを使ったので初期パスワードは発行されない

      const userMap = new Map([[s.picker.userId, existingPickerId]]);
      const dst = await snapshot(renv, newOrg);
      dst.audit_logs = dst.audit_logs!.filter((a) => a.action !== 'backup.restore');
      const expected = await snapshot(env, s.orgId, userMap);
      expected.audit_logs = expected.audit_logs!.filter((a) => src.audit_logs!.some((b) => b.id === a.id));
      for (const t of BACKUP_TABLES) expect(dst[t], t).toEqual(expected[t]);
      expect(await referenceChain(renv, newOrg)).toEqual(srcChain);
      await expectIntegrity(renv, newOrg);

      // 作成されたユーザーはパスワード未設定の「招待中」。ピッカーは既存アカウントに対応付け
      const users = (await renv.deps.pool.query(`SELECT u.email, u.status, u.password_hash IS NULL AS no_pw, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY m.role, u.email`, [newOrg])).rows;
      expect(users.find((u) => u.email === 'dr-operator@example.test')).toMatchObject({ role: 'owner', no_pw: false });
      expect(users.find((u) => u.email === s.picker.email)).toMatchObject({ role: 'picker', status: 'active', no_pw: false });
      for (const e of [s.owner.email, s.manager.email, s.packer.email, s.support.email]) expect(users.find((u) => u.email === e), e).toMatchObject({ status: 'invited', no_pw: true });

      // 運用者（新しい組織の Owner）がログインして確認
      const op = new TestClient(renv.app);
      await op.login('dr-operator@example.test', TEST_PASSWORD);
      expectStatus(await op.post('/api/auth/switch-org', { organizationId: newOrg }), 200);
      await op.refreshMe();
      const d = expectStatus(await op.get(`/api/orders/${s.ids.orderId}`), 200).body;
      const orig = expectStatus(await s.owner.client.get(`/api/orders/${s.ids.orderId}`), 200).body;
      for (const k of ['orderNumber', 'status', 'items', 'shipments', 'returns', 'relatedOrders'] as const) expect(d[k], k).toEqual(orig[k]);
      const img = await renv.app.inject({ method: 'GET', url: `/api/attachments/${s.ids.attachmentId}`, headers: { cookie: op.cookie } });
      expect(img.statusCode).toBe(200);
      expect(Buffer.compare(img.rawPayload, PNG_1PX)).toBe(0);
      const auditN = expectStatus(await op.get('/api/audit?limit=1'), 200).body.total;
      expect(auditN).toBe(expected.audit_logs!.length + 1);
      // 作成されたユーザー（Packer）にパスワード再設定リンクを発行 → 本人が設定 → ログインして梱包画面を使える
      const packerId = (await renv.deps.pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [s.packer.email])).rows[0].id;
      const link = expectStatus(await op.post(`/api/users/${packerId}/password-reset`, {}), 200).body.url as string;
      const anon = new TestClient(renv.app);
      expectStatus(await anon.post('/api/auth/password-reset', { token: /#t=(.+)$/.exec(link)![1], newPassword: 'Packer-Restored-2026' }), 200);
      const pk = new TestClient(renv.app);
      await pk.login(s.packer.email, 'Packer-Restored-2026');
      expect((await pk.get('/api/auth/me')).body).toMatchObject({ organization: { id: newOrg }, role: 'packer' });
      expectStatus(await pk.get('/api/pack/queue'), 200);
      // 整合性チェック CLI（復元先）
      const ic = await run('npx', ['tsx', 'src/scripts/integrity-cli.ts', '--org', newOrg], { cwd: process.cwd(), env: cliEnv, timeout: 90_000 });
      expect(ic.stdout).toMatch(/^OK /m);
      void operatorId;
    } finally {
      await renv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backup CLI writes a verifiable file (0600) identical in content to the HTTP export format', async () => {
    const { orgId, owner } = await createOrg(env);
    expectStatus(await owner.client.post('/api/warehouses', { code: 'CLI', name: 'CLI 倉庫' }), 200);
    const dir = await mkdtemp(join(tmpdir(), 'co-backup-'));
    try {
      const out = join(dir, 'b.ndjson.gz');
      const r = await run('npx', ['tsx', 'src/scripts/backup-cli.ts', '--org', orgId, '--out', out, '--verify'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: env.deps.config.DATABASE_URL },
        timeout: 90_000,
      });
      expect(r.stdout).toContain('verify:       OK');
      const { statSync, readFileSync } = await import('node:fs');
      expect(statSync(out).mode & 0o777).toBe(0o600);
      const v = await verifyBackup(linesFromGzipBuffer(readFileSync(out)));
      expect(v.ok).toBe(true);
      expect(v.counts.warehouses).toBe(1);
      const runs = expectStatus(await owner.client.get('/api/backup/runs'), 200).body.items;
      expect(runs[0]).toMatchObject({ kind: 'export', status: 'succeeded', fileSha256: v.trailer!.sha256 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('corrupted / tampered / foreign files are rejected before anything is written; a consistent-but-invalid file is rolled back completely', async () => {
    const s = await richOrg(env, 'BKUPT');
    const file = await exportViaHttp(s.owner.client);
    const lines = toLines(file);
    const c = s.owner.client;
    const tag = `TAMPER-${Math.random().toString(36).slice(2, 8)}`;
    const storage = env.deps.storage as MemoryStorage;
    const keysBefore = (storage as unknown as { m: Map<string, Buffer> }).m.size;
    const verify = async (buf: Buffer) => (await uploadFile(c, '/api/backup/verify', {}, buf, 'x.ndjson.gz')).body;
    const restore = (buf: Buffer) => uploadFile(c, '/api/backup/restore', { confirm: 'true', name: tag }, buf, 'x.ndjson.gz');

    // 1 行だけ改ざん（数量）→ テーブル・全体のチェックサム不一致
    const tampered = lines.map((l) => {
      const o = JSON.parse(l);
      if (o.type === 'row' && o.t === 'order_items' && o.d.quantity === 2) return JSON.stringify({ ...o, d: { ...o.d, quantity: 20 } });
      return l;
    });
    expect(tampered).not.toEqual(lines);
    const tv = await verify(gzipSync(tampered.join('\n') + '\n'));
    expect(tv.ok).toBe(false);
    expect(tv.errors).toContain('order_items: チェックサムが一致しません（改ざん・破損の可能性）');
    expect(tv.errors).toContain('ファイル全体のチェックサムが一致しません（改ざん・破損の可能性）');
    const tr = await restore(gzipSync(tampered.join('\n') + '\n'));
    expect(tr.status).toBe(400);
    expect(tr.body.error.code).toBe('BACKUP_INVALID');
    // 途中で途切れたファイル（trailer なし / gzip 途中まで）
    expect((await verify(gzipSync(lines.slice(0, -1).join('\n') + '\n'))).errors.join()).toContain('trailer');
    expect((await verify(file.subarray(0, file.length - 40))).ok).toBe(false);
    // ZIP / gzip でないファイル
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
    expect((await uploadFile(c, '/api/backup/verify', {}, zip, 'x.zip')).body.error.code).toBe('ZIP_NOT_SUPPORTED');
    expect((await restore(zip)).body.error.code).toBe('ZIP_NOT_SUPPORTED');
    expect((await uploadFile(c, '/api/backup/verify', {}, Buffer.from('id,name\n1,x\n'), 'x.csv')).body.error.code).toBe('NOT_A_BACKUP');
    // 別の版のデータベースで作られたファイル（チェックサムは正しい）
    const otherSchema = resign(lines.map((l, i) => (i === 0 ? JSON.stringify({ ...JSON.parse(l), schemaVersion: 999 }) : l)));
    expect((await verify(otherSchema)).errors.join()).toContain('データベースの版が異なります（ファイル: 999 / このシステム: 1）');
    // 形式違反（organization_id を含む行・対象外テーブル）
    const withOrg = resign(lines.map((l) => (JSON.parse(l).t === 'products' ? JSON.stringify({ ...JSON.parse(l), d: { ...JSON.parse(l).d, organization_id: s.orgId } }) : l)));
    expect((await verify(withOrg)).errors.join()).toContain('行データが不正です');
    const foreignTable = resign([...lines.slice(0, 2), JSON.stringify({ type: 'row', t: 'users', d: { id: s.owner.userId } }), ...lines.slice(2)]);
    expect((await verify(foreignTable)).errors.join()).toContain('対象外のテーブル（users）');
    // チェックサムは正しいが中身が矛盾（引当数を書き換え）→ 整合性チェックで復元を取り消し
    const badBalance = resign(
      lines.map((l) => {
        const o = JSON.parse(l);
        return o.type === 'row' && o.t === 'inventory_balances' && o.d.allocated > 0 ? JSON.stringify({ ...o, d: { ...o.d, allocated: o.d.allocated + 1 } }) : l;
      }),
    );
    expect((await verify(badBalance)).ok).toBe(true);
    const bb = await restore(badBalance);
    expect(bb.status).toBe(409);
    expect(bb.body.error.code).toBe('RESTORE_INTEGRITY_FAILED');
    // 親のない行（注文を消して明細だけ残す）→ FK 違反で取り消し
    const orphan = resign(lines.filter((l) => !(JSON.parse(l).t === 'orders' && JSON.parse(l).d.id === s.ids.orderId)));
    const or = await restore(orphan);
    expect(or.status).toBe(409);
    // どの失敗でも組織は作られず、添付ファイルも残らない
    expect(await orgsNamed(tag)).toBe(0);
    expect((storage as unknown as { m: Map<string, Buffer> }).m.size).toBe(keysBefore);
    const runs = expectStatus(await c.get('/api/backup/runs'), 200).body.items;
    expect(runs.every((r: any) => r.kind === 'export')).toBe(true);
  });

  it('backup uploads stream to a temporary file with their own size limit; temporary files are removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'co-up-'));
    const e2 = await createTestEnv({ BACKUP_MAX_UPLOAD_MB: '1', DATA_DIR: dir });
    try {
      const { owner } = await createOrg(e2);
      const small = await exportViaHttp(owner.client);
      expect((await uploadFile(owner.client, '/api/backup/verify', {}, small, 'b.ndjson.gz')).body.ok).toBe(true);
      const big = await uploadFile(owner.client, '/api/backup/verify', {}, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(2 * 1024 * 1024)]), 'big.ndjson.gz');
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe('FILE_TOO_LARGE');
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
    } finally {
      await e2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restore from the screen only links users the restorer already manages; others are listed, not created or added; backup is Owner-only', async () => {
    const { orgId, owner } = await createOrg(env);
    const picker = await addMember(env, orgId, 'picker');
    const other = await createOrg(env); // 別の事業者
    const victim = await addMember(env, other.orgId, 'ops_manager');
    // ピッカーは別の事業者にも所属
    await withSystem(env.deps.pool, (cl) => upsertMembership(cl, other.orgId, picker.userId, 'picker', null));
    const lines = toLines(await exportViaHttp(owner.client));
    // 悪意ある編集: 他社のユーザー（Owner 権限で）と、存在しないメールアドレスのユーザーを追加
    const extra = [
      JSON.stringify({ type: 'user', d: { id: victim.userId, email: victim.email, name: 'victim', status: 'active' } }),
      JSON.stringify({ type: 'user', d: { id: '0190aaaa-0000-7000-8000-000000000001', email: 'ghost@example.test', name: 'ghost', status: 'active' } }),
      JSON.stringify({ type: 'membership', d: { user_id: victim.userId, role: 'owner', warehouse_ids: null, status: 'active', created_at: '2026-01-01 00:00:00+00' } }),
      JSON.stringify({ type: 'membership', d: { user_id: '0190aaaa-0000-7000-8000-000000000001', role: 'owner', warehouse_ids: null, status: 'active', created_at: '2026-01-01 00:00:00+00' } }),
    ];
    const crafted = resign([lines[0]!, ...extra, ...lines.slice(1)]);
    const r = await uploadFile(owner.client, '/api/backup/restore', { confirm: 'true', name: '復元テスト' }, crafted, 'x.ndjson.gz');
    expect(r.status, r.text).toBe(200);
    expect(r.body.name).toBe('復元テスト');
    expect(r.body.users).toEqual({ restored: 2, created: 0, matchedByEmail: 0, unlinked: 2 });
    expect(r.body.unlinkedUsers.map((u: any) => [u.email, u.role]).sort()).toEqual([
      ['ghost@example.test', 'owner'],
      [victim.email, 'owner'],
    ]);
    const members = (await env.deps.pool.query('SELECT user_id, role FROM memberships WHERE organization_id = $1 ORDER BY role', [r.body.organizationId])).rows;
    expect(members.map((m) => m.user_id).sort()).toEqual([owner.userId, picker.userId].sort());
    expect((await env.deps.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'ghost@example.test'`)).rows[0].n).toBe(0);
    // 復元先で「他の事業者にも所属するピッカー」のパスワードは再設定できない
    expectStatus(await owner.client.post('/api/auth/switch-org', { organizationId: r.body.organizationId }), 200);
    await owner.client.refreshMe();
    const reset = await owner.client.post(`/api/users/${picker.userId}/password-reset`, {});
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('USER_IN_OTHER_ORGANIZATION');
    // Owner 以外はバックアップ機能を使えない
    const mgr = await addMember(env, orgId, 'ops_manager');
    expect((await mgr.client.post('/api/backup/export', {})).status).toBe(403);
    expect((await mgr.client.get('/api/backup/runs')).status).toBe(403);
    expect((await uploadFile(mgr.client, '/api/backup/verify', {}, crafted, 'x.gz')).status).toBe(403);
    expect((await uploadFile(mgr.client, '/api/backup/restore', { confirm: 'true' }, crafted, 'x.gz')).status).toBe(403);
    expect((await picker.client.get('/api/backup/runs')).status).toBe(403);
  });
});
