import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';

export const EXCEPTION_TYPES = [
  'shortage',
  'short_pick',
  'address_invalid',
  'forced_pack',
  'inventory_mismatch',
  'return_discrepancy',
  'tracking_duplicate',
  'import_conflict',
  'cancel_putback',
  'field_report',
  'other',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export interface NewException {
  type: ExceptionType;
  title: string;
  severity?: 'low' | 'medium' | 'high';
  /** 個人情報を入れない（SKU・数量・番号・理由コードなど） */
  detail?: Record<string, unknown>;
  dedupeKey?: string;
  orderId?: string | null;
  fulfillmentId?: string | null;
  waveId?: string | null;
  pickTaskId?: string | null;
  packSessionId?: string | null;
  shipmentId?: string | null;
  returnId?: string | null;
  importBatchId?: string | null;
  productId?: string | null;
  warehouseId?: string | null;
  locationId?: string | null;
  balanceId?: string | null;
}

/**
 * 例外を登録。dedupeKey が同じ未解決（open/investigating）の例外があれば新規作成せず既存 ID を返す。
 */
export async function createException(tx: Tx, deps: Pick<AppDeps, 'numberingPool'>, e: NewException): Promise<{ id: string; created: boolean }> {
  if (e.dedupeKey) {
    const existing = await tx.maybeOne(
      `SELECT id FROM exception_cases WHERE organization_id = $1 AND dedupe_key = $2 AND status IN ('open', 'investigating')`,
      [tx.orgId, e.dedupeKey],
    );
    if (existing) {
      await tx.exec(`UPDATE exception_cases SET detail = detail || $3::jsonb, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
        tx.orgId,
        existing.id,
        JSON.stringify(e.detail ?? {}),
      ]);
      return { id: existing.id, created: false };
    }
  }
  const [number] = await nextNumbers(deps.numberingPool, tx.orgId, 'exception', 1);
  const id = uuidv7();
  const inserted = await tx.maybeOne(
    `INSERT INTO exception_cases (organization_id, id, exception_number, type, severity, title, detail, dedupe_key, order_id, fulfillment_id,
                                  wave_id, pick_task_id, pack_session_id, shipment_id, return_id, import_batch_id, product_id, warehouse_id,
                                  location_id, balance_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (organization_id, dedupe_key) WHERE status IN ('open', 'investigating') AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      tx.orgId,
      id,
      number,
      e.type,
      e.severity ?? 'medium',
      e.title.slice(0, 300),
      JSON.stringify(e.detail ?? {}),
      e.dedupeKey ?? null,
      e.orderId ?? null,
      e.fulfillmentId ?? null,
      e.waveId ?? null,
      e.pickTaskId ?? null,
      e.packSessionId ?? null,
      e.shipmentId ?? null,
      e.returnId ?? null,
      e.importBatchId ?? null,
      e.productId ?? null,
      e.warehouseId ?? null,
      e.locationId ?? null,
      e.balanceId ?? null,
      tx.actor.userId,
    ],
  );
  if (!inserted) {
    const existing = await tx.one(
      `SELECT id FROM exception_cases WHERE organization_id = $1 AND dedupe_key = $2 AND status IN ('open', 'investigating')`,
      [tx.orgId, e.dedupeKey],
    );
    return { id: existing.id, created: false };
  }
  await tx.exec(
    `INSERT INTO exception_events (organization_id, id, exception_id, event_type, to_status, note, actor_user_id) VALUES ($1, $2, $3, 'created', 'open', $4, $5)`,
    [tx.orgId, uuidv7(), id, e.title.slice(0, 300), tx.actor.userId],
  );
  return { id, created: true };
}

/** 条件が解消した例外を自動解決（例: 欠品→全量引当） */
export async function autoResolveException(tx: Tx, dedupeKey: string, note: string): Promise<number> {
  const rows = await tx.many(
    `UPDATE exception_cases SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution_code = 'auto', resolution_note = $4, updated_at = now()
      WHERE organization_id = $1 AND dedupe_key = $2 AND status IN ('open', 'investigating')
      RETURNING id`,
    [tx.orgId, dedupeKey, tx.actor.userId, note],
  );
  for (const r of rows) {
    await tx.exec(
      `INSERT INTO exception_events (organization_id, id, exception_id, event_type, to_status, note, actor_user_id) VALUES ($1, $2, $3, 'resolved', 'resolved', $4, $5)`,
      [tx.orgId, uuidv7(), r.id, note, tx.actor.userId],
    );
  }
  return rows.length;
}
