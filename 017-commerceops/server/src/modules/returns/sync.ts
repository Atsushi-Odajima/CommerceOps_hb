import type { Tx } from '../../db/tx.js';

/** 交換品注文の出荷完了・キャンセルに合わせて交換の状態を更新 */
export async function syncExchangeStatus(tx: Tx, orderId: string) {
  const o = await tx.maybeOne(`SELECT id, exchange_id, status, order_type FROM orders WHERE organization_id = $1 AND id = $2`, [tx.orgId, orderId]);
  if (!o?.exchange_id || o.order_type !== 'replacement') return;
  const next = o.status === 'shipped' ? 'completed' : o.status === 'cancelled' ? 'cancelled' : 'open';
  await tx.exec(`UPDATE exchanges SET status = $3 WHERE organization_id = $1 AND id = $2 AND status <> $3`, [tx.orgId, o.exchange_id, next]);
}
