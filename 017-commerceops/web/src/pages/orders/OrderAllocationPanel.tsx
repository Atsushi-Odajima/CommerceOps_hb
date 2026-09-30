import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, post } from '../../api/client';
import { get } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ConfirmDialog, ErrorBox, Field, Modal, useToast } from '../../components/ui';

const ALLOCATABLE = ['ready_for_allocation', 'partially_allocated', 'partially_shipped'];

/** 注文詳細の引当パネル: 説明・引当・倉庫指定（分割）・先行出荷・解除 */
export function OrderAllocationPanel({ order, onDone }: { order: any; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDealloc, setConfirmDealloc] = useState(false);
  const needUnits = order.items.reduce((s: number, i: any) => s + (i.quantity - i.cancelledQty - i.shippedQty - i.allocatedQty), 0);
  const canAllocate = can('allocation.manage') && ALLOCATABLE.includes(order.status) && needUnits > 0;
  const plan = useQuery({
    queryKey: ['allocation-plan', order.id, order.version],
    queryFn: () => get(`/orders/${order.id}/allocation-plan`),
    enabled: canAllocate,
  });
  const unreleased = order.allocations.filter((a: any) => a.status === 'active' && !a.fulfillmentId);
  const releasable = order.allocations.filter(
    (a: any) => a.status === 'active' && (!a.fulfillmentId || order.fulfillments.find((f: any) => f.id === a.fulfillmentId)?.status === 'ready'),
  );
  if (!can('allocation.manage') && !order.allocations.length) return null;

  const run = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      toast.success(ok(r));
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const itemSku = (id: string) => order.items.find((i: any) => i.id === id)?.sku ?? '?';

  return (
    <div className="card">
      <div className="card-header">
        <h2>在庫引当</h2>
        <div className="actions">
          {canAllocate && (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => post(`/orders/${order.id}/allocate`, {}),
                  (r) => (r.outcome === 'full' ? `全量引当しました（${r.allocatedUnits}個）` : r.outcome === 'partial' ? `一部引当しました（${r.allocatedUnits}個・不足 ${r.remainingUnits}個）` : '引当可能な在庫がありません'),
                )
              }
            >
              ルールで引当
            </button>
          )}
          {can('allocation.manage') && unreleased.length > 0 && needUnits > 0 && (
            <button
              className="btn btn-sm btn-warning"
              disabled={busy}
              title="引当済みの商品だけで Fulfillment（出荷作業）を作成します"
              onClick={() => void run(() => post(`/orders/${order.id}/release`, {}), () => '揃った分で先行出荷の作業を作成しました')}
            >
              揃った分を先行出荷
            </button>
          )}
          {can('allocation.manage') && releasable.length > 0 && (
            <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmDealloc(true)}>
              引当解除
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={err} />
      {canAllocate && plan.data && (
        <div className="alert info">
          <strong>判断の説明:</strong> {plan.data.recommendation}
          {plan.data.plans.length > 1 && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>倉庫</th>
                    {plan.data.needs.map((n: any) => (
                      <th key={n.id} className="num">
                        {n.sku}（必要 {n.need}）
                      </th>
                    ))}
                    <th>判定</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {plan.data.plans.map((p: any) => (
                    <tr key={p.warehouseId}>
                      <td>{p.warehouseCode}</td>
                      {p.items.map((i: any) => (
                        <td key={i.orderItemId} className="num">
                          {i.available}
                        </td>
                      ))}
                      <td>{p.canFulfillAll ? <Badge tone="success">全量可</Badge> : p.satisfiableUnits > 0 ? <Badge tone="warning">一部 {p.satisfiableUnits}</Badge> : <Badge>なし</Badge>}</td>
                      <td>
                        {p.satisfiableUnits > 0 && (
                          <button
                            className="btn btn-sm"
                            disabled={busy}
                            title="この倉庫から引当（分割出荷の確定）"
                            onClick={() =>
                              void run(
                                () => post(`/orders/${order.id}/allocate`, { warehouseId: p.warehouseId }),
                                (r) => `${p.warehouseCode} から ${r.allocatedUnits}個引当しました`,
                              )
                            }
                          >
                            この倉庫から引当
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {order.allocations.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>倉庫 / ロケーション</th>
                <th className="num">数量</th>
                <th className="num">出荷</th>
                <th className="num">解放</th>
                <th>状態</th>
                <th>理由</th>
              </tr>
            </thead>
            <tbody>
              {order.allocations.map((a: any) => (
                <tr key={a.id}>
                  <td>
                    <code>{itemSku(a.orderItemId)}</code>
                  </td>
                  <td className="mono small">
                    {a.warehouseCode} / {a.locationCode}
                  </td>
                  <td className="num">{a.quantity}</td>
                  <td className="num">{a.shippedQty}</td>
                  <td className="num">{a.releasedQty}</td>
                  <td>
                    <Badge tone={a.status === 'active' ? 'info' : a.status === 'consumed' ? 'success' : ''}>{{ active: '引当中', consumed: '出荷済', released: '解放' }[a.status as string]}</Badge>
                    {a.status === 'active' && !a.fulfillmentId && <Badge tone="warning">未作業化</Badge>}
                  </td>
                  <td className="small muted">
                    {{ FULL_SINGLE_WAREHOUSE: '全量（単一倉庫）', PARTIAL: '一部引当', MANUAL_WAREHOUSE: '倉庫指定', REALLOCATE: '再割当' }[a.reason as string] ?? a.reason}
                    {a.releaseReason && <div>{a.releaseReason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">引当はまだありません。</p>
      )}
      {confirmDealloc && (
        <ConfirmDialog
          title="引当を解除"
          message="Wave 投入前の引当を解除し、在庫を他の注文が使えるようにします。出荷作業（Wave待ち）からも外れます。"
          requireReason
          reasonLabel="解除理由"
          danger
          confirmLabel="解除する"
          onClose={() => setConfirmDealloc(false)}
          onConfirm={async (reason) => {
            const r = await post(`/orders/${order.id}/deallocate`, { reason });
            toast.success(`${r.released}個の引当を解除しました`);
            onDone();
          }}
        />
      )}
    </div>
  );
}

export function OrderCancelButton({ order, onDone }: { order: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const shipped = order.items.some((i: any) => i.shippedQty > 0);
  if (order.status === 'cancelled' || order.status === 'closed') return null;
  return (
    <>
      {!shipped && (
        <button className="btn btn-danger" onClick={() => setOpen(true)}>
          キャンセル
        </button>
      )}
      <button className="btn" onClick={() => setLineOpen(true)}>
        明細取消
      </button>
      {open && <CancelModal order={order} onClose={() => setOpen(false)} onDone={onDone} />}
      {lineOpen && <CancelLinesModal order={order} onClose={() => setLineOpen(false)} onDone={onDone} />}
    </>
  );
}

function CancelModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [needConfirm, setNeedConfirm] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  return (
    <Modal
      title={`注文 ${order.orderNumber} をキャンセル`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            やめる
          </button>
          <button
            className="btn btn-danger"
            disabled={!reason.trim()}
            onClick={async () => {
              setErr(null);
              try {
                const r = await post(`/orders/${order.id}/cancel`, { reason, confirm: needConfirm });
                toast.success(`キャンセルしました（引当解放 ${r.releasedUnits ?? 0}個${r.putback?.length ? '・棚戻しタスクを作成' : ''}）`);
                onDone();
                onClose();
              } catch (e) {
                if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') setNeedConfirm(true);
                setErr(e);
              }
            }}
          >
            {needConfirm ? '作業中だがキャンセルする' : 'キャンセルする'}
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <p>未出荷の引当は解放されます。ピック済みの商品がある場合は「キャンセル棚戻し」の例外が作成されます。</p>
      <Field label="キャンセル理由（必須）" htmlFor="cancel-reason">
        <textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}

function CancelLinesModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  const lines = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([itemId, q]) => ({ itemId, qty: q }));
  return (
    <Modal
      title="明細の一部を取消（顧客合意済みの場合のみ）"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            やめる
          </button>
          <button
            className="btn btn-danger"
            disabled={!lines.length || !reason.trim()}
            onClick={async () => {
              try {
                await post(`/orders/${order.id}/cancel-lines`, { lines, reason });
                toast.success('明細を取消しました');
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            取消する
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <p className="small muted">システムが自動で数量を減らすことはありません。出荷済み・作業中（Wave 投入後）の数量は取消できません。</p>
      <table className="table">
        <thead>
          <tr>
            <th>SKU</th>
            <th className="num">未出荷</th>
            <th>取消数量</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i: any) => {
            const max = i.quantity - i.cancelledQty - i.shippedQty;
            return (
              <tr key={i.id}>
                <td>
                  <code>{i.sku}</code>
                </td>
                <td className="num">{max}</td>
                <td>
                  <input
                    type="number"
                    aria-label={`${i.sku} の取消数量`}
                    min={0}
                    max={max}
                    value={qty[i.id] ?? 0}
                    disabled={max === 0}
                    onChange={(e) => setQty({ ...qty, [i.id]: Math.max(0, Math.min(max, Number(e.target.value))) })}
                    style={{ maxWidth: 100 }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Field label="理由（必須）" htmlFor="cl-reason">
        <input id="cl-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}
