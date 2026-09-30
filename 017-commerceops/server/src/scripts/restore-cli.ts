/**
 * バックアップファイルを「新しい組織」として復元する（サーバー運用者向け。空の環境への復元＝障害復旧にも使う）。
 *   npm run restore -w server -- --file ./backups/xxx.ndjson.gz --verify-only
 *   npm run restore -w server -- --file ./backups/xxx.ndjson.gz --actor-email owner@example.com [--name "組織名"]
 * 本番（ビルド済み）: node dist/scripts/restore-cli.js --file <path> --actor-email <メール>
 *
 * - 既存の組織・データは変更しない。失敗した場合はすべて取り消される（新しい組織も作られない）。
 * - --actor-email のユーザーが新しい組織の Owner になる。存在しない場合は作成し、初期パスワードを 1 回だけ表示する。
 * - バックアップ内のユーザーは ID → メールアドレスで対応付け、無ければパスワード未設定（招待中）で作成する。
 *   ログインできるようにするには、Owner が「ユーザーと権限」からパスワード再設定リンクを発行して本人に渡す。
 */
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { withSystem } from '../db/tx.js';
import { validatePasswordStrength } from '../lib/password.js';
import { LocalDiskStorage } from '../modules/attachments/storage.js';
import { findUserByEmail, insertUser } from '../modules/orgs/service.js';
import { linesFromGzipFile, restoreBackup, verifyBackup } from '../modules/backup/restore.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    'actor-email': { type: 'string' },
    'actor-name': { type: 'string' },
    name: { type: 'string' },
    'verify-only': { type: 'boolean', default: false },
  },
});

async function main() {
  if (!values.file) {
    console.error('usage: restore --file <path> (--verify-only | --actor-email <メール> [--name <組織名>])');
    process.exitCode = 2;
    return;
  }
  const file = resolve(values.file);
  await stat(file);
  const source = linesFromGzipFile(file);
  const v = await verifyBackup(source);
  if (v.header) {
    console.log(`backup:       ${v.header.organization.name}  created ${v.header.createdAt}  schema v${v.header.schemaVersion}  app ${v.header.appVersion}`);
  }
  const rows = Object.values(v.counts).reduce((a, n) => a + n, 0);
  console.log(`rows:         ${rows}  users: ${v.users}  files: ${v.files}`);
  if (!v.ok) {
    console.error(`verify:       NG\n  ${v.errors.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('verify:       OK');
  if (values['verify-only']) return;
  const email = values['actor-email']?.trim().toLowerCase();
  if (!email) {
    console.error('--actor-email is required (新しい組織の Owner になるユーザー)');
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool({ connectionString: url, max: 3, ssl: ['1', 'true'].includes(process.env.DATABASE_SSL ?? ''), applicationName: 'commerceops-restore' });
  try {
    await migrate(pool);
    let password: string | null = null;
    const actorId = await withSystem(pool, async (c) => {
      const existing = await findUserByEmail(c, email);
      if (existing) return existing.id as string;
      password = randomBytes(12).toString('base64url');
      const weak = validatePasswordStrength(password);
      if (weak) throw new Error(weak);
      return insertUser(c, { email, name: values['actor-name'] ?? email.split('@')[0]!, password });
    });
    const r = await restoreBackup({ pool, storage: new LocalDiskStorage(process.env.DATA_DIR ?? './data') }, source, {
      actor: { userId: actorId, type: 'system' },
      userPolicy: 'trusted',
      name: values.name,
      filename: file.split(/[\\/]/).pop(),
      verified: v,
    });
    console.log(`restored:     ${r.name} (${r.organizationId})`);
    console.log(`users:        existing ${r.users.restored} / matched by email ${r.users.matchedByEmail} / created (no password) ${r.users.created}`);
    console.log(`owner:        ${email}`);
    if (password) console.log(`password:     ${password}   ← この表示は一度だけです。ログイン後に変更してください。`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  const details = (e as { details?: { errors?: string[]; violations?: unknown[] } }).details;
  if (details?.errors) console.error(`  ${details.errors.join('\n  ')}`);
  if (details?.violations) console.error(JSON.stringify(details.violations, null, 2).slice(0, 4000));
  process.exit(1);
});
