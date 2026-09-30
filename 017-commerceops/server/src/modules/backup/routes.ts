import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFromReq, orgTx, perm, requireOrg } from '../../http.js';
import { withTenant } from '../../db/tx.js';
import { badRequest } from '../../lib/errors.js';
import { contentDisposition } from '../../lib/csv.js';
import { readUploadToFile, type FileUpload } from '../../lib/upload.js';
import { uuidv7 } from '../../lib/uuid.js';
import { parse } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { exportOrganizationLines } from './export.js';
import { assertGzip, linesFromGzipFile, restoreBackup, verifyBackup } from './restore.js';

export async function backupRoutes(app: FastifyInstance) {
  const { pool, storage, config } = app.deps;
  const tmpDir = join(config.DATA_DIR, 'tmp');

  /** アップロードを一時ファイルへ保存し、gzip であること（ZIP でないこと）を先頭バイトで確認 */
  async function receive(req: Parameters<typeof readUploadToFile>[0]): Promise<FileUpload> {
    const up = await readUploadToFile(req, { maxBytes: config.BACKUP_MAX_UPLOAD_MB * 1024 * 1024, dir: tmpDir });
    try {
      const fh = await open(up.path, 'r');
      const head = Buffer.alloc(4);
      try {
        await fh.read(head, 0, 4, 0);
      } finally {
        await fh.close();
      }
      assertGzip(head.subarray(0, Math.min(4, up.size)));
      return up;
    } catch (e) {
      await rm(up.path, { force: true });
      throw e;
    }
  }

  app.get('/api/backup/runs', { preHandler: perm('backup.manage') }, async (req) => {
    return orgTx(req, async (tx) => {
      const rows = await tx.many(
        `SELECT b.*, u.name AS created_by_name FROM backup_runs b LEFT JOIN users u ON u.id = b.created_by
          WHERE b.organization_id = $1 ORDER BY b.created_at DESC LIMIT 50`,
        [tx.orgId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          filename: r.filename,
          fileSha256: r.file_sha256,
          manifest: r.manifest,
          error: r.error,
          createdBy: r.created_by_name,
          createdAt: r.created_at,
          finishedAt: r.finished_at,
        })),
        // 画面から扱えるファイルの上限（超える場合はサーバー運用者がコマンドラインで復元）
        limits: { maxUploadMb: config.BACKUP_MAX_UPLOAD_MB, maxExpandedMb: config.BACKUP_MAX_EXPANDED_MB },
      };
    });
  });

  /** バックアップのダウンロード（gzip NDJSON をストリーミング）。個人情報を含むため Owner のみ・監査ログに記録 */
  app.post('/api/backup/export', { preHandler: perm('backup.manage') }, async (req, reply) => {
    const auth = requireOrg(req);
    const runId = uuidv7();
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const filename = `commerceops-backup-${stamp}.ndjson.gz`;
    await orgTx(req, async (tx) => {
      await tx.exec(`INSERT INTO backup_runs (organization_id, id, kind, status, filename, created_by) VALUES ($1, $2, 'export', 'running', $3, $4)`, [
        tx.orgId,
        runId,
        filename,
        auth.userId,
      ]);
      await audit(tx, { action: 'backup.export', entityType: 'organization', entityId: tx.orgId, summary: 'バックアップをダウンロード', metadata: { runId } });
    });
    const actor = actorFromReq(req);
    const lines = exportOrganizationLines(pool, storage, auth.org.id, async (s) => {
      await withTenant(pool, auth.org.id, actor, (tx) =>
        tx.exec(`UPDATE backup_runs SET status = 'succeeded', file_sha256 = $3, manifest = $4, finished_at = now() WHERE organization_id = $1 AND id = $2`, [
          tx.orgId,
          runId,
          s.sha256,
          JSON.stringify({ counts: s.counts, users: s.users, files: s.files, missingFiles: s.missingFiles }),
        ]),
      ).catch(() => undefined);
    });
    const stream = Readable.from(lines).pipe(createGzip());
    stream.on('error', () => {
      void withTenant(pool, auth.org.id, actor, (tx) =>
        tx.exec(`UPDATE backup_runs SET status = 'failed', error = 'stream aborted', finished_at = now() WHERE organization_id = $1 AND id = $2 AND status = 'running'`, [tx.orgId, runId]),
      ).catch(() => undefined);
    });
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', contentDisposition(filename));
    reply.header('cache-control', 'no-store');
    return reply.send(stream);
  });

  /** 復元前の検証だけを行う（DB には書き込まない） */
  app.post('/api/backup/verify', { preHandler: perm('backup.manage') }, async (req) => {
    const up = await receive(req);
    try {
      const v = await verifyBackup(linesFromGzipFile(up.path, config.BACKUP_MAX_EXPANDED_MB * 1024 * 1024));
      return {
        ok: v.ok,
        errors: v.errors,
        header: v.header ? { organizationName: v.header.organization.name, createdAt: v.header.createdAt, schemaVersion: v.header.schemaVersion, appVersion: v.header.appVersion, isSample: v.header.organization.isSample } : null,
        counts: v.counts,
        users: v.users,
        files: v.files,
        missingFiles: v.missingFiles,
        sha256: v.trailer?.sha256 ?? null,
      };
    } finally {
      await rm(up.path, { force: true });
    }
  });

  /** 新しい組織として復元（現在の組織・データは変更しない）。復元した人が新しい組織の Owner になる */
  app.post('/api/backup/restore', { preHandler: perm('backup.manage') }, async (req) => {
    const auth = requireOrg(req);
    const up = await receive(req);
    try {
      const fields = parse(z.object({ confirm: z.literal('true'), name: z.string().trim().max(200).optional() }), up.fields);
      if (fields.confirm !== 'true') throw badRequest('CONFIRM_REQUIRED', '確認が必要です');
      const source = linesFromGzipFile(up.path, config.BACKUP_MAX_EXPANDED_MB * 1024 * 1024);
      const verified = await verifyBackup(source);
      const r = await restoreBackup({ pool, storage }, source, {
        actor: { ...actorFromReq(req), userId: auth.userId },
        userPolicy: 'owner-scoped',
        name: fields.name,
        filename: up.filename,
        verified,
      });
      // 復元を実行したことは元の組織の監査ログにも残す
      await orgTx(req, (tx) =>
        audit(tx, { action: 'backup.restore_started_here', entityType: 'organization', entityId: r.organizationId, summary: `バックアップから新しい組織「${r.name}」を復元`, metadata: { newOrganizationId: r.organizationId } }),
      );
      return r;
    } finally {
      await rm(up.path, { force: true });
    }
  });
}
