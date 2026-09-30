import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable, type Readable as ReadableType } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Pool } from '../../db/pool.js';
import { Tx, type Actor } from '../../db/tx.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import { SCHEMA_VERSION } from '../../version.js';
import { isRole } from '../../auth/permissions.js';
import type { Storage } from '../attachments/storage.js';
import { audit } from '../audit/audit.js';
import { checkIntegrity } from '../integrity/check.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_TABLES, USER_COLUMNS, type BackupHeader, type BackupTable, type BackupTrailer } from './format.js';
import { enqueue } from '../../jobs/queue.js';

export type LineSource = () => AsyncIterable<string>;

const MAX_LINE = 64 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function* readLines(stream: ReadableType, maxBytes: number): AsyncGenerator<string> {
  let total = 0;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    total += line.length + 1;
    if (total > maxBytes) throw badRequest('BACKUP_TOO_LARGE', '展開後のサイズが上限を超えています（大きなバックアップはコマンドラインで復元してください）');
    yield line;
  }
}

/** アップロードされたファイルが gzip であることを確認（ZIP は受け付けない） */
export function assertGzip(buf: Buffer) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) {
    throw badRequest('ZIP_NOT_SUPPORTED', 'ZIP ファイルは受け付けません。CommerceOps のバックアップファイル（.ndjson.gz）を指定してください');
  }
  if (!(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) throw badRequest('NOT_A_BACKUP', 'CommerceOps のバックアップファイル（gzip 圧縮）ではありません');
}

export function linesFromGzipBuffer(buf: Buffer, maxBytes = 2 * 1024 * 1024 * 1024): LineSource {
  return () => readLines(Readable.from([buf]).pipe(createGunzip()), maxBytes);
}

export function linesFromGzipFile(path: string, maxBytes = Number.MAX_SAFE_INTEGER): LineSource {
  return () => readLines(createReadStream(path).pipe(createGunzip()), maxBytes);
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  header: BackupHeader | null;
  trailer: BackupTrailer | null;
  counts: Record<string, number>;
  users: number;
  memberships: number;
  files: number;
  /** バックアップ作成時に保存先にファイルがなく「欠落」として記録された写真の数 */
  missingFiles: number;
}

/**
 * 復元前の検証（DB には何も書かない）: 形式・版・行の順序・テーブル別件数・テーブル別/全体チェックサム・添付ファイルのハッシュ。
 */
export async function verifyBackup(source: LineSource): Promise<VerifyResult> {
  const errors: string[] = [];
  let header: BackupHeader | null = null;
  let trailer: BackupTrailer | null = null;
  const all = createHash('sha256');
  const th = new Map<string, Hash>();
  const counts: Record<string, number> = {};
  let users = 0;
  let memberships = 0;
  let files = 0;
  let missingFiles = 0;
  let tooLarge = false;
  let lastIdx = -1;
  let lineNo = 0;
  const attachmentIds = new Set<string>();
  const fail = (m: string) => {
    errors.push(m);
  };
  try {
    for await (const line of source()) {
      lineNo++;
      if (trailer) {
        fail('最終行（trailer）の後にデータがあります');
        break;
      }
      if (line.length > MAX_LINE) {
        fail(`${lineNo} 行目が長すぎます`);
        break;
      }
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        fail(`${lineNo} 行目を読み取れません（ファイルが壊れている可能性があります）`);
        break;
      }
      if (lineNo === 1) {
        if (obj?.type !== 'header' || obj.format !== BACKUP_FORMAT) {
          fail('CommerceOps のバックアップファイルではありません');
          break;
        }
        if (obj.formatVersion !== BACKUP_FORMAT_VERSION) fail(`バックアップ形式の版が異なります（ファイル: ${obj.formatVersion} / このシステム: ${BACKUP_FORMAT_VERSION}）`);
        if (obj.schemaVersion !== SCHEMA_VERSION) fail(`データベースの版が異なります（ファイル: ${obj.schemaVersion} / このシステム: ${SCHEMA_VERSION}）。同じ版のシステムで復元してください`);
        if (!obj.organization?.id || typeof obj.organization.name !== 'string') fail('ヘッダーに組織情報がありません');
        header = obj;
        all.update(line + '\n');
        continue;
      }
      if (obj?.type === 'trailer') {
        trailer = obj;
        continue;
      }
      all.update(line + '\n');
      switch (obj?.type) {
        case 'user':
          users++;
          if (!UUID_RE.test(obj.d?.id ?? '') || typeof obj.d?.email !== 'string') fail(`${lineNo} 行目: ユーザー情報が不正です`);
          break;
        case 'membership':
          memberships++;
          if (!UUID_RE.test(obj.d?.user_id ?? '') || !isRole(obj.d?.role)) fail(`${lineNo} 行目: メンバー情報が不正です`);
          break;
        case 'row': {
          const idx = BACKUP_TABLES.indexOf(obj.t);
          if (idx < 0) {
            fail(`${lineNo} 行目: 対象外のテーブル（${String(obj.t).slice(0, 40)}）`);
            break;
          }
          if (idx < lastIdx) fail(`${lineNo} 行目: テーブルの順序が不正です`);
          lastIdx = idx;
          if (!obj.d || typeof obj.d !== 'object' || 'organization_id' in obj.d) fail(`${lineNo} 行目: 行データが不正です`);
          if (!th.has(obj.t)) th.set(obj.t, createHash('sha256'));
          th.get(obj.t)!.update(line + '\n');
          counts[obj.t] = (counts[obj.t] ?? 0) + 1;
          if (obj.t === 'attachments') attachmentIds.add(obj.d.id);
          break;
        }
        case 'file': {
          files++;
          if (!attachmentIds.has(obj.id)) fail(`${lineNo} 行目: 添付ファイルに対応する行がありません`);
          if (obj.missing) missingFiles++;
          else {
            const data = Buffer.from(String(obj.data ?? ''), 'base64');
            if (createHash('sha256').update(data).digest('hex') !== obj.sha256) fail(`${lineNo} 行目: 添付ファイルのハッシュが一致しません`);
          }
          break;
        }
        default:
          fail(`${lineNo} 行目: 不明な行の種類`);
      }
      if (errors.length >= 20) break;
    }
  } catch (e) {
    tooLarge = e instanceof AppError && e.code === 'BACKUP_TOO_LARGE';
    fail(e instanceof AppError ? e.message : `ファイルを最後まで読めませんでした（破損または途中までのファイル）: ${(e as Error).message}`.slice(0, 300));
  }
  if (!header) fail('ヘッダーがありません');
  // 上限で読むのを止めた場合は最終行まで届いていないだけなので、「途中で止まったファイル」とは言わない
  if (!trailer) {
    if (!tooLarge) fail('最終行（trailer）がありません。ダウンロードが途中で止まったファイルの可能性があります');
  } else {
    for (const t of BACKUP_TABLES) {
      const expected = trailer.counts?.[t] ?? 0;
      if ((counts[t] ?? 0) !== expected) fail(`${t}: 件数が一致しません（ファイル内 ${counts[t] ?? 0} / 記録 ${expected}）`);
      const h = th.get(t)?.digest('hex') ?? createHash('sha256').digest('hex');
      if (trailer.tableSha256?.[t] !== h) fail(`${t}: チェックサムが一致しません（改ざん・破損の可能性）`);
    }
    if (trailer.users !== users || trailer.memberships !== memberships || trailer.files !== files) fail('ユーザー・メンバー・添付ファイルの件数が一致しません');
    if (trailer.sha256 !== all.digest('hex')) fail('ファイル全体のチェックサムが一致しません（改ざん・破損の可能性）');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)].slice(0, 20), header, trailer, counts, users, memberships, files, missingFiles };
}

export interface RestoreResult {
  organizationId: string;
  name: string;
  counts: Record<string, number>;
  users: { restored: number; created: number; matchedByEmail: number; unlinked: number };
  /** 対応付けなかったユーザー（Owner が必要に応じて招待し直す）。userPolicy = 'owner-scoped' のときのみ */
  unlinkedUsers: { name: string; email: string; role: string | null }[];
}

/**
 * ユーザーの対応付け方針
 * - trusted（コマンドライン = サーバー運用者）: ID → メールアドレス → 作成（パスワード未設定・招待中）
 * - owner-scoped（画面からの復元 = 組織の Owner）: 復元する人が Owner を務める組織のメンバー（と本人）だけを ID で対応付ける。
 *   それ以外のユーザーはアカウントを作らず・メンバーにもせず、一覧で返す（他の組織のアカウントを勝手に自分の組織へ加えられないようにする）
 */
export type UserPolicy = 'trusted' | 'owner-scoped';

/**
 * 新しい組織として復元（既存の組織・データは一切変更しない）。
 * 1 トランザクションで投入 → 整合性チェック・件数照合 → 問題があればロールバック（添付ファイルも削除）。
 * ユーザーの扱いは UserPolicy を参照。
 */
export async function restoreBackup(
  deps: { pool: Pool; storage: Storage },
  source: LineSource,
  opts: { actor: Actor & { userId: string }; userPolicy: UserPolicy; name?: string; filename?: string; verified?: VerifyResult },
): Promise<RestoreResult> {
  const v = opts.verified ?? (await verifyBackup(source));
  if (!v.ok || !v.header) throw new AppError(400, 'BACKUP_INVALID', 'バックアップファイルの検証に失敗しました', { errors: v.errors });
  const h = v.header;
  const newOrgId = uuidv7();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: h.organization.timezone || 'Asia/Tokyo' }).format(new Date());
  const name = (opts.name?.trim() || `${h.organization.name}（復元 ${today}）`).slice(0, 200);
  const client = await deps.pool.connect();
  const stored: string[] = [];
  const userMap = new Map<string, string>();
  const userStats = { restored: 0, created: 0, matchedByEmail: 0, unlinked: 0 };
  const unlinked = new Map<string, { name: string; email: string; role: string | null }>();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO organizations (id, name, timezone, is_sample, settings) VALUES ($1, $2, $3, $4, $5)`, [
      newOrgId,
      name,
      h.organization.timezone || 'Asia/Tokyo',
      !!h.organization.isSample,
      JSON.stringify(h.organization.settings ?? {}),
    ]);
    await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [newOrgId, opts.actor.userId]);
    const tx = new Tx(client, newOrgId, opts.actor);
    let table: BackupTable | null = null;
    let buf: Record<string, unknown>[] = [];
    const flush = async () => {
      if (!table || !buf.length) return;
      await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(buf)]);
      buf = [];
    };
    for await (const line of source()) {
      const obj = JSON.parse(line);
      switch (obj.type) {
        case 'user': {
          const d = obj.d;
          const email = String(d.email).trim().toLowerCase();
          if (opts.userPolicy === 'owner-scoped') {
            // 本人（別環境のバックアップでも同じメールアドレスなら本人のアカウントへ）
            const self = (await client.query('SELECT id FROM users WHERE id = $1 AND (id = $2 OR lower(email) = $3)', [opts.actor.userId, d.id, email])).rows[0];
            if (self) {
              userMap.set(d.id, opts.actor.userId);
              if (d.id === opts.actor.userId) userStats.restored++;
              else userStats.matchedByEmail++;
              break;
            }
            const managed = (
              await client.query(
                `SELECT u.id FROM users u WHERE u.id = $1 AND u.status <> 'disabled' AND EXISTS (
                   SELECT 1 FROM memberships m JOIN memberships o ON o.organization_id = m.organization_id
                    WHERE m.user_id = u.id AND o.user_id = $2 AND o.role = 'owner' AND o.status = 'active')`,
                [d.id, opts.actor.userId],
              )
            ).rows[0];
            if (managed) {
              userMap.set(d.id, d.id);
              userStats.restored++;
            } else {
              unlinked.set(d.id, { name: String(d.name ?? '').slice(0, 100), email: email.slice(0, 254), role: null });
              userStats.unlinked++;
            }
            break;
          }
          const byId = (await client.query('SELECT id FROM users WHERE id = $1', [d.id])).rows[0];
          if (byId) {
            userMap.set(d.id, d.id);
            userStats.restored++;
            break;
          }
          const byEmail = (await client.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0];
          if (byEmail) {
            userMap.set(d.id, byEmail.id);
            userStats.matchedByEmail++;
            break;
          }
          // パスワード未設定の「招待中」アカウントとして作成（Owner がパスワード再設定リンクを発行して本人に渡す）
          await client.query(`INSERT INTO users (id, email, name, password_hash, status) VALUES ($1, $2, $3, NULL, 'invited')`, [
            d.id,
            email,
            String(d.name || email).slice(0, 100),
          ]);
          userMap.set(d.id, d.id);
          userStats.created++;
          break;
        }
        case 'membership': {
          const d = obj.d;
          const uid = userMap.get(d.user_id);
          const u = unlinked.get(d.user_id);
          if (u) u.role = String(d.role);
          if (!uid) break;
          await client.query(
            `INSERT INTO memberships (organization_id, user_id, role, warehouse_ids, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (organization_id, user_id) DO NOTHING`,
            [newOrgId, uid, d.role, d.warehouse_ids, d.status, d.created_at],
          );
          break;
        }
        case 'row': {
          if (obj.t !== table) {
            await flush();
            table = obj.t as BackupTable;
          }
          const row: Record<string, unknown> = { ...obj.d, organization_id: newOrgId };
          for (const c of USER_COLUMNS[table!] ?? []) {
            const u = row[c];
            if (typeof u === 'string' && userMap.has(u)) row[c] = userMap.get(u);
          }
          if (table === 'attachments') row.storage_key = `${newOrgId}/${String(row.id)}`;
          buf.push(row);
          if (buf.length >= 500) await flush();
          break;
        }
        case 'file': {
          await flush();
          if (!obj.missing) {
            const key = `${newOrgId}/${obj.id}`;
            await deps.storage.put(key, Buffer.from(obj.data, 'base64'), 'application/octet-stream');
            stored.push(key);
          }
          break;
        }
        default:
          break;
      }
    }
    await flush();
    // 復元した人を新しい組織の Owner にする
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, role, warehouse_ids, status) VALUES ($1, $2, 'owner', NULL, 'active')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner', warehouse_ids = NULL, status = 'active', updated_at = now()`,
      [newOrgId, opts.actor.userId],
    );
    // 件数の照合と整合性チェック（失敗したらロールバック = 既存データは変更なし・新しい組織も作られない）
    for (const t of BACKUP_TABLES) {
      const n = (await client.query(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [newOrgId])).rows[0].n;
      if (n !== (v.counts[t] ?? 0)) throw new AppError(409, 'RESTORE_COUNT_MISMATCH', `復元後の件数が一致しません（${t}: ${n} / ${v.counts[t] ?? 0}）。復元を取り消しました`);
    }
    const violations = await checkIntegrity(tx);
    if (violations.length) throw new AppError(409, 'RESTORE_INTEGRITY_FAILED', '復元後の整合性チェックに失敗したため、復元を取り消しました', { violations });
    const totals = Object.values(v.counts).reduce((s, n) => s + n, 0);
    await tx.exec(
      `INSERT INTO backup_runs (organization_id, id, kind, status, filename, file_sha256, manifest, created_by, finished_at)
       VALUES ($1, $2, 'restore', 'succeeded', $3, $4, $5, $6, now())`,
      [newOrgId, uuidv7(), opts.filename?.slice(0, 200) ?? null, v.trailer?.sha256 ?? null, JSON.stringify({ sourceOrganizationId: h.organization.id, createdAt: h.createdAt, counts: v.counts, users: userStats }), opts.actor.userId],
    );
    await audit(tx, {
      action: 'backup.restore',
      entityType: 'organization',
      entityId: newOrgId,
      summary: `バックアップ（${h.createdAt.slice(0, 16)} 作成）から組織「${name}」を復元（${totals} 行）`,
      metadata: { sourceOrganizationId: h.organization.id, rows: totals, users: userStats },
    });
    // 復元した行を統計情報に反映する（大きな組織がある DB でも、新しい組織の問い合わせが行数を見誤らないように）。worker が実行する
    await enqueue(client, { type: 'db.analyze', payload: { tables: [...BACKUP_TABLES] }, dedupeKey: 'db.analyze' });
    await client.query('COMMIT');
    return { organizationId: newOrgId, name, counts: v.counts, users: userStats, unlinkedUsers: [...unlinked.values()].slice(0, 500) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    for (const k of stored) await deps.storage.delete(k).catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
