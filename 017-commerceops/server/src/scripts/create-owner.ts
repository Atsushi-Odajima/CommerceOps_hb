/**
 * 初期セットアップ: 組織と Owner ユーザーを作成する。
 *   npm run create-owner -w server -- --org "店名" --email owner@example.com --name "氏名" [--password "..."]
 * パスワード未指定時はランダム生成して 1 回だけ表示する。
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { createOrganizationWithOwner } from '../modules/orgs/service.js';
import { validatePasswordStrength } from '../lib/password.js';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    timezone: { type: 'string', default: 'Asia/Tokyo' },
  },
});

async function main() {
  if (!values.org || !values.email || !values.name) {
    console.error('usage: create-owner --org <組織名> --email <メール> --name <氏名> [--password <パスワード>]');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const password = values.password ?? randomBytes(12).toString('base64url');
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const pool = createPool({ connectionString: url, max: 2, ssl: ['1', 'true'].includes(process.env.DATABASE_SSL ?? '') });
  try {
    await migrate(pool);
    const r = await createOrganizationWithOwner(pool, {
      orgName: values.org,
      timezone: values.timezone,
      ownerEmail: values.email,
      ownerName: values.name,
      ownerPassword: password,
    });
    console.log(`organization: ${r.organizationId}`);
    console.log(`owner:        ${values.email}`);
    if (!values.password) console.log(`password:     ${password}   ← この表示は一度だけです。ログイン後、画面右上（狭い画面ではメニュー下部）の「パスワード変更」で変更してください。`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
