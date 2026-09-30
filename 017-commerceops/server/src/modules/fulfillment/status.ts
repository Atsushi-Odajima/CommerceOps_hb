import type { Tx } from '../../db/tx.js';

/**
 * Fulfillment の状態を事実から再計算（cancelled は維持）。
 * shipped > packed(梱包完了) > packing(梱包セッション中) > picked(全数ピック済) > picking(実績あり) > waved > ready
 */
export async function refreshFulfillmentStatus(tx: Tx, fulfillmentId: string): Promise<string> {
  // FOR NO KEY UPDATE: 状態列だけを更新するため。子行（pick_events 等）の INSERT が外部キー検査で取る KEY SHARE ロックと衝突せず、
  // 「両方が KEY SHARE を持ったまま FOR UPDATE を待つ」デッドロックを起こさない（状態更新どうしは引き続き直列化される）
  const f = await tx.maybeOne(`SELECT id, status, wave_id FROM fulfillments WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`, [tx.orgId, fulfillmentId]);
  if (!f || f.status === 'cancelled') return f?.status ?? 'cancelled';
  const agg = await tx.one(
    `SELECT COALESCE(SUM(required_qty), 0)::int AS required, COALESCE(SUM(picked_qty), 0)::int AS picked,
            COALESCE(SUM(short_qty), 0)::int AS short, COALESCE(SUM(packed_qty), 0)::int AS packed, COALESCE(SUM(shipped_qty), 0)::int AS shipped
       FROM fulfillment_items WHERE organization_id = $1 AND fulfillment_id = $2`,
    [tx.orgId, fulfillmentId],
  );
  const pack = await tx.one(
    `SELECT EXISTS (SELECT 1 FROM pack_sessions WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'active') AS active,
            EXISTS (SELECT 1 FROM pack_sessions WHERE organization_id = $1 AND fulfillment_id = $2 AND status = 'completed') AS completed`,
    [tx.orgId, fulfillmentId],
  );
  let next: string;
  if (agg.required === 0) next = 'cancelled';
  else if (agg.shipped >= agg.required) next = 'shipped';
  else if (pack.completed && agg.packed >= agg.required) next = 'packed';
  else if (pack.active) next = 'packing';
  else if (agg.picked >= agg.required) next = 'picked';
  else if (agg.picked > 0 || agg.short > 0) next = 'picking';
  else if (f.wave_id) next = 'waved';
  else next = 'ready';
  const hasShort = agg.short > 0;
  {
    await tx.exec(
      `UPDATE fulfillments SET status = $3, has_short = $4, updated_at = now(),
              picked_at = CASE WHEN $3 IN ('picked', 'packing', 'packed', 'shipped') THEN COALESCE(picked_at, now()) ELSE picked_at END,
              packed_at = CASE WHEN $3 IN ('packed', 'shipped') THEN COALESCE(packed_at, now()) ELSE NULL END,
              shipped_at = CASE WHEN $3 = 'shipped' THEN COALESCE(shipped_at, now()) ELSE shipped_at END,
              cancelled_at = CASE WHEN $3 = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END
        WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, fulfillmentId, next, hasShort],
    );
  }
  return next;
}

/** Wave の状態: 全タスク完了で picked、全 Fulfillment が梱包済み以降で completed */
export async function refreshWaveStatus(tx: Tx, waveId: string): Promise<string> {
  const w = await tx.maybeOne(`SELECT id, status FROM waves WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`, [tx.orgId, waveId]); // 理由は refreshFulfillmentStatus と同じ
  if (!w || w.status === 'cancelled') return w?.status ?? 'cancelled';
  const t = await tx.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('completed', 'cancelled'))::int AS done,
            count(*) FILTER (WHERE status = 'in_progress' OR started_at IS NOT NULL)::int AS started
       FROM pick_tasks WHERE organization_id = $1 AND wave_id = $2`,
    [tx.orgId, waveId],
  );
  const f = await tx.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE f.status IN ('packed', 'shipped', 'cancelled'))::int AS done
       FROM wave_fulfillments wf JOIN fulfillments f ON f.organization_id = wf.organization_id AND f.id = wf.fulfillment_id
      WHERE wf.organization_id = $1 AND wf.wave_id = $2 AND wf.removed_at IS NULL`,
    [tx.orgId, waveId],
  );
  let next = w.status as string;
  if (f.total > 0 && f.done === f.total) next = 'completed';
  else if (t.total > 0 && t.done === t.total) next = 'picked';
  else if (t.started > 0) next = 'picking';
  else next = 'open';
  if (f.total === 0 && t.total === t.done) next = 'completed';
  if (next !== w.status) {
    await tx.exec(
      `UPDATE waves SET status = $3, started_at = CASE WHEN $3 <> 'open' THEN COALESCE(started_at, now()) ELSE started_at END,
              completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END
        WHERE organization_id = $1 AND id = $2`,
      [tx.orgId, waveId, next],
    );
  }
  return next;
}
