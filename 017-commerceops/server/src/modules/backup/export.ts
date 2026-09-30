import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Pool } from '../../db/pool.js';
import type { Storage } from '../attachments/storage.js';
import { APP_VERSION, SCHEMA_VERSION } from '../../version.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_TABLES, PRIMARY_KEYS, type BackupHeader, type BackupTrailer } from './format.js';

const PAGE = 1000;

/**
 * timestamp / timestamptz / numeric は文字列のまま扱う
 * （JS Date はマイクロ秒を切り捨て、Number は numeric の桁・スケールを保てないため、復元で値が変わってしまう）
 */
const RAW_OIDS = new Set([1184, 1114, 1700]);
export const RAW_EXACT_TYPES = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    RAW_OIDS.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
};

export interface ExportSummary {
  counts: Record<string, number>;
  users: number;
  memberships: number;
  files: number;
  sha256: string;
}

/**
 * 組織のバックアップを NDJSON の行として順に返す（呼び出し側で gzip する）。
 * REPEATABLE READ の読み取り専用トランザクションで一貫したスナップショットを取る。
 * 完了時に onDone(summary) を呼ぶ（途中で中断された場合は呼ばれない → trailer のないファイルは復元時に拒否される）。
 */
export async function* exportOrganizationLines(
  pool: Pool,
  storage: Storage,
  orgId: string,
  onDone?: (s: ExportSummary) => void | Promise<void>,
): AsyncGenerator<string> {
  const client = await pool.connect();
  let inTx = false;
  const q = async (text: string, values: unknown[] = []): Promise<{ rows: Record<string, any>[] }> => client.query({ text, values, types: RAW_EXACT_TYPES });
  const all = createHash('sha256');
  const tableHashes: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const emit = (obj: unknown) => {
    const line = JSON.stringify(obj);
    all.update(line + '\n');
    return line + '\n';
  };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTx = true;
    // 時刻の文字列表現を UTC に固定（どの環境で取得しても同じ内容・同じチェックサムになる）
    await client.query("SELECT set_config('app.org_id', $1, true), set_config('TimeZone', 'UTC', true)", [orgId]);
    const org = (await q('SELECT id, name, timezone, is_sample, settings FROM organizations WHERE id = $1', [orgId])).rows[0];
    if (!org) throw new Error('organization not found');
    const header: BackupHeader = {
      type: 'header',
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      organization: { id: org.id, name: org.name, timezone: org.timezone, isSample: org.is_sample, settings: org.settings },
    };
    yield emit(header);
    // ユーザー（パスワードハッシュ等の認証情報は含めない）とメンバーシップ
    const members = (
      await q(
        `SELECT m.user_id, m.role, m.warehouse_ids, m.status, m.created_at, u.email, u.name, u.status AS user_status
           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY m.user_id`,
        [orgId],
      )
    ).rows;
    for (const m of members) yield emit({ type: 'user', d: { id: m.user_id, email: m.email, name: m.name, status: m.user_status } });
    for (const m of members) yield emit({ type: 'membership', d: { user_id: m.user_id, role: m.role, warehouse_ids: m.warehouse_ids, status: m.status, created_at: m.created_at } });
    const attachments: { id: string; storage_key: string; sha256: string }[] = [];
    for (const t of BACKUP_TABLES) {
      const pk = PRIMARY_KEYS[t];
      const th = createHash('sha256');
      let n = 0;
      let last: unknown[] | null = null;
      for (;;) {
        const cond: string = last ? `AND (${pk.join(', ')}) > (${pk.map((_, i) => `$${i + 2}`).join(', ')})` : '';
        const rows = (await q(`SELECT * FROM ${t} WHERE organization_id = $1 ${cond} ORDER BY ${pk.join(', ')} LIMIT ${PAGE}`, [orgId, ...(last ?? [])])).rows;
        for (const row of rows) {
          const { organization_id: _org, ...d } = row;
          const line = emit({ type: 'row', t, d });
          th.update(line);
          n++;
          if (t === 'attachments') attachments.push({ id: row.id, storage_key: row.storage_key, sha256: row.sha256 });
          yield line;
        }
        if (rows.length < PAGE) break;
        const lastRow: Record<string, unknown> = rows[rows.length - 1]!;
        last = pk.map((k): unknown => lastRow[k]);
      }
      counts[t] = n;
      tableHashes[t] = th.digest('hex');
    }
    await client.query('COMMIT');
    inTx = false;
    let files = 0;
    for (const a of attachments) {
      const data = await storage.get(a.storage_key);
      yield emit(data ? { type: 'file', id: a.id, sha256: a.sha256, data: data.toString('base64') } : { type: 'file', id: a.id, sha256: a.sha256, missing: true });
      files++;
    }
    const trailer: BackupTrailer = {
      type: 'trailer',
      counts,
      tableSha256: tableHashes,
      users: members.length,
      memberships: members.length,
      files,
      sha256: all.digest('hex'),
    };
    yield JSON.stringify(trailer) + '\n';
    await onDone?.({ counts, users: members.length, memberships: members.length, files, sha256: trailer.sha256 });
  } finally {
    // 途中で中断された（例外・ダウンロード中止）場合も、トランザクションを閉じてから接続を返す
    if (inTx) await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
