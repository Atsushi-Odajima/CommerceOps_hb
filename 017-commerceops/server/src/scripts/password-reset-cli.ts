/**
 * パスワード再設定リンクを発行する（サーバー運用者向け。複数の組織に所属していて Owner から発行できないユーザー等）。
 *   npm run password-reset -w server -- --email user@example.com
 * 本番（ビルド済み）: node dist/scripts/password-reset-cli.js --email <メール>
 * リンクは 24 時間有効・1 回限り。本人確認のうえ安全な経路で本人にだけ渡すこと。
 */
import { parseArgs } from 'node:util';
import { createPool } from '../db/pool.js';
import { withSystem } from '../db/tx.js';
import { randomToken, sha256Buf } from '../lib/hash.js';
import { uuidv7 } from '../lib/uuid.js';
import { findUserByEmail } from '../modules/orgs/service.js';

const { values } = parseArgs({ options: { email: { type: 'string' } } });

async function main() {
  if (!values.email) {
    console.error('usage: password-reset --email <メール>');
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const base = process.env.APP_BASE_URL ?? 'http://localhost:5173';
  const pool = createPool({ connectionString: url, max: 2, ssl: ['1', 'true'].includes(process.env.DATABASE_SSL ?? ''), applicationName: 'commerceops-cli' });
  try {
    const token = randomToken(32);
    await withSystem(pool, async (c) => {
      const u = await findUserByEmail(c, values.email!);
      if (!u) throw new Error('user not found');
      if (u.status === 'disabled') throw new Error('user is disabled');
      await c.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
      await c.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '24 hours')`, [sha256Buf(token), u.id]);
      await c.query(`INSERT INTO security_events (id, user_id, event_type) VALUES ($1, $2, 'password_reset_issued_cli')`, [uuidv7(), u.id]);
    });
    console.log(`${base}/reset-password#t=${token}`);
    console.log('（24 時間有効・1 回限り。本人にだけ渡してください）');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
