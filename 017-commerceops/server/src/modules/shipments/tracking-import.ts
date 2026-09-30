/**
 * 追跡番号 CSV 取込（配送会社のシステム等から出力した CSV）
 * - 正規 CSV parser（csv-parse）+ 文字コード明示（UTF-8 / Shift_JIS）。列名で判定（同義語あり）
 * - 荷物の特定: 出荷番号（SH-）優先。なければ 注文番号 + 箱番号（下書きが 1 つなら箱番号省略可）
 * - dryRun で検証結果だけ返す。適用時は行ごとに SAVEPOINT（1 行の失敗で全体を巻き戻さない）
 * - 追跡番号の重複（ファイル内 / 他の荷物）はエラー行にし、適用時は例外 tracking_duplicate を作成
 * - 出荷済みの荷物の追跡番号は CSV では上書きしない（荷物画面で理由を入力して訂正）
 */
import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { AppError, badRequest } from '../../lib/errors.js';
import type { ParsedCsv } from '../imports/csvfile.js';
import { zonedToUtc } from '../imports/mapping.js';
import { audit } from '../audit/audit.js';
import { createException } from '../exceptions/service.js';
import { carrierLabel, confirmShipment, normalizeTracking, resolveCarrier, updateShipmentInfo } from './service.js';

const SYNONYMS: Record<string, string[]> = {
  shipment: ['出荷番号', '荷物番号', 'shipment_number', 'shipment', 'お客様管理番号'],
  order: ['注文番号', 'order_number', 'order'],
  box: ['箱番号', '箱', 'box_no', 'box'],
  carrier: ['配送会社', '運送会社', 'carrier'],
  tracking: ['追跡番号', '伝票番号', 'お問い合わせ番号', '問合せ番号', 'tracking_number', 'tracking'],
  shippedAt: ['出荷日', '出荷日時', '発送日', 'shipped_at'],
};

const key = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/[\s_]/g, '');

export interface TrackingRowResult {
  line: number;
  shipmentNumber?: string;
  orderNumber?: string;
  carrier?: string;
  trackingNumber?: string;
  action: 'update' | 'unchanged' | 'confirmed' | 'error';
  message?: string;
}

function parseShippedAt(v: string, timeZone: string): Date | null {
  const m = v.normalize('NFKC').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '12', m[5] ?? '0', m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return zonedToUtc(y, mo, d, h, mi, s, timeZone);
}

export async function importTracking(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  csv: ParsedCsv,
  opts: { apply: boolean; confirm: boolean; requireTracking: boolean; timeZone: string; defaultCarrier?: string; warehouseIds: string[] | null },
) {
  const header = (csv.header ?? []).map(key);
  const col = Object.fromEntries(
    Object.entries(SYNONYMS).map(([k, names]) => [k, header.findIndex((h) => names.some((n) => key(n) === h))]),
  ) as Record<keyof typeof SYNONYMS, number>;
  if (col.tracking < 0 || (col.shipment < 0 && col.order < 0)) {
    throw badRequest('TEMPLATE_MISMATCH', 'ヘッダーに「追跡番号」と「出荷番号」（または「注文番号」）の列が必要です（追跡番号取込テンプレートを参照）');
  }
  const results: TrackingRowResult[] = [];
  const seenTracking = new Map<string, number>();
  const seenShipment = new Map<string, number>();
  const duplicates: { carrier: string; tracking: string; line: number; owner?: string }[] = [];
  const plans: { r: TrackingRowResult; shipmentId: string; carrier: string; tracking: string; shippedAt: Date | null; status: string }[] = [];

  for (const [i, row] of csv.rows.entries()) {
    const line = csv.lineNumbers[i]!;
    const get = (c: number) => (c >= 0 ? (row[c] ?? '').trim() : '');
    const r: TrackingRowResult = { line, action: 'error' };
    results.push(r);
    try {
      const rawTracking = get(col.tracking);
      if (!rawTracking) throw badRequest('TRACKING_MISSING', '追跡番号が空です');
      const tracking = normalizeTracking(rawTracking);
      r.trackingNumber = tracking;
      const rawCarrier = get(col.carrier);
      const carrier = rawCarrier ? resolveCarrier(rawCarrier) : opts.defaultCarrier ? resolveCarrier(opts.defaultCarrier) : null;
      if (!carrier) throw badRequest('CARRIER_INVALID', rawCarrier ? `配送会社「${rawCarrier.slice(0, 30)}」を認識できません` : '配送会社が指定されていません');
      r.carrier = carrier;
      const rawDate = get(col.shippedAt);
      const shippedAt = rawDate ? parseShippedAt(rawDate, opts.timeZone) : null;
      if (rawDate && !shippedAt) throw badRequest('INVALID_DATE', `出荷日「${rawDate.slice(0, 30)}」を読み取れません（例: 2026-09-30 または 2026/09/30 15:00）`);
      // 荷物の特定
      const shipmentNo = get(col.shipment).normalize('NFKC').toUpperCase();
      let sh: any = null;
      if (shipmentNo) {
        sh = await tx.maybeOne(
          `SELECT s.*, o.order_number FROM shipments s JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id
            WHERE s.organization_id = $1 AND s.shipment_number = $2 AND ($3::uuid[] IS NULL OR s.warehouse_id = ANY($3))`,
          [tx.orgId, shipmentNo, opts.warehouseIds],
        );
        if (!sh) throw badRequest('SHIPMENT_NOT_FOUND', `出荷番号 ${shipmentNo.slice(0, 30)} が見つかりません`);
      } else {
        const orderNo = get(col.order).normalize('NFKC').toUpperCase();
        if (!orderNo) throw badRequest('KEY_MISSING', '出荷番号または注文番号が必要です');
        const boxRaw = get(col.box);
        const box = boxRaw ? Number(boxRaw.normalize('NFKC')) : null;
        if (boxRaw && (!Number.isInteger(box) || box! < 1)) throw badRequest('BOX_INVALID', `箱番号「${boxRaw.slice(0, 10)}」が不正です`);
        const cands = await tx.many(
          `SELECT s.*, o.order_number FROM shipments s JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id
            WHERE s.organization_id = $1 AND o.order_number = $2 AND s.status <> 'cancelled' AND ($3::int IS NULL OR s.box_no = $3)
              AND ($4::uuid[] IS NULL OR s.warehouse_id = ANY($4))
            ORDER BY s.status = 'draft' DESC, s.created_at`,
          [tx.orgId, orderNo, box, opts.warehouseIds],
        );
        const drafts = cands.filter((c) => c.status === 'draft');
        if (!cands.length) throw badRequest('SHIPMENT_NOT_FOUND', `注文 ${orderNo.slice(0, 30)} に該当する荷物がありません`);
        if (drafts.length > 1 || (drafts.length === 0 && cands.length > 1)) throw badRequest('AMBIGUOUS', `注文 ${orderNo.slice(0, 30)} には荷物が複数あります。出荷番号か箱番号を指定してください`);
        sh = drafts[0] ?? cands[0];
      }
      r.shipmentNumber = sh.shipment_number;
      r.orderNumber = sh.order_number;
      const tKey = `${carrier}:${tracking}`;
      if (seenTracking.has(tKey)) {
        duplicates.push({ carrier, tracking, line });
        throw badRequest('TRACKING_DUPLICATE', `追跡番号 ${tracking} がファイル内で重複しています（${seenTracking.get(tKey)} 行目）`);
      }
      if (seenShipment.has(sh.id)) throw badRequest('SHIPMENT_DUPLICATE', `${sh.shipment_number} がファイル内で重複しています（${seenShipment.get(sh.id)} 行目）`);
      seenTracking.set(tKey, line);
      seenShipment.set(sh.id, line);
      if (sh.status === 'cancelled') throw badRequest('SHIPMENT_CANCELLED', `${sh.shipment_number} は取消済みです`);
      if (sh.status === 'shipped') {
        if (sh.tracking_number === tracking && sh.carrier === carrier) {
          r.action = 'unchanged';
          r.message = '出荷済み（同じ追跡番号）';
          continue;
        }
        throw badRequest('ALREADY_SHIPPED', `${sh.shipment_number} は出荷済みです。追跡番号の訂正は荷物の画面から理由を入力して行ってください`);
      }
      const owner = await tx.maybeOne(
        `SELECT s.shipment_number FROM shipments s WHERE s.organization_id = $1 AND s.carrier = $2 AND s.tracking_number = $3 AND s.status <> 'cancelled' AND s.id <> $4`,
        [tx.orgId, carrier, tracking, sh.id],
      );
      if (owner) {
        duplicates.push({ carrier, tracking, line, owner: owner.shipment_number });
        throw badRequest('TRACKING_DUPLICATE', `追跡番号 ${tracking}（${carrierLabel(carrier)}）は ${owner.shipment_number} で使用済みです`);
      }
      r.action = 'update';
      plans.push({ r, shipmentId: sh.id, carrier, tracking, shippedAt, status: sh.status });
    } catch (e) {
      r.action = 'error';
      r.message = e instanceof AppError ? e.message : String((e as Error).message ?? e).slice(0, 200);
    }
  }

  let updated = 0;
  let confirmed = 0;
  if (opts.apply) {
    for (const [n, p] of plans.entries()) {
      try {
        await tx.savepoint(`trk_u_${n}`, () => updateShipmentInfo(tx, p.shipmentId, { carrier: p.carrier, trackingNumber: p.tracking }));
        updated++;
      } catch (e) {
        p.r.action = 'error';
        p.r.message = e instanceof AppError ? e.message : '更新に失敗しました';
        continue;
      }
      if (opts.confirm) {
        try {
          await tx.savepoint(`trk_c_${n}`, () => confirmShipment(tx, p.shipmentId, { shippedAt: p.shippedAt }, { requireTracking: opts.requireTracking }));
          p.r.action = 'confirmed';
          confirmed++;
        } catch (e) {
          p.r.message = `追跡番号は保存しました（出荷確定できません: ${e instanceof AppError ? e.message : 'エラー'}）`;
        }
      }
    }
    for (const d of duplicates) {
      await createException(tx, deps, {
        type: 'tracking_duplicate',
        title: `追跡番号の重複: ${d.tracking}（${carrierLabel(d.carrier)}）`,
        severity: 'medium',
        dedupeKey: `tracking_duplicate:${d.carrier}:${d.tracking}`,
        detail: { carrier: d.carrier, tracking: d.tracking, line: d.line, existingShipment: d.owner },
      });
    }
    await audit(tx, {
      action: 'shipment.tracking_import',
      entityType: 'shipment',
      summary: `追跡番号 CSV 取込（更新 ${updated} / 出荷確定 ${confirmed} / エラー ${results.filter((x) => x.action === 'error').length}）`,
      metadata: { rows: results.length, updated, confirmed, duplicates: duplicates.length },
    });
  }
  return {
    dryRun: !opts.apply,
    total: results.length,
    valid: plans.length,
    updated,
    confirmed,
    unchanged: results.filter((x) => x.action === 'unchanged').length,
    errors: results.filter((x) => x.action === 'error').length,
    rows: results.slice(0, 1000),
  };
}
