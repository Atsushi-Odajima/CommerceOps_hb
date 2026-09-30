import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { claimTask, releaseTask } from '../picking/service.js';

/**
 * 作業割当（1 Task = 1 active assignee）。
 * - 一覧: 進行中の Pick タスク・梱包セッション・未解決の例外と、作業者ごとの現在の担当数（評価・ランキングではない）
 * - 管理者操作: Pick タスクの割当/解除、Wave の全タスク一括割当（梱包の引継ぎ・中止は Packing Station の API）
 */
export async function assignmentRoutes(app: FastifyInstance) {
  async function assertPickAssignee(req: FastifyRequest, userId: string, warehouseId: string) {
    const auth = requireOrg(req);
    const m = (await req.server.deps.pool.query(`SELECT role, warehouse_ids, status FROM memberships WHERE organization_id = $1 AND user_id = $2`, [auth.org.id, userId])).rows[0];
    if (!m || m.status !== 'active' || !['owner', 'ops_manager', 'picker'].includes(m.role) || (m.warehouse_ids && !m.warehouse_ids.includes(warehouseId))) {
      throw forbidden('このユーザーにはこの倉庫の Pick 作業を割り当てられません');
    }
  }

  app.get('/api/assignments', { preHandler: perm('waves.manage', 'fulfillment.manage', 'exceptions.manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(z.object({ warehouseId: z.uuid().optional() }), req.query);
    if (q.warehouseId) assertWarehouse(req, q.warehouseId);
    const scope = q.warehouseId ? [q.warehouseId] : auth.warehouseIds;
    return orgTx(req, async (tx) => {
      const now = Date.now();
      const pickTasks = hasPerm(auth, 'waves.manage')
        ? await tx.many(
            `SELECT t.id, t.task_number, t.status, t.zone, t.claim_expires_at, t.assignee_user_id, u.name AS assignee_name, w.id AS wave_id, w.wave_number, w.label,
                    wh.code AS warehouse_code, t.warehouse_id,
                    (SELECT count(*) FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id AND l.status <> 'cancelled')::int AS lines,
                    (SELECT COALESCE(SUM(required_qty), 0) FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id AND l.status <> 'cancelled')::int AS units,
                    (SELECT COALESCE(SUM(picked_qty + short_qty), 0) FROM pick_task_lines l WHERE l.organization_id = t.organization_id AND l.pick_task_id = t.id AND l.status <> 'cancelled')::int AS done
               FROM pick_tasks t JOIN waves w ON w.organization_id = t.organization_id AND w.id = t.wave_id
               JOIN warehouses wh ON wh.organization_id = t.organization_id AND wh.id = t.warehouse_id
               LEFT JOIN users u ON u.id = t.assignee_user_id
              WHERE t.organization_id = $1 AND t.status IN ('open', 'in_progress') AND ($2::uuid[] IS NULL OR t.warehouse_id = ANY($2))
              ORDER BY (t.assignee_user_id IS NULL) DESC, w.created_at, t.task_number LIMIT 300`,
            [tx.orgId, scope],
          )
        : [];
      const packSessions = hasPerm(auth, 'fulfillment.manage')
        ? await tx.many(
            `SELECT s.id, s.started_at, s.claim_expires_at, s.packer_user_id, u.name AS packer_name, s.mis_scan_count, f.fulfillment_number, o.order_number, wh.code AS warehouse_code,
                    (SELECT COALESCE(SUM(required_qty), 0) FROM fulfillment_items fi WHERE fi.organization_id = s.organization_id AND fi.fulfillment_id = s.fulfillment_id)::int AS required,
                    (SELECT COALESCE(SUM(packed_qty), 0) FROM fulfillment_items fi WHERE fi.organization_id = s.organization_id AND fi.fulfillment_id = s.fulfillment_id)::int AS packed
               FROM pack_sessions s JOIN fulfillments f ON f.organization_id = s.organization_id AND f.id = s.fulfillment_id
               JOIN orders o ON o.organization_id = f.organization_id AND o.id = f.order_id
               JOIN warehouses wh ON wh.organization_id = s.organization_id AND wh.id = s.warehouse_id
               LEFT JOIN users u ON u.id = s.packer_user_id
              WHERE s.organization_id = $1 AND s.status = 'active' AND ($2::uuid[] IS NULL OR s.warehouse_id = ANY($2))
              ORDER BY s.started_at LIMIT 300`,
            [tx.orgId, scope],
          )
        : [];
      const exceptions = hasPerm(auth, 'exceptions.manage')
        ? await tx.many(
            `SELECT e.id, e.exception_number, e.type, e.severity, e.status, e.title, e.created_at, e.assignee_user_id, u.name AS assignee_name
               FROM exception_cases e LEFT JOIN users u ON u.id = e.assignee_user_id
              WHERE e.organization_id = $1 AND e.status IN ('open', 'investigating') AND ($2::uuid[] IS NULL OR e.warehouse_id IS NULL OR e.warehouse_id = ANY($2))
              ORDER BY (e.assignee_user_id IS NULL) DESC, CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.created_at LIMIT 200`,
            [tx.orgId, scope],
          )
        : [];
      // 作業者ごとの現在の担当数（進行中の作業の見える化。評価には使わない）
      const load = new Map<string, { userId: string; name: string; pickTasks: number; packSessions: number; exceptions: number }>();
      const bump = (id: string | null, name: string | null, key: 'pickTasks' | 'packSessions' | 'exceptions') => {
        if (!id) return;
        const cur = load.get(id) ?? { userId: id, name: name ?? '—', pickTasks: 0, packSessions: 0, exceptions: 0 };
        cur[key]++;
        load.set(id, cur);
      };
      pickTasks.forEach((t) => bump(t.assignee_user_id, t.assignee_name, 'pickTasks'));
      packSessions.forEach((s) => bump(s.packer_user_id, s.packer_name, 'packSessions'));
      exceptions.forEach((e) => bump(e.assignee_user_id, e.assignee_name, 'exceptions'));
      return {
        pickTasks: pickTasks.map((t) => ({
          id: t.id,
          taskNumber: t.task_number,
          status: t.status,
          zone: t.zone,
          waveId: t.wave_id,
          waveNumber: t.wave_number,
          waveLabel: t.label,
          warehouseId: t.warehouse_id,
          warehouseCode: t.warehouse_code,
          assigneeUserId: t.assignee_user_id,
          assigneeName: t.assignee_name,
          claimExpiresAt: t.claim_expires_at,
          expired: !!t.claim_expires_at && new Date(t.claim_expires_at).getTime() < now,
          lines: t.lines,
          units: t.units,
          done: t.done,
        })),
        packSessions: packSessions.map((s) => ({
          id: s.id,
          fulfillmentNumber: s.fulfillment_number,
          orderNumber: s.order_number,
          warehouseCode: s.warehouse_code,
          packerUserId: s.packer_user_id,
          packerName: s.packer_name,
          startedAt: s.started_at,
          claimExpiresAt: s.claim_expires_at,
          expired: !!s.claim_expires_at && new Date(s.claim_expires_at).getTime() < now,
          required: s.required,
          packed: s.packed,
          misScanCount: s.mis_scan_count,
        })),
        exceptions: exceptions.map((e) => ({
          id: e.id,
          number: e.exception_number,
          type: e.type,
          severity: e.severity,
          status: e.status,
          title: e.title,
          createdAt: e.created_at,
          assigneeUserId: e.assignee_user_id,
          assigneeName: e.assignee_name,
        })),
        workload: [...load.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
      };
    });
  });

  /** 管理者が Pick タスクの担当を外す（進捗は保持） */
  app.post('/api/pick-tasks/:id/unassign', { preHandler: perm('waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    await orgTx(req, async (tx) => {
      const t = await tx.maybeOne(`SELECT warehouse_id FROM pick_tasks WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!t) throw notFound('Pick タスク');
      assertWarehouse(req, t.warehouse_id);
      await releaseTask(tx, id, auth.userId, true);
    });
    return { ok: true };
  });

  /** Wave の未完了タスクをまとめて 1 人に割り当てる（担当中のタスクも付け替える） */
  app.post('/api/waves/:id/assign', { preHandler: perm('waves.manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ userId: z.uuid(), onlyUnassigned: z.boolean().default(false) }), req.body);
    const wave = await orgTx(req, async (tx) => {
      const w = await tx.maybeOne(`SELECT id, wave_number, warehouse_id, status FROM waves WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
      if (!w) throw notFound('Wave');
      assertWarehouse(req, w.warehouse_id);
      if (['completed', 'cancelled'].includes(w.status)) throw conflict('WAVE_CLOSED', '完了・取消済みの Wave です');
      return w;
    });
    await assertPickAssignee(req, body.userId, wave.warehouse_id);
    return orgTx(req, async (tx) => {
      const tasks = await tx.many(
        `SELECT id, assignee_user_id FROM pick_tasks WHERE organization_id = $1 AND wave_id = $2 AND status IN ('open', 'in_progress') ORDER BY task_number`,
        [tx.orgId, id],
      );
      let assigned = 0;
      for (const t of tasks) {
        if (body.onlyUnassigned && t.assignee_user_id) continue;
        await claimTask(tx, t.id, body.userId, auth.org.settings.assignment.claimTimeoutMinutes, true);
        assigned++;
      }
      await audit(tx, { action: 'wave.assign', entityType: 'wave', entityId: id, summary: `${wave.wave_number} のタスク ${assigned} 件を割当`, metadata: { assignee: body.userId, assigned } });
      return { assigned };
    });
  });
}
