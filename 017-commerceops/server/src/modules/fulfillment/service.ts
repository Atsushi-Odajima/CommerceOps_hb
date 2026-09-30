import type { Tx } from '../../db/tx.js';
import type { AppDeps } from '../../http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { autoResolveException } from '../exceptions/service.js';
import { allocateOrderInTx, releaseAllocations } from '../allocation/engine.js';
import { recomputeOrderStatus } from '../orders/status.js';
import { refreshFulfillmentStatus, refreshWaveStatus } from './status.js';

/**
 * Short Pick の解決（Manager）。
 * - backlog: Short 分を Fulfillment から外し、注文のバックログ（未引当）へ戻す。後で再引当
 * - reallocate: backlog + 指定倉庫で即時引当し、その倉庫の Fulfillment を作成（別倉庫再割当）
 * 注文数量は変更しない（取消は明細取消で人間が明示的に行う）
 */
export async function resolveShort(
  tx: Tx,
  deps: Pick<AppDeps, 'numberingPool'>,
  fulfillmentId: string,
  input: { action: 'backlog' | 'reallocate'; warehouseId?: string; note?: string | null },
) {
  const ff = await tx.maybeOne(`SELECT * FROM fulfillments WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [tx.orgId, fulfillmentId]);
  if (!ff) throw notFound('Fulfillment');
  const shortItems = await tx.many(
    `SELECT * FROM fulfillment_items WHERE organization_id = $1 AND fulfillment_id = $2 AND short_qty > 0 FOR UPDATE`,
    [tx.orgId, fulfillmentId],
  );
  if (!shortItems.length) throw conflict('NO_SHORT', 'この Fulfillment に未解決の Short はありません');
  if (input.action === 'reallocate' && !input.warehouseId) throw conflict('WAREHOUSE_REQUIRED', '再割当先の倉庫を指定してください');
  const units = shortItems.reduce((s, i) => s + i.short_qty, 0);
  await tx.exec(
    `UPDATE fulfillment_items SET required_qty = required_qty - short_qty, short_qty = 0, updated_at = now()
      WHERE organization_id = $1 AND fulfillment_id = $2 AND short_qty > 0`,
    [tx.orgId, fulfillmentId],
  );
  const ffStatus = await refreshFulfillmentStatus(tx, fulfillmentId);
  if (ff.wave_id) await refreshWaveStatus(tx, ff.wave_id);
  await autoResolveException(tx, `short_pick:${fulfillmentId}`, input.action === 'reallocate' ? '別倉庫へ再割当' : 'バックログへ戻す');
  await recomputeOrderStatus(tx, ff.order_id, `Short 解決（${input.action === 'reallocate' ? '再割当' : 'バックログ'}）`);
  let reallocated = 0;
  let newFulfillments: string[] = [];
  if (input.action === 'reallocate') {
    const r = await allocateOrderInTx(tx, deps, ff.order_id, {
      allowPartial: true,
      autoRelease: false,
      warehouseId: input.warehouseId,
      reason: 'REALLOCATE',
      manual: true,
    });
    reallocated = r.allocatedUnits;
    if (reallocated > 0) newFulfillments = await releaseAllocations(tx, deps, ff.order_id, { mode: 'partial' });
  }
  await audit(tx, {
    action: 'fulfillment.resolve_short',
    entityType: 'fulfillment',
    entityId: fulfillmentId,
    summary: `${ff.fulfillment_number} の Short ${units} 個を${input.action === 'reallocate' ? `再割当（${reallocated} 個）` : 'バックログへ戻す'}`,
    metadata: { action: input.action, units, reallocated },
  });
  return { fulfillmentStatus: ffStatus, shortUnits: units, reallocated, newFulfillments };
}
