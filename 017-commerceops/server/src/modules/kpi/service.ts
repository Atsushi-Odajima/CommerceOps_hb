/**
 * 物流オペレーション KPI（期間・分母を明示。個人別の評価・ランキングは作らない）
 * 期間は組織タイムゾーンの日付（from〜to を含む）。倉庫指定・倉庫スコープ時は、その倉庫の作業に関係するデータのみ集計する
 * （受注件数などの注文単位の指標は「その倉庫の出荷作業がある注文」に限定）。
 */
import type { Tx } from '../../db/tx.js';

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: '件' | '個' | '%' | '時間' | '回';
  numerator?: number;
  denominator?: number;
  definition: string;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
const round1 = (v: number | null) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

export async function computeKpi(tx: Tx, p: { from: string; to: string; timezone: string; warehouseIds: string[] | null }) {
  const base = [tx.orgId, p.from, p.to, p.timezone, p.warehouseIds];
  const start = `($2::date::timestamp AT TIME ZONE $4)`;
  const end = `(($3::date + 1)::timestamp AT TIME ZONE $4)`;
  const orderScope = `($5::uuid[] IS NULL OR EXISTS (SELECT 1 FROM fulfillments fx WHERE fx.organization_id = o.organization_id AND fx.order_id = o.id AND fx.warehouse_id = ANY($5)))`;
  const whScope = (col: string) => `($5::uuid[] IS NULL OR ${col} = ANY($5))`;

  const orders = await tx.one(
    `WITH o AS (
       SELECT o.id, o.order_date, o.cancelled_at,
              (SELECT min(s.shipped_at) FROM shipments s WHERE s.organization_id = o.organization_id AND s.order_id = o.id AND s.status = 'shipped') AS first_ship
         FROM orders o
        WHERE o.organization_id = $1 AND o.order_type = 'standard' AND o.order_date >= ${start} AND o.order_date < ${end} AND ${orderScope})
     SELECT count(*)::int AS received,
            count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled,
            count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active,
            count(*) FILTER (WHERE cancelled_at IS NULL AND first_ship IS NOT NULL AND (first_ship AT TIME ZONE $4)::date = (order_date AT TIME ZONE $4)::date)::int AS same_day,
            count(*) FILTER (WHERE cancelled_at IS NULL AND first_ship IS NOT NULL)::int AS shipped_any,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_ship - order_date) / 3600) FILTER (WHERE first_ship IS NOT NULL) AS median_h,
            avg(extract(epoch FROM first_ship - order_date) / 3600) FILTER (WHERE first_ship IS NOT NULL) AS avg_h
       FROM o`,
    base,
  );
  const ship = await tx.one(
    `SELECT count(*)::int AS shipments, count(DISTINCT s.order_id)::int AS orders,
            COALESCE(SUM((SELECT SUM(si.quantity) FROM shipment_items si WHERE si.organization_id = s.organization_id AND si.shipment_id = s.id)), 0)::int AS units
       FROM shipments s
      WHERE s.organization_id = $1 AND s.status = 'shipped' AND s.shipped_at >= ${start} AND s.shipped_at < ${end} AND ${whScope('s.warehouse_id')}`,
    base,
  );
  const split = await tx.one(
    `WITH firsts AS (
       SELECT s.order_id, min(s.shipped_at) AS first_ship, count(*) AS n
         FROM shipments s JOIN orders o ON o.organization_id = s.organization_id AND o.id = s.order_id AND o.order_type = 'standard'
        WHERE s.organization_id = $1 AND s.status = 'shipped' AND ${whScope('s.warehouse_id')}
        GROUP BY s.order_id)
     SELECT count(*)::int AS orders, count(*) FILTER (WHERE n > 1)::int AS split FROM firsts WHERE first_ship >= ${start} AND first_ship < ${end}`,
    base,
  );
  const onTime = await tx.one(
    `SELECT count(*)::int AS due, count(*) FILTER (WHERE shipped_at IS NOT NULL AND shipped_at <= due_at)::int AS on_time
       FROM fulfillments WHERE organization_id = $1 AND status <> 'cancelled' AND due_at >= ${start} AND due_at < ${end} AND due_at <= now() AND ${whScope('warehouse_id')}`,
    base,
  );
  const work = await tx.one(
    `SELECT
       (SELECT count(*) FROM waves WHERE organization_id = $1 AND created_at >= ${start} AND created_at < ${end} AND status <> 'cancelled' AND ${whScope('warehouse_id')})::int AS waves,
       (SELECT count(*) FROM pick_tasks WHERE organization_id = $1 AND completed_at >= ${start} AND completed_at < ${end} AND status = 'completed' AND ${whScope('warehouse_id')})::int AS pick_tasks,
       (SELECT count(*) FROM pack_sessions WHERE organization_id = $1 AND completed_at >= ${start} AND completed_at < ${end} AND status = 'completed' AND ${whScope('warehouse_id')})::int AS pack_sessions,
       (SELECT count(*) FROM pack_sessions WHERE organization_id = $1 AND completed_at >= ${start} AND completed_at < ${end} AND forced AND ${whScope('warehouse_id')})::int AS forced_packs`,
    base,
  );
  const pick = await tx.one(
    `SELECT COALESCE(SUM(qty) FILTER (WHERE event_type IN ('pick', 'correction')), 0)::int AS picked_units,
            COALESCE(SUM(qty) FILTER (WHERE event_type = 'short'), 0)::int AS short_units,
            count(*) FILTER (WHERE event_type = 'short')::int AS short_events,
            count(*) FILTER (WHERE event_type IN ('mis_scan_location', 'mis_scan_sku', 'over_pick'))::int AS mis,
            count(*) FILTER (WHERE event_type IN ('pick', 'location_ok', 'mis_scan_location', 'mis_scan_sku', 'over_pick'))::int AS scans
       FROM pick_events WHERE organization_id = $1 AND created_at >= ${start} AND created_at < ${end} AND ${whScope('warehouse_id')}`,
    base,
  );
  const pack = await tx.one(
    `SELECT COALESCE(SUM(e.qty) FILTER (WHERE e.event_type IN ('scan', 'correction', 'force_complete')), 0)::int AS packed_units,
            count(*) FILTER (WHERE e.event_type LIKE 'mis_scan%')::int AS mis,
            count(*) FILTER (WHERE e.event_type = 'scan' OR e.event_type LIKE 'mis_scan%')::int AS scans
       FROM pack_events e JOIN pack_sessions ps ON ps.organization_id = e.organization_id AND ps.id = e.pack_session_id
      WHERE e.organization_id = $1 AND e.created_at >= ${start} AND e.created_at < ${end} AND ${whScope('ps.warehouse_id')}`,
    base,
  );
  const holds = await tx.one(
    `SELECT count(*)::int AS placed FROM holds h JOIN orders o ON o.organization_id = h.organization_id AND o.id = h.order_id
      WHERE h.organization_id = $1 AND h.placed_at >= ${start} AND h.placed_at < ${end} AND ${orderScope}`,
    base,
  );
  const exc = await tx.many(
    `SELECT type, count(*) FILTER (WHERE created_at >= ${start} AND created_at < ${end})::int AS created,
            count(*) FILTER (WHERE resolved_at >= ${start} AND resolved_at < ${end})::int AS closed
       FROM exception_cases WHERE organization_id = $1 AND (created_at >= ${start} OR resolved_at >= ${start}) AND ($5::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($5))
      GROUP BY type ORDER BY type`,
    base,
  );
  const excTime = await tx.one(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at) / 3600) AS median_h, count(*)::int AS n
       FROM exception_cases WHERE organization_id = $1 AND status = 'resolved' AND resolved_at >= ${start} AND resolved_at < ${end}
        AND ($5::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($5))`,
    base,
  );
  const ret = await tx.one(
    `SELECT count(*)::int AS returns,
            COALESCE(SUM((SELECT SUM(ri.requested_qty) FROM return_items ri WHERE ri.organization_id = r.organization_id AND ri.return_id = r.id)), 0)::int AS units
       FROM returns r WHERE r.organization_id = $1 AND r.requested_at >= ${start} AND r.requested_at < ${end} AND r.status NOT IN ('cancelled')
        AND ($5::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($5))`,
    base,
  );
  const reasons = await tx.many(
    `SELECT reason_code, count(*)::int AS n FROM returns WHERE organization_id = $1 AND requested_at >= ${start} AND requested_at < ${end} AND status NOT IN ('cancelled')
        AND ($5::uuid[] IS NULL OR warehouse_id IS NULL OR warehouse_id = ANY($5))
      GROUP BY reason_code ORDER BY n DESC`,
    base,
  );
  const insp = await tx.one(
    `SELECT COALESCE(SUM(qty), 0)::int AS inspected, COALESCE(SUM(qty) FILTER (WHERE disposition = 'restock'), 0)::int AS restock,
            COALESCE(SUM(qty) FILTER (WHERE disposition = 'damaged'), 0)::int AS damaged,
            COALESCE(SUM(qty) FILTER (WHERE disposition = 'quarantine'), 0)::int AS quarantine,
            COALESCE(SUM(qty) FILTER (WHERE disposition = 'discard'), 0)::int AS discard
       FROM return_inspections WHERE organization_id = $1 AND inspected_at >= ${start} AND inspected_at < ${end} AND ${whScope('warehouse_id')}`,
    base,
  );
  const exchanges = await tx.one(
    `SELECT count(*)::int AS n FROM exchanges e JOIN returns r ON r.organization_id = e.organization_id AND r.id = e.return_id
      WHERE e.organization_id = $1 AND e.created_at >= ${start} AND e.created_at < ${end} AND e.status <> 'cancelled'
        AND ($5::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($5))`,
    base,
  );
  // 日別推移
  const dOrders = await tx.many(
    `SELECT to_char((o.order_date AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d, count(*)::int AS n FROM orders o
      WHERE o.organization_id = $1 AND o.order_type = 'standard' AND o.order_date >= ${start} AND o.order_date < ${end} AND ${orderScope} GROUP BY 1`,
    base,
  );
  const dShip = await tx.many(
    `SELECT to_char((s.shipped_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d, count(*)::int AS n FROM shipments s
      WHERE s.organization_id = $1 AND s.status = 'shipped' AND s.shipped_at >= ${start} AND s.shipped_at < ${end} AND ${whScope('s.warehouse_id')} GROUP BY 1`,
    base,
  );
  const dRet = await tx.many(
    `SELECT to_char((r.requested_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d, count(*)::int AS n FROM returns r
      WHERE r.organization_id = $1 AND r.requested_at >= ${start} AND r.requested_at < ${end} AND r.status <> 'cancelled'
        AND ($5::uuid[] IS NULL OR r.warehouse_id IS NULL OR r.warehouse_id = ANY($5)) GROUP BY 1`,
    base,
  );
  const days = await tx.many(`SELECT to_char(d, 'YYYY-MM-DD') AS d FROM generate_series($1::date, $2::date, interval '1 day') AS d`, [p.from, p.to]);
  const lookup = (rows: Record<string, any>[]) => new Map<string, number>(rows.map((r) => [String(r.d), Number(r.n)]));
  const mo = lookup(dOrders);
  const ms = lookup(dShip);
  const mr = lookup(dRet);

  const metrics: Metric[] = [
    { key: 'ordersReceived', label: '受注件数', value: orders.received, unit: '件', definition: '期間内の注文日時の通常注文（交換品の注文は含めない）。キャンセル分を含む' },
    { key: 'ordersCancelled', label: 'キャンセル件数', value: orders.cancelled, unit: '件', definition: '上記のうちキャンセルされた注文' },
    { key: 'shipments', label: '出荷件数（荷物）', value: ship.shipments, unit: '件', definition: '期間内に出荷確定した荷物（箱）の数' },
    { key: 'ordersShipped', label: '出荷した注文数', value: ship.orders, unit: '件', definition: '期間内に 1 つ以上の荷物を出荷確定した注文の数' },
    { key: 'unitsShipped', label: '出荷点数', value: ship.units, unit: '個', definition: '期間内に出荷確定した荷物の商品数量の合計' },
    {
      key: 'sameDayShipRate',
      label: '当日出荷率',
      value: pct(orders.same_day, orders.active),
      numerator: orders.same_day,
      denominator: orders.active,
      unit: '%',
      definition: '分子: 期間内に受注した（キャンセル除く）通常注文のうち、注文日と同じ日（組織のタイムゾーン）に最初の荷物を出荷した注文 / 分母: 期間内に受注した（キャンセル除く）通常注文',
    },
    {
      key: 'onTimeShipRate',
      label: '出荷期限内出荷率',
      value: pct(onTime.on_time, onTime.due),
      numerator: onTime.on_time,
      denominator: onTime.due,
      unit: '%',
      definition: '分子: 出荷期限（倉庫の締切時刻から算出）までに出荷した出荷作業 / 分母: 期間内に期限を迎えた出荷作業（キャンセル除く・期限が現在より前のもの）',
    },
    {
      key: 'orderToShipHoursMedian',
      label: '注文→出荷時間（中央値）',
      value: round1(orders.median_h),
      unit: '時間',
      numerator: orders.shipped_any,
      definition: '期間内に受注し出荷済みの通常注文について、注文日時から最初の荷物の出荷確定までの時間の中央値（件数 = 分子）',
    },
    { key: 'orderToShipHoursAvg', label: '注文→出荷時間（平均）', value: round1(orders.avg_h), unit: '時間', definition: '同上の平均' },
    { key: 'waves', label: 'Wave 数', value: work.waves, unit: '件', definition: '期間内に作成した Wave（取消を除く）' },
    { key: 'pickTasks', label: 'Pick 完了タスク数', value: work.pick_tasks, unit: '件', definition: '期間内に完了した Pick タスク' },
    { key: 'pickedUnits', label: 'Pick 数量', value: pick.picked_units, unit: '個', definition: '期間内の Pick 実績（訂正を差し引き後）' },
    { key: 'packSessions', label: 'Pack 完了件数', value: work.pack_sessions, unit: '件', definition: '期間内に完了した梱包' },
    { key: 'packedUnits', label: 'Pack 数量', value: pack.packed_units, unit: '個', definition: '期間内の梱包検品数量（訂正を差し引き後・強制完了分を含む）' },
    {
      key: 'pickMisScanRate',
      label: 'Pick 誤 scan 率',
      value: pct(pick.mis, pick.scans),
      numerator: pick.mis,
      denominator: pick.scans,
      unit: '%',
      definition: '分子: 誤ロケーション・誤 SKU・数量過多の読取 / 分母: Pick の読取操作（ロケーション・商品）の回数',
    },
    {
      key: 'packMisScanRate',
      label: 'Pack 誤 scan 率',
      value: pct(pack.mis, pack.scans),
      numerator: pack.mis,
      denominator: pack.scans,
      unit: '%',
      definition: '分子: 別注文・別 variant・注文外 SKU・未登録・数量過多の読取 / 分母: 梱包の商品読取の回数',
    },
    { key: 'forcedPacks', label: '強制完了', value: work.forced_packs, unit: '件', definition: '期間内に全数検品せずに強制完了した梱包' },
    {
      key: 'shortPickRate',
      label: 'Short Pick 率',
      value: pct(pick.short_units, pick.picked_units + pick.short_units),
      numerator: pick.short_units,
      denominator: pick.picked_units + pick.short_units,
      unit: '%',
      definition: '分子: Short（棚になし）の数量 / 分母: Pick 数量 + Short の数量（期間内の実績）',
    },
    { key: 'shortPickEvents', label: 'Short Pick 件数', value: pick.short_events, unit: '件', definition: '期間内の Short 報告の回数' },
    { key: 'holdsPlaced', label: '保留件数', value: holds.placed, unit: '件', definition: '期間内に保留にした回数' },
    { key: 'shortages', label: '欠品（例外）', value: exc.find((e) => e.type === 'shortage')?.created ?? 0, unit: '件', definition: '期間内に発生した欠品の例外' },
    {
      key: 'splitShipmentRate',
      label: '分割発送率',
      value: pct(split.split, split.orders),
      numerator: split.split,
      denominator: split.orders,
      unit: '%',
      definition: '分子: 期間内に最初の荷物を出荷した通常注文のうち、荷物が 2 つ以上ある注文 / 分母: 期間内に最初の荷物を出荷した通常注文',
    },
    {
      key: 'returnRate',
      label: '返品率（目安）',
      value: pct(ret.returns, ship.orders),
      numerator: ret.returns,
      denominator: ship.orders,
      unit: '%',
      definition: '分子: 期間内に受け付けた返品（取消を除く） / 分母: 期間内に出荷した注文数。受付時期と出荷時期がずれるため目安',
    },
    { key: 'returnUnits', label: '返品数量', value: ret.units, unit: '個', definition: '期間内に受け付けた返品の申請数量' },
    {
      key: 'resaleRate',
      label: '再販可能率',
      value: pct(insp.restock, insp.inspected),
      numerator: insp.restock,
      denominator: insp.inspected,
      unit: '%',
      definition: '分子: 検品で「再販可（Restock）」にした数量 / 分母: 期間内に検品した数量',
    },
    { key: 'exchanges', label: '交換件数', value: exchanges.n, unit: '件', definition: '期間内に作成した交換（取消を除く）' },
    {
      key: 'exceptionResolutionHours',
      label: '例外解決時間（中央値）',
      value: round1(excTime.median_h),
      numerator: excTime.n,
      unit: '時間',
      definition: '期間内に解決した例外の、発生から解決までの時間の中央値（件数 = 分子。無視したものは除く）',
    },
  ];
  return {
    period: { from: p.from, to: p.to, timezone: p.timezone },
    metrics,
    returnReasons: reasons.map((r) => ({ reason: r.reason_code, count: r.n })),
    dispositions: { restock: insp.restock, damaged: insp.damaged, quarantine: insp.quarantine, discard: insp.discard },
    exceptionsByType: exc.map((e) => ({ type: e.type, created: e.created, closed: e.closed })),
    daily: days.map((d) => ({ date: d.d, orders: mo.get(d.d) ?? 0, shipments: ms.get(d.d) ?? 0, returns: mr.get(d.d) ?? 0 })),
  };
}
