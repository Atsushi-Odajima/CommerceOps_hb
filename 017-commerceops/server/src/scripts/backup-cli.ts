/**
 * 組織単位のバックアップをファイルに書き出す（サーバー運用者向け。画面の「設定 → バックアップ」と同じ形式）。
 *   npm run backup -w server -- --list
 *   npm run backup -w server -- --org <組織ID> [--out ./backups/xxx.ndjson.gz] [--verify]
 * 本番（ビルド済み）: node dist/scripts/backup-cli.js --org <組織ID> --out <path>
 * ファイルには個人情報（氏名・住所・電話・メール）が含まれる。保存先の権限・暗号化・保管期間は OPERATIONS.md を参照。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { createPool } from '../db/pool.js';
import { SYSTEM_ACTOR, withTenant } from '../db/tx.js';
import { uuidv7 } from '../lib/uuid.js';
import { LocalDiskStorage } from '../modules/attachments/storage.js';
import { audit } from '../modules/audit/audit.js';
import { exportOrganizationLines, type ExportSummary } from '../modules/backup/export.js';
import { linesFromGzipFile, verifyBackup } from '../modules/backup/restore.js';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    out: { type: 'string' },
    list: { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    // 写真ファイルが見つからなくても成功扱いにする（DATA_DIR を確認したうえで、欠落を承知で取る場合のみ）
    'allow-missing-files': { type: 'boolean', default: false },
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool({ connectionString: url, max: 3, ssl: ['1', 'true'].includes(process.env.DATABASE_SSL ?? ''), applicationName: 'commerceops-backup' });
  try {
    if (values.list) {
      const r = await pool.query('SELECT id, name, is_sample, created_at FROM organizations ORDER BY created_at');
      for (const o of r.rows) console.log(`${o.id}  ${o.is_sample ? '[sample] ' : ''}${o.name}`);
      return;
    }
    if (!values.org || !UUID_RE.test(values.org)) {
      console.error('usage: backup --org <組織ID> [--out <path>] [--verify] [--allow-missing-files]   （組織ID は --list で確認）');
      process.exitCode = 2;
      return;
    }
    const orgId = values.org;
    const org = (await pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId])).rows[0];
    if (!org) throw new Error('organization not found');
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const out = resolve(values.out ?? `./backups/commerceops-backup-${orgId.slice(0, 8)}-${stamp}.ndjson.gz`);
    const tmp = `${out}.partial`;
    await mkdir(dirname(out), { recursive: true });
    const runId = uuidv7();
    const actor = { ...SYSTEM_ACTOR };
    await withTenant(pool, orgId, actor, async (tx) => {
      await tx.exec(`INSERT INTO backup_runs (organization_id, id, kind, status, filename, created_by) VALUES ($1, $2, 'export', 'running', $3, NULL)`, [
        orgId,
        runId,
        out.split(/[\\/]/).pop()!,
      ]);
      await audit(tx, { action: 'backup.export', entityType: 'organization', entityId: orgId, summary: 'コマンドラインでバックアップを作成', metadata: { runId, cli: true } });
    });
    let summary: ExportSummary | null = null;
    const storage = new LocalDiskStorage(process.env.DATA_DIR ?? './data');
    try {
      await pipeline(
        Readable.from(exportOrganizationLines(pool, storage, orgId, (s) => void (summary = s))),
        createGzip(),
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (!summary) throw new Error('export did not complete');
      await rename(tmp, out);
    } catch (e) {
      await rm(tmp, { force: true });
      await withTenant(pool, orgId, actor, (tx) =>
        tx.exec(`UPDATE backup_runs SET status = 'failed', error = $3, finished_at = now() WHERE organization_id = $1 AND id = $2`, [orgId, runId, String((e as Error).message).slice(0, 300)]),
      ).catch(() => undefined);
      throw e;
    }
    const s = summary as ExportSummary;
    await withTenant(pool, orgId, actor, (tx) =>
      tx.exec(`UPDATE backup_runs SET status = 'succeeded', file_sha256 = $3, manifest = $4, finished_at = now() WHERE organization_id = $1 AND id = $2`, [
        orgId,
        runId,
        s.sha256,
        JSON.stringify({ counts: s.counts, users: s.users, files: s.files, missingFiles: s.missingFiles }),
      ]),
    );
    const size = (await stat(out)).size;
    const rows = Object.values(s.counts).reduce((a, n) => a + n, 0);
    console.log(`organization: ${org.name} (${orgId})`);
    console.log(`file:         ${out}`);
    console.log(`size:         ${(size / 1024 / 1024).toFixed(2)} MB (gzip)`);
    console.log(`rows:         ${rows}  users: ${s.users}  files: ${s.files}${s.missingFiles ? `  (missing: ${s.missingFiles})` : ''}`);
    if (s.missingFiles) {
      console.error(
        `警告: 写真 ${s.missingFiles} 件のファイルが保存先（DATA_DIR=${process.env.DATA_DIR ?? './data'}）に見つかりません。` +
          `アプリと同じ DATA_DIR を指定して取り直してください（欠落を承知で取る場合は --allow-missing-files）。`,
      );
      if (!values['allow-missing-files']) process.exitCode = 1;
    }
    console.log(`sha256:       ${s.sha256}`);
    for (const [t, n] of Object.entries(s.counts)) if (n) console.log(`  ${t.padEnd(24)} ${n}`);
    if (values.verify) {
      const v = await verifyBackup(linesFromGzipFile(out));
      console.log(v.ok ? 'verify:       OK' : `verify:       NG\n  ${v.errors.join('\n  ')}`);
      if (!v.ok) process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
