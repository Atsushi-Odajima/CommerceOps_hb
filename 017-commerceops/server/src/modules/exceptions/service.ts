import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

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

/**
 * 例外の一括作成（CSV 取込などで多数になる場合）。dedupeKey が未解決で既にあるものはスキップ。
 * 連番はまとめて払い出す（欠番は許容）。
 */
export async function createExceptionsBulk(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  items: { type: ExceptionType; title: string; severity?: 'low' | 'medium' | 'high'; dedupeKey: string; orderId?: string | null; detail?: Record<string, unknown> }[],
): Promise<number> {
  if (!items.length) return 0;
  const existing = await tx.many(
    `SELECT dedupe_key FROM exception_cases WHERE organization_id = $1 AND dedupe_key = ANY($2) AND status IN ('open', 'investigating')`,
    [tx.orgId, items.map((i) => i.dedupeKey)],
  );
  const skip = new Set(existing.map((e) => e.dedupe_key as string));
  const todo = items.filter((i, idx) => !skip.has(i.dedupeKey) && items.findIndex((x) => x.dedupeKey === i.dedupeKey) === idx);
  if (!todo.length) return 0;
  const numbers = await nextNumbers(deps.numberingPool, tx.orgId, 'exception', todo.length);
  const ids = todo.map(() => uuidv7());
  const inserted = await tx.many(
    `INSERT INTO exception_cases (organization_id, id, exception_number, type, severity, title, detail, dedupe_key, order_id, created_by)
     SELECT $1, u.id, u.num, u.type, u.sev, u.title, u.detail::jsonb, u.dkey, u.order_id, $9
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $10::uuid[]) AS u(id, num, type, sev, title, detail, dkey, order_id)
     ON CONFLICT (organization_id, dedupe_key) WHERE status IN ('open', 'investigating') AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, title`,
    [
      tx.orgId,
      ids,
      numbers,
      todo.map((i) => i.type),
      todo.map((i) => i.severity ?? 'medium'),
      todo.map((i) => i.title.slice(0, 300)),
      todo.map((i) => JSON.stringify(i.detail ?? {})),
      todo.map((i) => i.dedupeKey),
      tx.actor.userId,
      todo.map((i) => i.orderId ?? null),
    ],
  );
  if (inserted.length) {
    await tx.exec(
      `INSERT INTO exception_events (organization_id, id, exception_id, event_type, to_status, note, actor_user_id)
       SELECT $1, u.id, u.exc, 'created', 'open', u.note, $4 FROM unnest($2::uuid[], $3::uuid[], $5::text[]) AS u(id, exc, note)`,
      [tx.orgId, inserted.map(() => uuidv7()), inserted.map((r) => r.id), tx.actor.userId, inserted.map((r) => r.title)],
    );
  }
  return inserted.length;
}

export const EXCEPTION_STATUSES = ['open', 'investigating', 'resolved', 'ignored'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export const RESOLUTION_CODES = ['fixed', 'stock_adjusted', 'reallocated', 'address_corrected', 'customer_contacted', 'duplicate', 'other'] as const;

const EXC_TRANSITIONS: Record<ExceptionStatus, ExceptionStatus[]> = {
  open: ['investigating', 'resolved', 'ignored'],
  investigating: ['open', 'resolved', 'ignored'],
  resolved: ['open'],
  ignored: ['open'],
};

/** 例外の状態変更（Open / Investigating / Resolved / Ignored）。Ignored は理由必須、Resolved は解決コード必須 */
export async function changeExceptionStatus(
  tx: Tx,
  id: string,
  input: { status: ExceptionStatus; note?: string | null; resolutionCode?: (typeof RESOLUTION_CODES)[number] | null; ignoredReason?: string | null },
) {
  const e = await tx.maybeOne(`SELECT * FROM exception_cases WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, id]);
  if (!e) throw notFound('例外');
  const from = e.status as ExceptionStatus;
  if (from === input.status) return { status: from, unchanged: true };
  if (!EXC_TRANSITIONS[from].includes(input.status)) throw conflict('INVALID_TRANSITION', `この状態（${from}）から ${input.status} にはできません`);
  const note = input.note?.trim() || null;
  if (input.status === 'ignored' && (input.ignoredReason?.trim().length ?? 0) < 2) throw badRequest('REASON_REQUIRED', '無視する理由を入力してください');
  if (input.status === 'resolved') {
    if (!input.resolutionCode) throw badRequest('RESOLUTION_REQUIRED', '解決方法を選択してください');
    if (input.resolutionCode === 'other' && !note) throw badRequest('NOTE_REQUIRED', '解決方法が「その他」の場合はメモを入力してください');
  }
  if (input.status === 'open' && e.dedupe_key) {
    const dup = await tx.maybeOne(
      `SELECT exception_number FROM exception_cases WHERE organization_id = $1 AND dedupe_key = $2 AND status IN ('open', 'investigating') AND id <> $3`,
      [tx.orgId, e.dedupe_key, id],
    );
    if (dup) throw conflict('ALREADY_OPEN', `同じ内容の例外 ${dup.exception_number} が未解決です。そちらで対応してください`);
  }
  await tx.exec(
    `UPDATE exception_cases SET status = $3, updated_at = now(),
            resolved_at = CASE WHEN $3 IN ('resolved', 'ignored') THEN now() ELSE NULL END,
            resolved_by = CASE WHEN $3 IN ('resolved', 'ignored') THEN $4::uuid ELSE NULL END,
            resolution_code = CASE WHEN $3 = 'resolved' THEN $5 ELSE NULL END,
            resolution_note = CASE WHEN $3 = 'resolved' THEN $6 ELSE NULL END,
            ignored_reason = CASE WHEN $3 = 'ignored' THEN $7 ELSE NULL END
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, id, input.status, tx.actor.userId, input.resolutionCode ?? null, note?.slice(0, 500) ?? null, input.ignoredReason?.trim().slice(0, 300) ?? null],
  );
  await tx.exec(
    `INSERT INTO exception_events (organization_id, id, exception_id, event_type, from_status, to_status, note, actor_user_id) VALUES ($1, $2, $3, 'status', $4, $5, $6, $7)`,
    [tx.orgId, uuidv7(), id, from, input.status, (input.status === 'ignored' ? input.ignoredReason?.trim() : note)?.slice(0, 500) ?? null, tx.actor.userId],
  );
  return { status: input.status, unchanged: false, exceptionNumber: e.exception_number as string, from };
}

export async function assignException(tx: Tx, id: string, userId: string | null) {
  const e = await tx.maybeOne(`SELECT id, exception_number, assignee_user_id, status FROM exception_cases WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, id]);
  if (!e) throw notFound('例外');
  if (!['open', 'investigating'].includes(e.status)) throw conflict('EXCEPTION_CLOSED', '解決済み・無視した例外は割り当てられません');
  if (e.assignee_user_id === userId) return { unchanged: true, exceptionNumber: e.exception_number as string };
  await tx.exec(`UPDATE exception_cases SET assignee_user_id = $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [tx.orgId, id, userId]);
  await tx.exec(`INSERT INTO exception_events (organization_id, id, exception_id, event_type, note, actor_user_id) VALUES ($1, $2, $3, 'assigned', $4, $5)`, [
    tx.orgId,
    uuidv7(),
    id,
    userId ? `担当者を設定` : '担当者を解除',
    tx.actor.userId,
  ]);
  return { unchanged: false, exceptionNumber: e.exception_number as string };
}

export async function commentException(tx: Tx, id: string, note: string) {
  const e = await tx.maybeOne(`SELECT id FROM exception_cases WHERE organization_id = $1 AND id = $2`, [tx.orgId, id]);
  if (!e) throw notFound('例外');
  await tx.exec(`INSERT INTO exception_events (organization_id, id, exception_id, event_type, note, actor_user_id) VALUES ($1, $2, $3, 'comment', $4, $5)`, [
    tx.orgId,
    uuidv7(),
    id,
    note.slice(0, 1000),
    tx.actor.userId,
  ]);
}
