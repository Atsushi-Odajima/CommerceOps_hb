import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { nextNumbers } from '../../lib/numbering.js';
import { uuidv7 } from '../../lib/uuid.js';
import { audit } from '../audit/audit.js';
import {
  orderContentHash,
  splitPrefecture,
  validateForFulfillment,
  type Address,
  type NormalizedOrder,
  type ValidationIssue,
} from './normalized.js';
import { recomputeOrderStatus, type OrderStatus } from './status.js';

export interface NewOrderInput {
  normalized: NormalizedOrder;
  channelId: string;
  importBatchId?: string | null;
  orderType?: 'standard' | 'replacement';
  sourceOrderId?: string | null;
  exchangeId?: string | null;
  /** 既に払い出した番号（省略時は払い出す） */
  orderNumber?: string;
}

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  externalOrderId: string;
  status: OrderStatus;
  validationErrors: ValidationIssue[];
}

/** SKU → product の辞書（組織内） */
export async function loadProductsBySku(tx: Tx, skus: string[]): Promise<Map<string, { id: string; name: string; variant: string | null }>> {
  const uniq = [...new Set(skus)];
  if (!uniq.length) return new Map();
  const rows = await tx.many(`SELECT id, sku, name, variant FROM products WHERE organization_id = $1 AND sku = ANY($2)`, [tx.orgId, uniq]);
  return new Map(rows.map((r) => [r.sku, { id: r.id, name: r.name, variant: r.variant }]));
}

/** 顧客マスターの取得/作成（既存は上書きしない = マスター編集を尊重）。メール → チャネル顧客ID の順で照合 */
async function resolveCustomers(tx: Tx, channelId: string, orders: NormalizedOrder[]): Promise<(string | null)[]> {
  const emails = [...new Set(orders.map((o) => o.customer.email?.toLowerCase()).filter((e): e is string => !!e))];
  const extIds = [...new Set(orders.map((o) => o.customer.channelCustomerId).filter((e): e is string => !!e))];
  const existing = emails.length || extIds.length
    ? await tx.many(
        `SELECT id, lower(email) AS email, external_customer_id FROM customers
          WHERE organization_id = $1 AND channel_id = $2 AND (lower(email) = ANY($3) OR external_customer_id = ANY($4))`,
        [tx.orgId, channelId, emails, extIds],
      )
    : [];
  const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email as string, c.id as string]));
  const byExt = new Map(existing.filter((c) => c.external_customer_id).map((c) => [c.external_customer_id as string, c.id as string]));
  const result: (string | null)[] = [];
  const inserts: unknown[][] = [];
  for (const o of orders) {
    const email = o.customer.email?.toLowerCase() ?? null;
    const ext = o.customer.channelCustomerId ?? null;
    let id = (email && byEmail.get(email)) || (ext && byExt.get(ext)) || null;
    if (!id && (email || ext)) {
      id = uuidv7();
      if (email) byEmail.set(email, id);
      if (ext) byExt.set(ext, id);
      inserts.push([
        id,
        ext,
        o.customer.name ?? o.shipTo.name ?? null,
        o.customer.email ?? null,
        o.customer.phone ?? null,
        o.shipTo.postalCode ?? null,
        o.shipTo.prefecture ?? null,
        o.shipTo.city ?? null,
        o.shipTo.address1 ?? null,
        o.shipTo.address2 ?? null,
      ]);
    }
    result.push(id);
  }
  if (inserts.length) {
    const col = (i: number) => inserts.map((r) => r[i]);
    await tx.exec(
      `INSERT INTO customers (organization_id, id, channel_id, external_customer_id, name, email, phone, postal_code, prefecture, city, address1, address2)
       SELECT $1, u.id, $2, u.ext, u.name, u.email, u.phone, u.zip, u.pref, u.city, u.a1, u.a2
         FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
              AS u(id, ext, name, email, phone, zip, pref, city, a1, a2)`,
      [tx.orgId, channelId, col(0), col(1), col(2), col(3), col(4), col(5), col(6), col(7), col(8), col(9)],
    );
  }
  return result;
}

/**
 * 注文の一括作成（CSV 取込・手動作成・交換品で共通）。
 * 状態は imported で作成し、検証結果に応じて validation_required / ready_for_allocation へ（履歴 2 行）。
 */
export async function createOrders(tx: Tx, deps: Pick<AppDeps, 'numberingPool'>, inputs: NewOrderInput[]): Promise<CreatedOrder[]> {
  if (!inputs.length) return [];
  const numbers = await nextNumbers(deps.numberingPool, tx.orgId, 'order', inputs.filter((i) => !i.orderNumber).length);
  let ni = 0;
  const products = await loadProductsBySku(tx, inputs.flatMap((i) => i.normalized.lines.map((l) => l.sku)));
  const knownSkus = new Set(products.keys());

  // チャネルごとに顧客を解決
  const customerIds: (string | null)[] = new Array(inputs.length).fill(null);
  const byChannel = new Map<string, number[]>();
  inputs.forEach((inp, idx) => byChannel.set(inp.channelId, [...(byChannel.get(inp.channelId) ?? []), idx]));
  for (const [channelId, idxs] of byChannel) {
    const ids = await resolveCustomers(tx, channelId, idxs.map((i) => inputs[i]!.normalized));
    idxs.forEach((orderIdx, k) => (customerIds[orderIdx] = ids[k]!));
  }

  const created: CreatedOrder[] = [];
  const o: Record<string, unknown[]> = {
    id: [], number: [], channel: [], ext: [], type: [], source: [], exchange: [], date: [], status: [], customer: [], cname: [], cemail: [],
    cphone: [], rname: [], zip: [], pref: [], city: [], a1: [], a2: [], rphone: [], method: [], notes: [], priority: [], batch: [], hash: [],
    verr: [], total: [],
  };
  const it: Record<string, unknown[]> = { id: [], order: [], line: [], ext: [], sku: [], product: [], name: [], variant: [], qty: [], price: [] };
  const hist: Record<string, unknown[]> = { id: [], order: [], from: [], to: [], reason: [] };

  inputs.forEach((inp, idx) => {
    const n = inp.normalized;
    const shipTo = splitPrefecture(n.shipTo);
    const norm: NormalizedOrder = { ...n, shipTo };
    const verr = validateForFulfillment(norm, knownSkus);
    const status: OrderStatus = verr.length ? 'validation_required' : 'ready_for_allocation';
    const id = uuidv7();
    const orderNumber = inp.orderNumber ?? numbers[ni++]!;
    o.id!.push(id);
    o.number!.push(orderNumber);
    o.channel!.push(inp.channelId);
    o.ext!.push(n.externalOrderId);
    o.type!.push(inp.orderType ?? 'standard');
    o.source!.push(inp.sourceOrderId ?? null);
    o.exchange!.push(inp.exchangeId ?? null);
    o.date!.push(n.orderDate);
    o.status!.push(status);
    o.customer!.push(customerIds[idx]);
    o.cname!.push(n.customer.name ?? null);
    o.cemail!.push(n.customer.email ?? null);
    o.cphone!.push(n.customer.phone ?? null);
    o.rname!.push(shipTo.name ?? null);
    o.zip!.push(shipTo.postalCode ?? null);
    o.pref!.push(shipTo.prefecture ?? null);
    o.city!.push(shipTo.city ?? null);
    o.a1!.push(shipTo.address1 ?? null);
    o.a2!.push(shipTo.address2 ?? null);
    o.rphone!.push(shipTo.phone ?? null);
    o.method!.push(n.shippingMethod ?? null);
    o.notes!.push(n.notes ?? null);
    o.priority!.push(n.priority ?? 0);
    o.batch!.push(inp.importBatchId ?? null);
    o.hash!.push(orderContentHash(norm));
    o.verr!.push(JSON.stringify(verr));
    o.total!.push(n.lines.reduce((s, l) => s + l.quantity, 0));
    n.lines.forEach((l, li) => {
      const p = products.get(l.sku);
      it.id!.push(uuidv7());
      it.order!.push(id);
      it.line!.push(li + 1);
      it.ext!.push(l.externalLineId ?? null);
      it.sku!.push(l.sku);
      it.product!.push(p?.id ?? null);
      it.name!.push(l.productName ?? p?.name ?? '');
      it.variant!.push(l.variant ?? p?.variant ?? null);
      it.qty!.push(l.quantity);
      it.price!.push(l.unitPrice ?? null);
    });
    hist.id!.push(uuidv7(), uuidv7());
    hist.order!.push(id, id);
    hist.from!.push(null, 'imported');
    hist.to!.push('imported', status);
    hist.reason!.push(inp.importBatchId ? 'CSV取込' : inp.orderType === 'replacement' ? '交換品' : '手動作成', verr.length ? '検証エラーあり' : '検証OK');
    created.push({ id, orderNumber, externalOrderId: n.externalOrderId, status, validationErrors: verr });
  });

  await tx.exec(
    `INSERT INTO orders (organization_id, id, order_number, channel_id, external_order_id, order_type, source_order_id, exchange_id,
                         order_date, status, customer_id, customer_name, customer_email, customer_phone, recipient_name, postal_code,
                         prefecture, city, address1, address2, recipient_phone, shipping_method, notes, priority, import_batch_id,
                         content_hash, validation_errors, total_qty, created_by)
     SELECT $1, u.id, u.number, u.channel, u.ext, u.type, u.source, u.exchange, u.date, u.status, u.customer, u.cname, u.cemail,
            u.cphone, u.rname, u.zip, u.pref, u.city, u.a1, u.a2, u.rphone, u.method, u.notes, u.priority, u.batch, u.hash,
            u.verr::jsonb, u.total, $29
       FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::uuid[], $8::uuid[], $9::timestamptz[], $10::text[],
                   $11::uuid[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[],
                   $20::text[], $21::text[], $22::text[], $23::text[], $24::int[], $25::uuid[], $26::text[], $27::text[], $28::int[])
            AS u(id, number, channel, ext, type, source, exchange, date, status, customer, cname, cemail, cphone, rname, zip, pref,
                 city, a1, a2, rphone, method, notes, priority, batch, hash, verr, total)`,
    [
      tx.orgId, o.id, o.number, o.channel, o.ext, o.type, o.source, o.exchange, o.date, o.status, o.customer, o.cname, o.cemail, o.cphone,
      o.rname, o.zip, o.pref, o.city, o.a1, o.a2, o.rphone, o.method, o.notes, o.priority, o.batch, o.hash, o.verr, o.total, tx.actor.userId,
    ],
  );
  await tx.exec(
    `INSERT INTO order_items (organization_id, id, order_id, line_no, external_line_id, sku, product_id, product_name, variant, quantity, unit_price)
     SELECT $1, u.id, u.order_id, u.line_no, u.ext, u.sku, u.product, u.name, u.variant, u.qty, u.price
       FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::text[], $6::text[], $7::uuid[], $8::text[], $9::text[], $10::int[], $11::numeric[])
            AS u(id, order_id, line_no, ext, sku, product, name, variant, qty, price)`,
    [tx.orgId, it.id, it.order, it.line, it.ext, it.sku, it.product, it.name, it.variant, it.qty, it.price],
  );
  await tx.exec(
    `INSERT INTO order_status_history (organization_id, id, order_id, from_status, to_status, reason, actor_user_id, created_at)
     SELECT $1, u.id, u.order_id, u.from_status, u.to_status, u.reason, $7, now() + (u.ord * interval '1 microsecond')
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[]) WITH ORDINALITY AS u(id, order_id, from_status, to_status, reason, ord)`,
    [tx.orgId, hist.id, hist.order, hist.from, hist.to, hist.reason, tx.actor.userId],
  );
  return created;
}

// ---------------- holds ----------------
export const HOLD_REASONS = ['address_check', 'stock_shortage', 'customer_confirm', 'payment_check', 'fraud_check', 'other'] as const;

export async function placeHold(
  tx: Tx,
  orderId: string,
  input: { reasonCode: (typeof HOLD_REASONS)[number]; note?: string | null; confirm?: boolean },
) {
  const facts = await tx.maybeOne(`SELECT id, order_number, status FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  if (!facts) throw notFound('注文');
  if (['cancelled', 'closed', 'shipped'].includes(facts.status)) {
    throw conflict('HOLD_NOT_ALLOWED', `この状態（${facts.status}）の注文は保留にできません`);
  }
  if (input.reasonCode === 'other' && !input.note?.trim()) throw new AppError(400, 'NOTE_REQUIRED', '「その他」の場合はメモを入力してください');
  const inProgress = await tx.one(
    `SELECT count(*)::int AS n FROM fulfillments WHERE organization_id = $1 AND order_id = $2 AND status IN ('waved', 'picking', 'picked', 'packing', 'packed')`,
    [tx.orgId, orderId],
  );
  if (inProgress.n > 0 && !input.confirm) {
    throw new AppError(409, 'CONFIRM_REQUIRED', 'ピッキング・梱包中の作業があります。保留にすると梱包・出荷が止まります。よろしければ確認して再実行してください', {
      inProgress: inProgress.n,
    });
  }
  const active = await tx.maybeOne(`SELECT id FROM holds WHERE organization_id = $1 AND order_id = $2 AND released_at IS NULL`, [tx.orgId, orderId]);
  const holdId = uuidv7();
  await tx.exec(
    `INSERT INTO holds (organization_id, id, order_id, reason_code, note, placed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tx.orgId, holdId, orderId, input.reasonCode, input.note?.trim() || null, tx.actor.userId],
  );
  await tx.exec(
    `UPDATE fulfillments SET on_hold = true, hold_reason = $3, updated_at = now()
      WHERE organization_id = $1 AND order_id = $2 AND status NOT IN ('shipped', 'cancelled')`,
    [tx.orgId, orderId, input.reasonCode],
  );
  const st = await recomputeOrderStatus(tx, orderId, `保留: ${input.reasonCode}`);
  await audit(tx, {
    action: 'order.hold',
    entityType: 'order',
    entityId: orderId,
    summary: `${facts.order_number} を保留（${input.reasonCode}）`,
    metadata: { reasonCode: input.reasonCode, alreadyHeld: !!active },
  });
  return { holdId, status: st.to };
}

export async function releaseHold(tx: Tx, orderId: string, holdId: string, note?: string | null) {
  const h = await tx.maybeOne(
    `SELECT h.*, o.order_number FROM holds h JOIN orders o ON o.organization_id = h.organization_id AND o.id = h.order_id
      WHERE h.organization_id = $1 AND h.id = $2 AND h.order_id = $3 FOR UPDATE OF h`,
    [tx.orgId, holdId, orderId],
  );
  if (!h) throw notFound('保留');
  if (h.released_at) return { released: false };
  await tx.exec(`SELECT id FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  await tx.exec(`UPDATE holds SET released_at = now(), released_by = $3, release_note = $4 WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    holdId,
    tx.actor.userId,
    note?.trim() || null,
  ]);
  const remaining = await tx.one(`SELECT count(*)::int AS n FROM holds WHERE organization_id = $1 AND order_id = $2 AND released_at IS NULL`, [
    tx.orgId,
    orderId,
  ]);
  if (remaining.n === 0) {
    await tx.exec(
      `UPDATE fulfillments SET on_hold = false, hold_reason = NULL, updated_at = now()
        WHERE organization_id = $1 AND order_id = $2 AND status NOT IN ('shipped', 'cancelled')`,
      [tx.orgId, orderId],
    );
  }
  const st = await recomputeOrderStatus(tx, orderId, '保留解除');
  await audit(tx, { action: 'order.hold_release', entityType: 'order', entityId: orderId, summary: `${h.order_number} の保留を解除`, metadata: { holdId } });
  return { released: true, status: st.to };
}

// ---------------- address / meta ----------------
export async function changeShippingAddress(tx: Tx, orderId: string, addr: Address, reason: string) {
  const o = await tx.maybeOne(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  if (!o) throw notFound('注文');
  if (['cancelled', 'closed'].includes(o.status)) throw conflict('ADDRESS_LOCKED', 'この注文の住所は変更できません');
  const shipped = await tx.one(`SELECT count(*)::int AS n FROM shipments WHERE organization_id = $1 AND order_id = $2 AND status = 'shipped'`, [
    tx.orgId,
    orderId,
  ]);
  if (shipped.n > 0) throw conflict('ALREADY_SHIPPED', '出荷済みの荷物がある注文の住所は変更できません（出荷前のみ変更可）');
  const a = splitPrefecture(addr);
  if (!a.name || !a.postalCode || !a.address1) throw new AppError(400, 'ADDRESS_INCOMPLETE', '氏名・郵便番号・住所は必須です');
  const digits = a.postalCode.normalize('NFKC').replace(/[^0-9]/g, '');
  if (digits.length !== 7) throw new AppError(400, 'POSTAL_INVALID', '郵便番号は7桁で入力してください');
  const postal = `${digits.slice(0, 3)}-${digits.slice(3)}`;
  const oldValue = {
    name: o.recipient_name,
    postalCode: o.postal_code,
    prefecture: o.prefecture,
    city: o.city,
    address1: o.address1,
    address2: o.address2,
    phone: o.recipient_phone,
  };
  const newValue = { ...a, postalCode: postal };
  await tx.exec(
    `INSERT INTO order_address_history (organization_id, id, order_id, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tx.orgId, uuidv7(), orderId, JSON.stringify(oldValue), JSON.stringify(newValue), reason, tx.actor.userId],
  );
  // 住所系の検証エラーを除去（未登録 SKU などは残す）
  const verr = (o.validation_errors as ValidationIssue[]).filter(
    (e) => !['SHIP_TO_NAME_MISSING', 'POSTAL_MISSING', 'POSTAL_INVALID', 'ADDRESS_MISSING'].includes(e.code),
  );
  await tx.exec(
    `UPDATE orders SET recipient_name = $3, postal_code = $4, prefecture = $5, city = $6, address1 = $7, address2 = $8, recipient_phone = $9,
            validation_errors = $10, updated_at = now(), version = version + 1
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, orderId, a.name, postal, a.prefecture ?? null, a.city ?? null, a.address1, a.address2 ?? null, a.phone ?? null, JSON.stringify(verr)],
  );
  // 未出荷の下書き荷物の送付先も最新にする（出荷確定時にも再度スナップショットする）
  await tx.exec(
    `UPDATE shipments SET ship_to = $3, updated_at = now() WHERE organization_id = $1 AND order_id = $2 AND status = 'draft'`,
    [tx.orgId, orderId, JSON.stringify({ ...newValue, phone: a.phone ?? null })],
  );
  const packed = await tx.one(
    `SELECT count(*)::int AS n FROM fulfillments WHERE organization_id = $1 AND order_id = $2 AND status IN ('packing', 'packed')`,
    [tx.orgId, orderId],
  );
  const st = await recomputeOrderStatus(tx, orderId, '住所変更');
  await audit(tx, { action: 'order.address_change', entityType: 'order', entityId: orderId, summary: `${o.order_number} の送付先を変更`, metadata: { reasonLength: reason.length } });
  return { status: st.to, warning: packed.n > 0 ? '梱包中/梱包済みの荷物があります。納品書・送り状を作り直してください。' : null };
}

/** 未登録 SKU の明細を既存商品に対応付ける（引当前のみ）。SKU 原文は保持し、対応付けは監査ログに残す */
export async function remapOrderItem(tx: Tx, orderId: string, itemId: string, productId: string) {
  const o = await tx.maybeOne(`SELECT id, order_number, status, validation_errors FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [
    tx.orgId,
    orderId,
  ]);
  if (!o) throw notFound('注文');
  const item = await tx.maybeOne(`SELECT * FROM order_items WHERE organization_id = $1 AND id = $2 AND order_id = $3`, [tx.orgId, itemId, orderId]);
  if (!item) throw notFound('明細');
  if (item.allocated_qty > 0 || item.shipped_qty > 0) throw conflict('ITEM_IN_USE', '引当・出荷済みの明細は変更できません');
  const p = await tx.maybeOne(`SELECT id, sku, name, variant FROM products WHERE organization_id = $1 AND id = $2`, [tx.orgId, productId]);
  if (!p) throw notFound('商品');
  await tx.exec(
    `UPDATE order_items SET product_id = $3, product_name = CASE WHEN product_name = '' THEN $4 ELSE product_name END, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [tx.orgId, itemId, p.id, p.name],
  );
  await revalidateOrderRow(tx, orderId);
  await audit(tx, {
    action: 'order.item_remap',
    entityType: 'order',
    entityId: orderId,
    summary: `${o.order_number} の明細 ${item.sku} を SKU ${p.sku} に対応付け`,
    metadata: { itemId, fromSku: item.sku, toSku: p.sku },
  });
}

/** 検証を再実行（商品マスター登録後など）。検証エラーが解消すれば引当待ちになる */
export async function revalidateOrderRow(tx: Tx, orderId: string) {
  const o = await tx.maybeOne(`SELECT * FROM orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, orderId]);
  if (!o) throw notFound('注文');
  const items = await tx.many(`SELECT * FROM order_items WHERE organization_id = $1 AND order_id = $2 ORDER BY line_no`, [tx.orgId, orderId]);
  // product_id が未設定の明細は SKU で再解決
  const products = await loadProductsBySku(tx, items.filter((i) => !i.product_id).map((i) => i.sku));
  for (const i of items) {
    if (!i.product_id && products.has(i.sku)) {
      const p = products.get(i.sku)!;
      await tx.exec(`UPDATE order_items SET product_id = $3, product_name = CASE WHEN product_name = '' THEN $4 ELSE product_name END WHERE organization_id = $1 AND id = $2`, [
        tx.orgId,
        i.id,
        p.id,
        p.name,
      ]);
      i.product_id = p.id;
    }
  }
  const issues: ValidationIssue[] = [];
  if (!o.recipient_name) issues.push({ code: 'SHIP_TO_NAME_MISSING', message: '送付先氏名がありません' });
  if (!o.postal_code) issues.push({ code: 'POSTAL_MISSING', message: '郵便番号がありません' });
  else if (!/^\d{3}-\d{4}$/.test(o.postal_code)) issues.push({ code: 'POSTAL_INVALID', message: '郵便番号の形式が不正です' });
  if (!o.address1) issues.push({ code: 'ADDRESS_MISSING', message: '住所がありません' });
  items.forEach((i) => {
    if (!i.product_id && i.quantity - i.cancelled_qty > 0) issues.push({ code: 'UNKNOWN_SKU', message: `未登録の SKU: ${i.sku}`, line: i.line_no });
  });
  await tx.exec(`UPDATE orders SET validation_errors = $3, updated_at = now() WHERE organization_id = $1 AND id = $2`, [
    tx.orgId,
    orderId,
    JSON.stringify(issues),
  ]);
  const st = await recomputeOrderStatus(tx, orderId, issues.length ? '再検証（エラーあり）' : '再検証OK');
  return { issues, status: st.to };
}
