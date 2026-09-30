import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { forbidden } from '../../lib/errors.js';
import { contentDisposition, encodeCsv, toCsv } from '../../lib/csv.js';
import { parse, zPage } from '../../lib/validate.js';
import { audit } from './audit.js';

const Query = zPage.extend({
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().trim().max(60).optional(),
});

function where(q: z.infer<typeof Query>, orgId: string, tz: string) {
  const params: unknown[] = [
    orgId,
    q.action ? `${q.action.replace(/[\\%_]/g, (m) => '\\' + m)}%` : null,
    q.entityType ?? null,
    q.entityId ?? null,
    q.actorId ?? null,
    q.from ?? null,
    q.to ?? null,
    tz,
    q.q ? `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%` : null,
  ];
  const sql = `a.organization_id = $1 AND ($2::text IS NULL OR a.action LIKE $2) AND ($3::text IS NULL OR a.entity_type = $3)
    AND ($4::uuid IS NULL OR a.entity_id = $4) AND ($5::uuid IS NULL OR a.actor_user_id = $5)
    AND ($6::date IS NULL OR a.created_at >= ($6::date::timestamp AT TIME ZONE $8)) AND ($7::date IS NULL OR a.created_at < (($7::date + 1)::timestamp AT TIME ZONE $8))
    AND ($9::text IS NULL OR a.summary ILIKE $9)`;
  return { sql, params };
}

/** 監査ログの閲覧（追記専用。変更・削除の API は存在しない。DB トリガーでも UPDATE/DELETE を拒否） */
export async function auditRoutes(app: FastifyInstance) {
  app.get('/api/audit', { preHandler: perm('audit.read') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(Query, req.query);
    return orgTx(req, async (tx) => {
      const w = where(q, tx.orgId, auth.org.timezone);
      const total = (await tx.one(`SELECT count(*)::int AS n FROM audit_logs a WHERE ${w.sql}`, w.params)).n;
      const rows = await tx.many(
        `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ${w.sql} ORDER BY a.created_at DESC, a.id DESC LIMIT $10 OFFSET $11`,
        [...w.params, q.limit, q.offset],
      );
      const actions = await tx.many(`SELECT DISTINCT split_part(action, '.', 1) AS prefix FROM audit_logs WHERE organization_id = $1 ORDER BY 1`, [tx.orgId]);
      return {
        total,
        prefixes: actions.map((a) => a.prefix),
        items: rows.map((r) => ({
          id: r.id,
          at: r.created_at,
          actorUserId: r.actor_user_id,
          actorName: r.actor_name,
          actorType: r.actor_type,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          summary: r.summary,
          metadata: r.metadata,
          ip: r.ip,
          requestId: r.request_id,
        })),
      };
    });
  });

  app.get('/api/audit/export', { preHandler: perm('audit.read') }, async (req, reply) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'export.csv')) throw forbidden();
    const q = parse(Query.extend({ encoding: z.enum(['utf-8', 'shift_jis']).default('utf-8') }), req.query);
    const text = await orgTx(req, async (tx) => {
      const w = where(q, tx.orgId, auth.org.timezone);
      const rows = await tx.many(
        `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${w.sql} ORDER BY a.created_at DESC LIMIT 100000`,
        w.params,
      );
      const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: auth.org.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(d));
      const csv = toCsv(
        ['日時', '実行者', '種別', '操作', '対象', '対象ID', '内容', '詳細', 'IP', 'リクエストID'],
        rows.map((r) => [fmt(r.created_at), r.actor_name ?? r.actor_type, r.actor_type, r.action, r.entity_type, r.entity_id, r.summary, JSON.stringify(r.metadata ?? {}), r.ip, r.request_id]),
      );
      await audit(tx, { action: 'export.audit', entityType: 'audit_log', summary: `監査ログ CSV 出力（${rows.length} 件）`, metadata: { count: rows.length } });
      return csv;
    });
    reply.header('content-type', `text/csv; charset=${q.encoding === 'shift_jis' ? 'Shift_JIS' : 'utf-8'}`);
    reply.header('content-disposition', contentDisposition(`audit_${new Date().toISOString().slice(0, 10)}.csv`));
    return reply.send(encodeCsv(text, q.encoding));
  });
}
