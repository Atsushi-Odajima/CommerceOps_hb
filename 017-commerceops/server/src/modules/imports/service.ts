/**
 * 注文 CSV 取込: ファイル → 文字コード → Profile → プレビュー → 構文/行/注文検証 → 重複/競合判定 → 件数確認 → 確定
 * docs/ORDER_NORMALIZATION.md
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/hash.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import { createException } from '../exceptions/service.js';
import { decodeCsvBuffer, parseCsvText } from './csvfile.js';
import {
  ORDER_LEVEL_FIELDS,
  TARGET_FIELDS,
  buildHeaderIndex,
  checkMappingColumns,
  mapRow,
  type FieldIssue,
  type Mapping,
  type MappedRow,
  type TargetField,
} from './mapping.js';
import {
  NormalizedOrderSchema,
  orderContentHash,
  splitPrefecture,
  validateForFulfillment,
  type NormalizedOrder,
  type ValidationIssue,
} from '../orders/normalized.js';
import { createOrders, loadProductsBySku, revalidateOrderRow } from '../orders/service.js';
import { recomputeOrderStatus } from '../orders/status.js';

export type Classification = 'new' | 'identical' | 'update_candidate' | 'conflict' | 'cancel_candidate' | 'invalid';

/** 取込更新を受け付ける（まだ引当されていない）状態 */
const UPDATABLE_STATUSES = new Set(['imported', 'validation_required', 'ready_for_allocation', 'on_hold']);

interface StagedOrder {
  seq: number;
  externalOrderId: string;
  classification: Classification;
  existingOrderId: string | null;
  contentHash: string | null;
  normalized: NormalizedOrder | null;
  errors: { line?: number; field?: string; message: string }[];
  warnings: { line?: number; field?: string; message: string }[];
  rowNumbers: number[];
  changed?: string[];
}

function valueKey(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}

function buildNormalized(rows: MappedRow[]): NormalizedOrder {
  const f = rows[0]!.values;
  const s = (k: TargetField) => (f[k] === null || f[k] === undefined ? null : String(f[k]));
  const n: NormalizedOrder = {
    externalOrderId: String(f.externalOrderId),
    orderDate: (f.orderDate as Date).toISOString(),
    customer: { name: s('customerName'), email: s('customerEmail'), phone: s('customerPhone'), channelCustomerId: s('channelCustomerId') },
    shipTo: splitPrefecture({
      name: s('recipientName'),
      postalCode: s('postalCode'),
      prefecture: s('prefecture'),
      city: s('city'),
      address1: s('address1'),
      address2: s('address2'),
      phone: s('recipientPhone'),
    }),
    shippingMethod: s('shippingMethod'),
    notes: s('notes'),
    priority: typeof f.priority === 'number' ? f.priority : 0,
    cancelFlag: f.cancelFlag === true,
    lines: rows.map((r) => ({
      sku: String(r.values.sku),
      productName: r.values.productName ? String(r.values.productName) : null,
      quantity: Number(r.values.quantity),
      unitPrice: typeof r.values.unitPrice === 'number' ? r.values.unitPrice : null,
      variant: r.values.variant ? String(r.values.variant) : null,
      externalLineId: r.values.externalLineId ? String(r.values.externalLineId) : null,
    })),
  };
  return n;
}

/** DB の注文から NormalizedOrder を再構成（差分検出用） */
export function normalizedFromOrder(o: any, items: any[]): NormalizedOrder {
  return {
    externalOrderId: o.external_order_id,
    orderDate: new Date(o.order_date).toISOString(),
    customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone, channelCustomerId: null },
    shipTo: {
      name: o.recipient_name,
      postalCode: o.postal_code,
      prefecture: o.prefecture,
      city: o.city,
      address1: o.address1,
      address2: o.address2,
      phone: o.recipient_phone,
    },
    shippingMethod: o.shipping_method,
    notes: o.notes,
    priority: o.priority,
    cancelFlag: false,
    lines: items.map((i) => ({
      sku: i.sku,
      productName: i.product_name || null,
      quantity: i.quantity,
      unitPrice: i.unit_price === null ? null : Number(i.unit_price),
      variant: i.variant,
      externalLineId: i.external_line_id,
    })),
  };
}

export function changedGroups(a: NormalizedOrder, b: NormalizedOrder): string[] {
  const groups: [string, (o: NormalizedOrder) => unknown][] = [
    ['注文日時', (o) => o.orderDate],
    ['購入者', (o) => [o.customer.name, o.customer.email, o.customer.phone]],
    ['送付先', (o) => o.shipTo],
    ['配送方法', (o) => o.shippingMethod],
    ['備考', (o) => o.notes],
    ['優先度', (o) => o.priority],
    ['明細', (o) => o.lines.map((l) => [l.sku, l.quantity, l.productName, l.unitPrice, l.variant])],
  ];
  return groups.filter(([, g]) => JSON.stringify(g(a)) !== JSON.stringify(g(b))).map(([name]) => name);
}

export async function previewImport(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  input: { profileId: string; filename: string; buffer: Buffer },
) {
  const profile = await tx.maybeOne(
    `SELECT p.*, c.name AS channel_name, c.active AS channel_active FROM import_profiles p
       JOIN sales_channels c ON c.organization_id = p.organization_id AND c.id = p.channel_id
      WHERE p.organization_id = $1 AND p.id = $2`,
    [tx.orgId, input.profileId],
  );
  if (!profile) throw notFound('Import Profile');
  if (!profile.active || !profile.channel_active) throw conflict('PROFILE_INACTIVE', 'このプロファイルまたはチャネルは無効です');

  const fileSha = sha256Hex(input.buffer);
  const dupFile = await tx.maybeOne(
    `SELECT id, batch_number, committed_at FROM import_batches WHERE organization_id = $1 AND file_sha256 = $2 AND status = 'committed'`,
    [tx.orgId, fileSha],
  );
  if (dupFile) {
    throw conflict('DUPLICATE_FILE', `このファイルは取込済みです（${dupFile.batch_number}）。同じファイルを二重に取り込むことはできません`, {
      batchId: dupFile.id,
    });
  }

  const { text } = decodeCsvBuffer(input.buffer, profile.encoding);
  const csv = parseCsvText(text, { delimiter: profile.delimiter, hasHeader: profile.has_header, skipRows: profile.skip_rows });
  const header = buildHeaderIndex(csv.header, csv.columnCount);
  const mapping = profile.mapping as Mapping;
  const colProblems = checkMappingColumns(mapping, header, profile.has_header);
  if (colProblems.length) {
    throw badRequest('MAPPING_COLUMNS_MISSING', 'CSV の列が Import Profile と一致しません（プロファイルかファイルを確認してください）', colProblems.map((m) => ({ message: m })));
  }

  // 行 → マッピング → 注文単位にグループ化
  const groups = new Map<string, { rows: MappedRow[]; lines: number[] }>();
  const orphanRows: { line: number; message: string }[] = [];
  csv.rows.forEach((row, i) => {
    const line = csv.lineNumbers[i]!;
    const mapped = mapRow(row, mapping, header, { dateFormat: profile.date_format, timeZone: profile.timezone });
    const ext = mapped.values.externalOrderId;
    if (!ext) {
      orphanRows.push({ line, message: mapped.issues.map((x) => x.message).join(' / ') || '注文番号がありません' });
      return;
    }
    const key = String(ext);
    const g = groups.get(key) ?? { rows: [], lines: [] };
    g.rows.push(mapped);
    g.lines.push(line);
    groups.set(key, g);
  });

  const allSkus = [...groups.values()].flatMap((g) => g.rows.map((r) => (r.values.sku ? String(r.values.sku) : ''))).filter(Boolean);
  const known = new Set((await loadProductsBySku(tx, allSkus)).keys());

  const staged: StagedOrder[] = [];
  let seq = 0;
  for (const [ext, g] of groups) {
    const errors: StagedOrder['errors'] = [];
    const warnings: StagedOrder['warnings'] = [];
    const push = (iss: FieldIssue, line: number) => {
      const entry = { line, field: TARGET_FIELDS[iss.field].label, message: iss.message };
      if (iss.severity === 'fatal') errors.push(entry);
      else if (iss.severity === 'warning') warnings.push(entry);
      else warnings.push({ ...entry, message: `要確認: ${iss.message}` });
    };
    g.rows.forEach((r, i) => {
      for (const iss of r.issues) {
        // 注文レベルの問題は 1 行目のみ報告（重複表示を避ける）
        if (i > 0 && TARGET_FIELDS[iss.field].level === 'order') continue;
        push(iss, g.lines[i]!);
      }
    });
    // 同一注文内で注文レベル項目が行ごとに異なる → どちらが正しいか決め打ちしない
    for (const field of ORDER_LEVEL_FIELDS) {
      const vals = new Set(g.rows.map((r) => valueKey(r.values[field])));
      if (vals.size > 1) {
        errors.push({ field: TARGET_FIELDS[field].label, message: `同じ注文の行で「${TARGET_FIELDS[field].label}」が異なります（行 ${g.lines.join(', ')}）` });
      }
    }
    let normalized: NormalizedOrder | null = null;
    let classification: Classification = 'new';
    if (errors.length === 0) {
      const candidate = buildNormalized(g.rows);
      const parsed = NormalizedOrderSchema.safeParse(candidate);
      if (!parsed.success) {
        errors.push(...parsed.error.issues.map((x) => ({ message: `${x.path.join('.')}: ${x.message}` })));
      } else {
        normalized = parsed.data;
      }
    }
    if (errors.length) classification = 'invalid';
    let validationIssues: ValidationIssue[] = [];
    if (normalized) {
      validationIssues = validateForFulfillment(normalized, known);
      if (validationIssues.length && profile.invalid_policy === 'skip' && !normalized.cancelFlag) {
        classification = 'invalid';
        errors.push(...validationIssues.map((v) => ({ message: v.message })));
      } else {
        for (const v of validationIssues) {
          if (!warnings.some((w) => w.message.includes(v.message))) warnings.push({ message: `要確認: ${v.message}` });
        }
      }
    }
    staged.push({
      seq: seq++,
      externalOrderId: ext,
      classification,
      existingOrderId: null,
      contentHash: normalized ? orderContentHash(normalized) : null,
      normalized,
      errors,
      warnings,
      rowNumbers: g.lines,
    });
  }

  // 既存注文との比較
  const exts = staged.map((s) => s.externalOrderId);
  const existing = exts.length
    ? await tx.many(
        `SELECT o.*, (SELECT COALESCE(SUM(allocated_qty + shipped_qty), 0)::int FROM order_items i WHERE i.organization_id = o.organization_id AND i.order_id = o.id) AS progressed
           FROM orders o WHERE o.organization_id = $1 AND o.channel_id = $2 AND o.external_order_id = ANY($3)`,
        [tx.orgId, profile.channel_id, exts],
      )
    : [];
  const byExt = new Map(existing.map((e) => [e.external_order_id as string, e]));
  const itemsByOrder = new Map<string, any[]>();
  if (existing.length) {
    const items = await tx.many(`SELECT * FROM order_items WHERE organization_id = $1 AND order_id = ANY($2) ORDER BY line_no`, [
      tx.orgId,
      existing.map((e) => e.id),
    ]);
    for (const it of items) itemsByOrder.set(it.order_id, [...(itemsByOrder.get(it.order_id) ?? []), it]);
  }
  for (const s of staged) {
    if (s.classification === 'invalid' || !s.normalized) continue;
    const ex = byExt.get(s.externalOrderId);
    if (s.normalized.cancelFlag) {
      s.classification = 'cancel_candidate';
      s.existingOrderId = ex?.id ?? null;
      continue;
    }
    if (!ex) continue;
    s.existingOrderId = ex.id;
    if (ex.content_hash === s.contentHash) {
      s.classification = 'identical';
      continue;
    }
    s.changed = changedGroups(normalizedFromOrder(ex, itemsByOrder.get(ex.id) ?? []), s.normalized);
    s.classification = UPDATABLE_STATUSES.has(ex.status) && ex.progressed === 0 && !ex.cancelled_at ? 'update_candidate' : 'conflict';
  }

  const byClass: Record<Classification, number> = { new: 0, identical: 0, update_candidate: 0, conflict: 0, cancel_candidate: 0, invalid: 0 };
  for (const s of staged) byClass[s.classification]++;
  const importable = staged.filter((s) => s.classification === 'new');
  const summary = {
    rows: csv.rows.length,
    orders: staged.length,
    byClass,
    orphanRows: orphanRows.slice(0, 100),
    orphanRowCount: orphanRows.length,
    newOrders: importable.length,
    newLines: importable.reduce((n, s) => n + (s.normalized?.lines.length ?? 0), 0),
    newQty: importable.reduce((n, s) => n + (s.normalized?.lines.reduce((q, l) => q + l.quantity, 0) ?? 0), 0),
    newWithValidationIssues: importable.filter((s) => s.warnings.some((w) => w.message.startsWith('要確認'))).length,
  };

  const [batchNumber] = await nextNumbers(deps.numberingPool, tx.orgId, 'import_batch', 1);
  const batchId = uuidv7();
  await tx.exec(
    `INSERT INTO import_batches (organization_id, id, batch_number, channel_id, profile_id, profile_snapshot, filename, file_sha256, file_size,
                                 encoding, status, row_count, order_count, line_count, total_qty, summary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'previewed', $11, $12, $13, $14, $15, $16)`,
    [
      tx.orgId,
      batchId,
      batchNumber,
      profile.channel_id,
      profile.id,
      JSON.stringify({ id: profile.id, name: profile.name, version: profile.version, mapping: profile.mapping, dateFormat: profile.date_format, timezone: profile.timezone, encoding: profile.encoding }),
      input.filename,
      fileSha,
      input.buffer.length,
      profile.encoding,
      csv.rows.length,
      staged.length,
      summary.newLines,
      summary.newQty,
      JSON.stringify(summary),
      tx.actor.userId,
    ],
  );
  if (staged.length) {
    const col = <K extends keyof StagedOrder>(k: K) => staged.map((s) => s[k]);
    await tx.exec(
      `INSERT INTO import_batch_orders (organization_id, id, batch_id, seq, external_order_id, classification, existing_order_id, content_hash,
                                        normalized, errors, warnings, row_numbers)
       SELECT $1, u.id, $2, u.seq, u.ext, u.cls, u.existing, u.hash, u.norm::jsonb, u.errors::jsonb, u.warnings::jsonb,
              ARRAY(SELECT jsonb_array_elements_text(u.rows::jsonb)::int)
         FROM unnest($3::uuid[], $4::int[], $5::text[], $6::text[], $7::uuid[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
              AS u(id, seq, ext, cls, existing, hash, norm, errors, warnings, rows)`,
      [
        tx.orgId,
        batchId,
        staged.map(() => uuidv7()),
        col('seq'),
        col('externalOrderId'),
        col('classification'),
        col('existingOrderId'),
        col('contentHash'),
        staged.map((s) => (s.normalized ? JSON.stringify({ ...s.normalized, changed: s.changed ?? [] }) : null)),
        staged.map((s) => JSON.stringify(s.errors)),
        staged.map((s) => JSON.stringify(s.warnings)),
        staged.map((s) => JSON.stringify(s.rowNumbers)),
      ],
    );
  }
  await audit(tx, {
    action: 'import.preview',
    entityType: 'import_batch',
    entityId: batchId,
    summary: `${batchNumber} プレビュー（${staged.length}件）`,
    metadata: { byClass, rows: csv.rows.length, filename: input.filename },
  });
  return { batchId, batchNumber, summary };
}

export interface CommitResult {
  alreadyCommitted: boolean;
  created: number;
  createdValidationRequired: number;
  updated: number;
  skippedIdentical: number;
  skippedUpdateNotApplied: number;
  conflicts: number;
  cancelCandidates: number;
  invalidSkipped: number;
  cancelledInSourceSkipped: number;
  createdOrderIds: string[];
}

export async function commitImport(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  batchId: string,
  opts: { applyUpdateIds?: string[] } = {},
): Promise<CommitResult> {
  const b = await tx.maybeOne(`SELECT * FROM import_batches WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, batchId]);
  if (!b) throw notFound('取込バッチ');
  if (b.status === 'committed') return { ...(b.summary.commit as CommitResult), alreadyCommitted: true };
  if (b.status !== 'previewed') throw conflict('BATCH_NOT_PREVIEWED', `この取込は確定できません（状態: ${b.status}）`);
  if (Date.now() - new Date(b.created_at).getTime() > 24 * 3600 * 1000) {
    throw conflict('BATCH_EXPIRED', 'プレビューから24時間以上経過しています。もう一度プレビューしてください');
  }
  // 同一チャネルの確定処理を直列化（同時取込による重複・競合を防ぐ）
  await tx.exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`import:${tx.orgId}:${b.channel_id}`]);
  const dupFile = await tx.maybeOne(
    `SELECT batch_number FROM import_batches WHERE organization_id = $1 AND file_sha256 = $2 AND status = 'committed' AND id <> $3`,
    [tx.orgId, b.file_sha256, batchId],
  );
  if (dupFile) throw conflict('DUPLICATE_FILE', `このファイルは別の取込（${dupFile.batch_number}）で確定済みです`);

  const rows = await tx.many(`SELECT * FROM import_batch_orders WHERE organization_id = $1 AND batch_id = $2 ORDER BY seq`, [tx.orgId, batchId]);
  const apply = new Set(opts.applyUpdateIds ?? []);
  const exts = rows.map((r) => r.external_order_id);
  const existing = exts.length
    ? await tx.many(
        `SELECT o.*, (SELECT COALESCE(SUM(allocated_qty + shipped_qty), 0)::int FROM order_items i WHERE i.organization_id = o.organization_id AND i.order_id = o.id) AS progressed
           FROM orders o WHERE o.organization_id = $1 AND o.channel_id = $2 AND o.external_order_id = ANY($3) FOR UPDATE OF o`,
        [tx.orgId, b.channel_id, exts],
      )
    : [];
  const byExt = new Map(existing.map((e) => [e.external_order_id as string, e]));

  const result: CommitResult = {
    alreadyCommitted: false,
    created: 0,
    createdValidationRequired: 0,
    updated: 0,
    skippedIdentical: 0,
    skippedUpdateNotApplied: 0,
    conflicts: 0,
    cancelCandidates: 0,
    invalidSkipped: 0,
    cancelledInSourceSkipped: 0,
    createdOrderIds: [],
  };
  const rowResult = new Map<string, { result: string; orderId: string | null }>();
  const toCreate: { row: any; n: NormalizedOrder }[] = [];

  for (const r of rows) {
    if (r.classification === 'invalid' || !r.normalized) {
      result.invalidSkipped++;
      rowResult.set(r.id, { result: 'invalid_skipped', orderId: null });
      continue;
    }
    const { changed: _changed, ...rest } = r.normalized;
    void _changed;
    const n = NormalizedOrderSchema.parse(rest);
    const ex = byExt.get(r.external_order_id);
    if (n.cancelFlag) {
      if (ex && !ex.cancelled_at) {
        await createException(tx, deps, {
          type: 'import_conflict',
          title: `取消候補: ${ex.order_number}（取込データでキャンセル）`,
          severity: 'high',
          dedupeKey: `import_cancel:${ex.id}`,
          orderId: ex.id,
          importBatchId: batchId,
          detail: { kind: 'cancel_candidate', batchNumber: b.batch_number, externalOrderId: r.external_order_id, orderStatus: ex.status },
        });
        result.cancelCandidates++;
        rowResult.set(r.id, { result: 'cancel_candidate_exception', orderId: ex.id });
      } else {
        result.cancelledInSourceSkipped++;
        rowResult.set(r.id, { result: 'cancelled_in_source_skipped', orderId: ex?.id ?? null });
      }
      continue;
    }
    if (!ex) {
      toCreate.push({ row: r, n });
      continue;
    }
    const hash = orderContentHash({ ...n, shipTo: splitPrefecture(n.shipTo) });
    if (ex.content_hash === hash) {
      result.skippedIdentical++;
      rowResult.set(r.id, { result: 'identical_skipped', orderId: ex.id });
      continue;
    }
    const updatable = UPDATABLE_STATUSES.has(ex.status) && ex.progressed === 0 && !ex.cancelled_at;
    if (updatable) {
      if (!apply.has(r.id)) {
        result.skippedUpdateNotApplied++;
        rowResult.set(r.id, { result: 'update_not_applied', orderId: ex.id });
        continue;
      }
      await applyOrderUpdate(tx, ex, n, hash, b.batch_number);
      result.updated++;
      rowResult.set(r.id, { result: 'updated', orderId: ex.id });
      continue;
    }
    const items = await tx.many(`SELECT * FROM order_items WHERE organization_id = $1 AND order_id = $2 ORDER BY line_no`, [tx.orgId, ex.id]);
    await createException(tx, deps, {
      type: 'import_conflict',
      title: `取込競合: ${ex.order_number}（作業中の注文と内容が異なります）`,
      severity: 'high',
      dedupeKey: `import_conflict:${ex.id}`,
      orderId: ex.id,
      importBatchId: batchId,
      detail: {
        kind: 'conflict',
        batchNumber: b.batch_number,
        externalOrderId: r.external_order_id,
        orderStatus: ex.status,
        changed: changedGroups(normalizedFromOrder(ex, items), n),
      },
    });
    result.conflicts++;
    rowResult.set(r.id, { result: 'conflict_exception', orderId: ex.id });
  }

  const created = await createOrders(
    tx,
    deps,
    toCreate.map(({ n }) => ({ normalized: n, channelId: b.channel_id, importBatchId: batchId })),
  );
  created.forEach((c, i) => {
    rowResult.set(toCreate[i]!.row.id, { result: 'created', orderId: c.id });
    result.createdOrderIds.push(c.id);
    if (c.status === 'validation_required') result.createdValidationRequired++;
  });
  result.created = created.length;

  if (rowResult.size) {
    const ids = [...rowResult.keys()];
    await tx.exec(
      `UPDATE import_batch_orders b SET result = u.result, result_order_id = u.order_id
         FROM unnest($2::uuid[], $3::text[], $4::uuid[]) AS u(id, result, order_id)
        WHERE b.organization_id = $1 AND b.id = u.id`,
      [tx.orgId, ids, ids.map((id) => rowResult.get(id)!.result), ids.map((id) => rowResult.get(id)!.orderId)],
    );
  }
  const { createdOrderIds: _ids, ...forSummary } = result;
  void _ids;
  await tx.exec(
    `UPDATE import_batches SET status = 'committed', committed_by = $3, committed_at = now(), summary = summary || $4::jsonb
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, batchId, tx.actor.userId, JSON.stringify({ commit: forSummary })],
  );
  await audit(tx, {
    action: 'import.commit',
    entityType: 'import_batch',
    entityId: batchId,
    summary: `${b.batch_number} 確定: 新規${result.created} 更新${result.updated} 競合${result.conflicts}`,
    metadata: forSummary,
  });
  return result;
}

/** 取込データで注文を更新（引当前の注文のみ）。住所変更は履歴に残す */
async function applyOrderUpdate(tx: Tx, ex: any, n: NormalizedOrder, hash: string, batchNumber: string) {
  const shipTo = splitPrefecture(n.shipTo);
  const oldAddr = {
    name: ex.recipient_name,
    postalCode: ex.postal_code,
    prefecture: ex.prefecture,
    city: ex.city,
    address1: ex.address1,
    address2: ex.address2,
    phone: ex.recipient_phone,
  };
  if (JSON.stringify(oldAddr) !== JSON.stringify(shipTo)) {
    await tx.exec(
      `INSERT INTO order_address_history (organization_id, id, order_id, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tx.orgId, uuidv7(), ex.id, JSON.stringify(oldAddr), JSON.stringify(shipTo), `取込更新（${batchNumber}）`, tx.actor.userId],
    );
  }
  await tx.exec(
    `UPDATE orders SET order_date = $3, customer_name = $4, customer_email = $5, customer_phone = $6, recipient_name = $7, postal_code = $8,
            prefecture = $9, city = $10, address1 = $11, address2 = $12, recipient_phone = $13, shipping_method = $14, notes = $15,
            priority = $16, content_hash = $17, total_qty = $18, updated_at = now(), version = version + 1
      WHERE organization_id = $1 AND id = $2`,
    [
      tx.orgId,
      ex.id,
      n.orderDate,
      n.customer.name ?? null,
      n.customer.email ?? null,
      n.customer.phone ?? null,
      shipTo.name ?? null,
      shipTo.postalCode ?? null,
      shipTo.prefecture ?? null,
      shipTo.city ?? null,
      shipTo.address1 ?? null,
      shipTo.address2 ?? null,
      shipTo.phone ?? null,
      n.shippingMethod ?? null,
      n.notes ?? null,
      n.priority ?? 0,
      hash,
      n.lines.reduce((s, l) => s + l.quantity, 0),
    ],
  );
  // 明細を置き換え（引当・出荷が一切ないことを確認済み）
  await tx.exec(`DELETE FROM order_items WHERE organization_id = $1 AND order_id = $2`, [tx.orgId, ex.id]);
  const products = await loadProductsBySku(tx, n.lines.map((l) => l.sku));
  for (const [i, l] of n.lines.entries()) {
    const p = products.get(l.sku);
    await tx.exec(
      `INSERT INTO order_items (organization_id, id, order_id, line_no, external_line_id, sku, product_id, product_name, variant, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tx.orgId, uuidv7(), ex.id, i + 1, l.externalLineId ?? null, l.sku, p?.id ?? null, l.productName ?? p?.name ?? '', l.variant ?? p?.variant ?? null, l.quantity, l.unitPrice ?? null],
    );
  }
  await revalidateOrderRow(tx, ex.id);
  await recomputeOrderStatus(tx, ex.id, `取込更新（${batchNumber}）`);
  await audit(tx, { action: 'order.import_update', entityType: 'order', entityId: ex.id, summary: `${ex.order_number} を取込データで更新（${batchNumber}）` });
}

export async function cancelImport(tx: Tx, batchId: string) {
  const b = await tx.maybeOne(`SELECT * FROM import_batches WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, batchId]);
  if (!b) throw notFound('取込バッチ');
  if (b.status !== 'previewed') throw new AppError(409, 'BATCH_NOT_PREVIEWED', `この取込は取消できません（状態: ${b.status}）`);
  await tx.exec(`UPDATE import_batches SET status = 'cancelled' WHERE organization_id = $1 AND id = $2`, [tx.orgId, batchId]);
  await tx.exec(`UPDATE import_batch_orders SET normalized = NULL WHERE organization_id = $1 AND batch_id = $2`, [tx.orgId, batchId]);
  await audit(tx, { action: 'import.cancel', entityType: 'import_batch', entityId: batchId, summary: `${b.batch_number} を取消` });
}
