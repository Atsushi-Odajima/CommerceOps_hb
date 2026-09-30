/**
 * 在庫・数量の不変条件チェック（docs/INVENTORY_RULES.md §3）。
 * テスト・CLI（npm run integrity）・バックアップ復元後の検証で使用。
 */
import type { Tx } from '../../db/tx.js';

export interface IntegrityViolation {
  check: string;
  count: number;
  sample: unknown[];
}

const CHECKS: { name: string; sql: string }[] = [
  {
    name: 'balance.on_hand = Σ movements.on_hand_delta',
    sql: `SELECT b.id, b.on_hand, COALESCE(SUM(m.on_hand_delta), 0) AS ledger
            FROM inventory_balances b LEFT JOIN inventory_movements m ON m.organization_id = b.organization_id AND m.balance_id = b.id
           WHERE b.organization_id = $1 GROUP BY b.id, b.on_hand HAVING b.on_hand <> COALESCE(SUM(m.on_hand_delta), 0)`,
  },
  {
    name: 'balance.held = Σ movements.held_delta',
    sql: `SELECT b.id, b.held, COALESCE(SUM(m.held_delta), 0) AS ledger
            FROM inventory_balances b LEFT JOIN inventory_movements m ON m.organization_id = b.organization_id AND m.balance_id = b.id
           WHERE b.organization_id = $1 GROUP BY b.id, b.held HAVING b.held <> COALESCE(SUM(m.held_delta), 0)`,
  },
  {
    name: 'balance.allocated = Σ open active allocations',
    sql: `SELECT b.id, b.allocated, COALESCE(SUM(a.quantity - a.shipped_qty - a.released_qty) FILTER (WHERE a.status = 'active'), 0) AS open
            FROM inventory_balances b LEFT JOIN allocations a ON a.organization_id = b.organization_id AND a.balance_id = b.id
           WHERE b.organization_id = $1 GROUP BY b.id, b.allocated
          HAVING b.allocated <> COALESCE(SUM(a.quantity - a.shipped_qty - a.released_qty) FILTER (WHERE a.status = 'active'), 0)`,
  },
  {
    name: 'order_item.allocated_qty = Σ open active allocations',
    sql: `SELECT oi.id, oi.allocated_qty, COALESCE(SUM(a.quantity - a.shipped_qty - a.released_qty) FILTER (WHERE a.status = 'active'), 0) AS open
            FROM order_items oi LEFT JOIN allocations a ON a.organization_id = oi.organization_id AND a.order_item_id = oi.id
           WHERE oi.organization_id = $1 GROUP BY oi.id, oi.allocated_qty
          HAVING oi.allocated_qty <> COALESCE(SUM(a.quantity - a.shipped_qty - a.released_qty) FILTER (WHERE a.status = 'active'), 0)`,
  },
  {
    name: 'order_item.shipped_qty = Σ shipped shipment_items',
    sql: `SELECT oi.id, oi.shipped_qty, COALESCE(SUM(si.quantity) FILTER (WHERE s.status = 'shipped'), 0) AS shipped
            FROM order_items oi
            LEFT JOIN shipment_items si ON si.organization_id = oi.organization_id AND si.order_item_id = oi.id
            LEFT JOIN shipments s ON s.organization_id = si.organization_id AND s.id = si.shipment_id
           WHERE oi.organization_id = $1 GROUP BY oi.id, oi.shipped_qty
          HAVING oi.shipped_qty <> COALESCE(SUM(si.quantity) FILTER (WHERE s.status = 'shipped'), 0)`,
  },
  {
    name: 'fulfillment_item.picked_qty = Σ pick events (pick + correction)',
    sql: `SELECT fi.id, fi.picked_qty, COALESCE(SUM(pe.qty) FILTER (WHERE pe.event_type IN ('pick', 'correction')), 0) AS events
            FROM fulfillment_items fi
            LEFT JOIN pick_task_lines l ON l.organization_id = fi.organization_id AND l.fulfillment_item_id = fi.id
            LEFT JOIN pick_events pe ON pe.organization_id = l.organization_id AND pe.pick_task_line_id = l.id
           WHERE fi.organization_id = $1 GROUP BY fi.id, fi.picked_qty
          HAVING fi.picked_qty <> COALESCE(SUM(pe.qty) FILTER (WHERE pe.event_type IN ('pick', 'correction')), 0)`,
  },
  {
    name: 'fulfillment_item.shipped_qty = Σ shipped shipment_items',
    sql: `SELECT fi.id, fi.shipped_qty, COALESCE(SUM(si.quantity) FILTER (WHERE s.status = 'shipped'), 0) AS shipped
            FROM fulfillment_items fi
            LEFT JOIN shipment_items si ON si.organization_id = fi.organization_id AND si.fulfillment_item_id = fi.id
            LEFT JOIN shipments s ON s.organization_id = si.organization_id AND s.id = si.shipment_id
           WHERE fi.organization_id = $1 GROUP BY fi.id, fi.shipped_qty
          HAVING fi.shipped_qty <> COALESCE(SUM(si.quantity) FILTER (WHERE s.status = 'shipped'), 0)`,
  },
  {
    name: 'fulfillment_item.packed_qty = Σ pack events of active/completed sessions (cancelled fulfillments excluded)',
    sql: `SELECT fi.id, fi.packed_qty, COALESCE(x.n, 0) AS events
            FROM fulfillment_items fi
            JOIN fulfillments f ON f.organization_id = fi.organization_id AND f.id = fi.fulfillment_id AND f.status <> 'cancelled'
            LEFT JOIN (SELECT e.fulfillment_item_id, SUM(e.qty) AS n FROM pack_events e
                         JOIN pack_sessions ps ON ps.organization_id = e.organization_id AND ps.id = e.pack_session_id AND ps.status IN ('active', 'completed')
                        WHERE e.organization_id = $1 AND e.event_type IN ('scan', 'correction', 'force_complete') GROUP BY e.fulfillment_item_id) x
              ON x.fulfillment_item_id = fi.id
           WHERE fi.organization_id = $1 AND fi.packed_qty <> COALESCE(x.n, 0)`,
  },
  {
    name: 'Σ non-cancelled shipment_items <= fulfillment_item.packed_qty',
    sql: `SELECT fi.id, fi.packed_qty, SUM(si.quantity) AS in_shipments
            FROM fulfillment_items fi
            JOIN shipment_items si ON si.organization_id = fi.organization_id AND si.fulfillment_item_id = fi.id
            JOIN shipments s ON s.organization_id = si.organization_id AND s.id = si.shipment_id AND s.status <> 'cancelled'
           WHERE fi.organization_id = $1 GROUP BY fi.id, fi.packed_qty HAVING SUM(si.quantity) > fi.packed_qty`,
  },
  {
    name: 'at most one active pack session per fulfillment / completed sessions have shipments',
    sql: `SELECT ps.id, ps.status FROM pack_sessions ps
           WHERE ps.organization_id = $1 AND ps.status = 'completed'
             AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.organization_id = ps.organization_id AND s.pack_session_id = ps.id)`,
  },
  {
    name: 'allocation.shipped_qty = Σ ship movements',
    sql: `SELECT a.id, a.shipped_qty, COALESCE(-SUM(m.on_hand_delta), 0) AS moved
            FROM allocations a LEFT JOIN inventory_movements m
              ON m.organization_id = a.organization_id AND m.movement_type = 'ship' AND m.reference_type = 'allocation' AND m.reference_id = a.id
           WHERE a.organization_id = $1 GROUP BY a.id, a.shipped_qty HAVING a.shipped_qty <> COALESCE(-SUM(m.on_hand_delta), 0)`,
  },
  {
    name: 'return_item.inspected_qty = Σ inspections',
    sql: `SELECT ri.id, ri.inspected_qty, COALESCE(SUM(ins.qty), 0) AS inspected
            FROM return_items ri LEFT JOIN return_inspections ins ON ins.organization_id = ri.organization_id AND ins.return_item_id = ri.id
           WHERE ri.organization_id = $1 GROUP BY ri.id, ri.inspected_qty HAVING ri.inspected_qty <> COALESCE(SUM(ins.qty), 0)`,
  },
  {
    name: 'returned qty <= shipped qty (per order item, active returns)',
    sql: `SELECT oi.id, oi.shipped_qty, SUM(ri.requested_qty) AS returned
            FROM order_items oi JOIN return_items ri ON ri.organization_id = oi.organization_id AND ri.order_item_id = oi.id
            JOIN returns r ON r.organization_id = ri.organization_id AND r.id = ri.return_id AND r.status NOT IN ('rejected', 'cancelled')
           WHERE oi.organization_id = $1 GROUP BY oi.id, oi.shipped_qty HAVING SUM(ri.requested_qty) > oi.shipped_qty`,
  },
  {
    name: 'restocked qty <= received qty',
    sql: `SELECT ri.id, ri.received_qty, SUM(ins.qty) AS dispositioned
            FROM return_items ri JOIN return_inspections ins ON ins.organization_id = ri.organization_id AND ins.return_item_id = ri.id
           WHERE ri.organization_id = $1 GROUP BY ri.id, ri.received_qty HAVING SUM(ins.qty) > ri.received_qty`,
  },
];

export async function checkIntegrity(tx: Tx): Promise<IntegrityViolation[]> {
  const out: IntegrityViolation[] = [];
  for (const c of CHECKS) {
    const rows = await tx.many(`${c.sql} LIMIT 20`, [tx.orgId]);
    if (rows.length) out.push({ check: c.name, count: rows.length, sample: rows.slice(0, 5) });
  }
  return out;
}
