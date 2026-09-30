import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, get, patch, post, put } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ErrorBox, Field, Loading, Modal, PageHeader, StatusBadge, useToast } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { EXCEPTION_STATUS, EXCEPTION_TYPE, FULFILLMENT_STATUS, HOLD_REASON, ORDER_STATUS, RETURN_STATUS, SHIPMENT_STATUS, carrierLabel } from '../../lib/labels';
import { AddressFields } from './NewOrderPage';
import { OrderAllocationPanel, OrderCancelButton } from './OrderAllocationPanel';

export function useOrder(id: string | undefined) {
  return useQuery({ queryKey: ['order', id], queryFn: () => get(`/orders/${id}`), enabled: !!id });
}

export default function OrderDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const order = useOrder(id);
  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['order-counts'] });
  };

  if (order.isLoading) return <Loading />;
  if (order.error) return <ErrorBox error={order.error} />;
  const o = order.data;
  const activeHold = o.holds.find((h: any) => !h.releasedAt);
  const itemName = (orderItemId: string) => o.items.find((i: any) => i.id === orderItemId)?.sku ?? '?';

  return (
    <>
      <PageHeader
        title={
          <span className="row">
            注文 {o.orderNumber} <StatusBadge map={ORDER_STATUS} value={o.status} />
            {o.orderType === 'replacement' && <Badge tone="info">交換品</Badge>}
            {o.priority > 0 && <Badge tone="danger">優先 {o.priority}</Badge>}
          </span>
        }
        sub={
          <>
            {o.channelName} / 外部注文番号 <code>{o.externalOrderId}</code> / 注文日時 {fmtDateTime(o.orderDate)}
            {o.importBatchId && (
              <>
                {' '}
                / <Link to={`/imports/${o.importBatchId}`}>取込バッチ</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {can('orders.hold') && !activeHold && !['cancelled', 'closed', 'shipped'].includes(o.status) && (
              <button className="btn" onClick={() => setModal(<HoldModal orderId={o.id} onClose={close} onDone={refresh} />)}>
                保留にする
              </button>
            )}
            {can('orders.edit') && (
              <button className="btn" onClick={() => setModal(<MetaModal order={o} onClose={close} onDone={refresh} />)}>
                優先度・備考
              </button>
            )}
            {can('orders.edit') && o.shipTo && !o.shipments.some((s: any) => s.status === 'shipped') && !['cancelled', 'closed'].includes(o.status) && (
              <button className="btn" onClick={() => setModal(<AddressModal order={o} onClose={close} onDone={refresh} />)}>
                住所変更
              </button>
            )}
            {can('returns.request') && o.items.some((i: any) => i.shippedQty > 0) && (
              <Link className="btn" to={`/returns/new?orderId=${o.id}`}>
                返品・交換受付
              </Link>
            )}
            {can('orders.cancel') && <OrderCancelButton order={o} onDone={refresh} />}
            <Link className="btn" to={`/print/order-label/${o.id}`} target="_blank">
              注文識別コード
            </Link>
          </>
        }
      />
      {modal}
      {activeHold && (
        <div className="alert danger">
          <strong>保留中:</strong> {HOLD_REASON[activeHold.reasonCode]}
          {activeHold.note && `（${activeHold.note}）`} — {activeHold.placedBy} / {fmtDateTime(activeHold.placedAt)}。保留中は Wave・梱包・出荷の対象外です。
          {can('orders.hold') && (
            <button
              className="btn btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => setModal(<ReleaseHoldModal orderId={o.id} holdId={activeHold.id} onClose={close} onDone={refresh} />)}
            >
              保留を解除
            </button>
          )}
        </div>
      )}
      {o.validationErrors?.length > 0 && (
        <div className="alert warning">
          <strong>要確認:</strong>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {o.validationErrors.map((e: any, i: number) => (
              <li key={i}>
                {e.message}
                {e.code === 'UNKNOWN_SKU' && can('orders.edit') && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => setModal(<RemapModal order={o} lineNo={e.line} onClose={close} onDone={refresh} />)}
                  >
                    商品を対応付け
                  </button>
                )}
              </li>
            ))}
          </ul>
          {can('orders.edit') && <RevalidateButton orderId={o.id} onDone={refresh} />}
        </div>
      )}
      <div className="grid grid-2">
        <div className="card">
          <h2>明細</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>SKU / 商品</th>
                  <th className="num">数量</th>
                  <th className="num">引当</th>
                  <th className="num">出荷</th>
                  <th className="num">取消</th>
                </tr>
              </thead>
              <tbody>
                {o.items.map((i: any) => (
                  <tr key={i.id}>
                    <td>{i.lineNo}</td>
                    <td>
                      <code>{i.sku}</code> {!i.productId && <Badge tone="danger">未登録</Badge>}
                      <div className="small">{i.productName}</div>
                      {i.variant && <div className="muted small">{i.variant}</div>}
                    </td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{i.allocatedQty}</td>
                    <td className="num">{i.shippedQty}</td>
                    <td className="num">{i.cancelledQty || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {o.notes && (
            <p className="small" style={{ marginTop: 10 }}>
              <strong>備考:</strong> {o.notes}
            </p>
          )}
          <p className="small muted">配送方法: {o.shippingMethod ?? '—'}</p>
        </div>
        <div className="card">
          <h2>購入者・送付先</h2>
          {o.shipTo ? (
            <dl className="kv">
              {o.customer && (
                <>
                  <dt>購入者</dt>
                  <dd>
                    {o.customer.name ?? '—'}
                    <div className="small muted">
                      {o.customer.email} {o.customer.phone}
                    </div>
                  </dd>
                </>
              )}
              <dt>送付先</dt>
              <dd>
                {o.shipTo.name}
                <div className="small">
                  〒{o.shipTo.postalCode} {o.shipTo.prefecture}
                  {o.shipTo.city}
                  {o.shipTo.address1} {o.shipTo.address2}
                </div>
                {o.shipTo.phone && <div className="small muted">TEL {o.shipTo.phone}</div>}
              </dd>
              {o.customerId && can('customers.manage') && (
                <>
                  <dt>顧客マスター</dt>
                  <dd className="small muted">注文時の内容を保存しています（顧客マスターを編集しても変わりません）</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="muted">個人情報を表示する権限がありません。</p>
          )}
          {o.addressHistory?.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>住所変更履歴</h3>
              <ul className="timeline">
                {o.addressHistory.map((h: any, i: number) => (
                  <li key={i}>
                    {fmtDateTime(h.at)} {h.actor ?? 'システム'}: {h.reason}
                    <div className="small muted">
                      旧: 〒{h.oldValue.postalCode} {h.oldValue.prefecture}
                      {h.oldValue.city}
                      {h.oldValue.address1} {h.oldValue.address2}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <OrderAllocationPanel order={o} onDone={refresh} />

      {o.fulfillments.length > 0 && (
        <div className="card">
          <h2>Fulfillment（出荷作業）</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>番号</th>
                  <th>倉庫</th>
                  <th>状態</th>
                  <th>Wave</th>
                  <th>内容（必要/ピック/梱包/出荷）</th>
                  <th>期限</th>
                </tr>
              </thead>
              <tbody>
                {o.fulfillments.map((f: any) => (
                  <tr key={f.id}>
                    <td>
                      {f.fulfillmentNumber} {f.type === 'replacement' && <Badge tone="info">交換</Badge>}
                    </td>
                    <td>{f.warehouseCode}</td>
                    <td>
                      <StatusBadge map={FULFILLMENT_STATUS} value={f.status} />
                      {f.onHold && <Badge tone="danger">保留</Badge>}
                      {f.hasShort && <Badge tone="danger">Short</Badge>}
                    </td>
                    <td>{f.waveNumber ? <Link to={`/waves/${f.waveId}`}>{f.waveNumber}</Link> : '—'}</td>
                    <td className="small">
                      {f.items.map((x: any) => (
                        <div key={x.id}>
                          <code>{itemName(x.orderItemId)}</code> {x.requiredQty}/{x.pickedQty}/{x.packedQty}/{x.shippedQty}
                          {x.shortQty > 0 && <Badge tone="danger">不足 {x.shortQty}</Badge>}
                        </div>
                      ))}
                    </td>
                    <td className="small">{fmtDateTime(f.dueAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {o.shipments.length > 0 && (
        <div className="card">
          <h2>出荷（Shipment）</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>出荷番号</th>
                  <th>箱</th>
                  <th>状態</th>
                  <th>配送会社 / 追跡番号</th>
                  <th>内容</th>
                  <th>出荷日時</th>
                </tr>
              </thead>
              <tbody>
                {o.shipments.map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.shipmentNumber}</td>
                    <td>{s.boxNo}</td>
                    <td>
                      <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
                    </td>
                    <td className="small">
                      {carrierLabel(s.carrier)} {s.service}
                      <div className="mono">{s.noTracking ? '追跡番号なし' : s.trackingNumber ?? '—'}</div>
                    </td>
                    <td className="small">
                      {s.items.map((x: any, k: number) => (
                        <div key={k}>
                          <code>{itemName(x.orderItemId)}</code> × {x.quantity}
                        </div>
                      ))}
                    </td>
                    <td className="small">{fmtDateTime(s.shippedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h2>状態履歴</h2>
          <ul className="timeline">
            {o.statusHistory.map((h: any, i: number) => (
              <li key={i}>
                <span className="small">{fmtDateTime(h.at)}</span> <StatusBadge map={ORDER_STATUS} value={h.to} />
                <span className="small muted">
                  {' '}
                  {h.reason} {h.actor && `— ${h.actor}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2>保留・返品・例外</h2>
          {o.holds.length === 0 && o.returns.length === 0 && o.exceptions.length === 0 && <p className="muted">ありません</p>}
          {o.holds.map((h: any) => (
            <div key={h.id} className="small" style={{ marginBottom: 6 }}>
              <Badge tone={h.releasedAt ? '' : 'danger'}>保留</Badge> {HOLD_REASON[h.reasonCode]} {h.note && `（${h.note}）`} — {h.placedBy} {fmtDateTime(h.placedAt)}
              {h.releasedAt && (
                <span className="muted">
                  {' '}
                  → 解除 {h.releasedBy} {fmtDateTime(h.releasedAt)} {h.releaseNote}
                </span>
              )}
            </div>
          ))}
          {o.returns.map((r: any) => (
            <div key={r.id} className="small" style={{ marginBottom: 6 }}>
              <Link to={`/returns/${r.id}`}>{r.returnNumber}</Link> <StatusBadge map={RETURN_STATUS} value={r.status} /> {fmtDateTime(r.requestedAt)}
            </div>
          ))}
          {o.exceptions.map((e: any) => (
            <div key={e.id} className="small" style={{ marginBottom: 6 }}>
              <Link to={`/exceptions/${e.id}`}>{e.number}</Link> <Badge>{EXCEPTION_TYPE[e.type]}</Badge> <StatusBadge map={EXCEPTION_STATUS} value={e.status} /> {e.title}
            </div>
          ))}
          {o.relatedOrders?.length > 0 && (
            <div className="small" style={{ marginTop: 8 }}>
              関連注文:{' '}
              {o.relatedOrders.map((r: any) => (
                <Link key={r.id} to={`/orders/${r.id}`} style={{ marginRight: 8 }}>
                  {r.orderNumber}（{r.orderType === 'replacement' ? '交換品' : '元注文'}）
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function HoldModal({ orderId, onClose, onDone }: { orderId: string; onClose: () => void; onDone: () => void }) {
  const [reasonCode, setReason] = useState('address_check');
  const [note, setNote] = useState('');
  const [needConfirm, setNeedConfirm] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  const submit = async (confirm: boolean) => {
    setErr(null);
    try {
      await post(`/orders/${orderId}/holds`, { reasonCode, note: note || null, confirm });
      toast.success('保留にしました');
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') setNeedConfirm(true);
      setErr(e);
    }
  };
  return (
    <Modal
      title="注文を保留にする"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className={`btn ${needConfirm ? 'btn-danger' : 'btn-primary'}`} onClick={() => void submit(needConfirm)}>
            {needConfirm ? '作業中だが保留にする' : '保留にする'}
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <Field label="理由" htmlFor="hold-reason">
        <select id="hold-reason" value={reasonCode} onChange={(e) => setReason(e.target.value)}>
          {Object.entries(HOLD_REASON).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label={reasonCode === 'other' ? 'メモ（必須）' : 'メモ'} htmlFor="hold-note">
        <textarea id="hold-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
}

function ReleaseHoldModal({ orderId, holdId, onClose, onDone }: { orderId: string; holdId: string; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title="保留を解除"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await post(`/orders/${orderId}/holds/${holdId}/release`, { note: note || null });
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            解除する
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <Field label="解除メモ（確認内容など）" htmlFor="rel-note">
        <textarea id="rel-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
}

function MetaModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [priority, setPriority] = useState(order.priority);
  const [notes, setNotes] = useState(order.notes ?? '');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title="優先度・備考"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await patch(`/orders/${order.id}`, { priority: Number(priority), notes: notes || null });
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            保存
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <Field label="優先度（0=通常〜9=最優先）" htmlFor="meta-prio" hint="引当・Wave の並び順に使います">
        <input id="meta-prio" type="number" min={0} max={9} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </Field>
      <Field label="備考" htmlFor="meta-notes">
        <textarea id="meta-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </Field>
    </Modal>
  );
}

function AddressModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const s = order.shipTo;
  const [addr, setAddr] = useState({
    name: s.name ?? '',
    postalCode: s.postalCode ?? '',
    prefecture: s.prefecture ?? '',
    city: s.city ?? '',
    address1: s.address1 ?? '',
    address2: s.address2 ?? '',
    phone: s.phone ?? '',
  });
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  return (
    <Modal
      title="送付先を変更（出荷前のみ）"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={!reason.trim()}
            onClick={async () => {
              try {
                const r = await put(`/orders/${order.id}/address`, {
                  ...Object.fromEntries(Object.entries(addr).map(([k, v]) => [k, v.trim() || null])),
                  reason,
                });
                if (r.warning) toast.info(r.warning);
                else toast.success('送付先を変更しました');
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            変更する
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <AddressFields value={addr} onChange={setAddr} idPrefix="addr" />
      <Field label="変更理由（必須・履歴に残ります）" htmlFor="addr-reason">
        <input id="addr-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}

function RemapModal({ order, lineNo, onClose, onDone }: { order: any; lineNo?: number; onClose: () => void; onDone: () => void }) {
  const item = order.items.find((i: any) => i.lineNo === lineNo) ?? order.items.find((i: any) => !i.productId);
  const [q, setQ] = useState('');
  const products = useQuery({ queryKey: ['products-search', q], queryFn: () => get(`/products?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={`明細 ${item?.sku} を商品に対応付け`} onClose={onClose} wide>
      <ErrorBox error={err} />
      <p className="small muted">取込時の SKU（{item?.sku}）は注文に残したまま、指定した商品として引当・出荷します。対応付けは監査ログに記録されます。</p>
      <input type="search" aria-label="商品を検索" placeholder="SKU・商品名で検索" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="table">
          <tbody>
            {products.data?.items.map((p: any) => (
              <tr key={p.id}>
                <td className="mono">{p.sku}</td>
                <td>
                  {p.name} <span className="muted small">{p.variant}</span>
                </td>
                <td>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={async () => {
                      try {
                        await post(`/orders/${order.id}/items/${item.id}/remap`, { productId: p.id });
                        onDone();
                        onClose();
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    これにする
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function RevalidateButton({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const toast = useToast();
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        try {
          const r = await post(`/orders/${orderId}/revalidate`);
          if (r.issues.length) toast.info(`まだ ${r.issues.length} 件の問題があります`);
          else toast.success('検証OK。引当待ちになりました');
          onDone();
        } catch (e) {
          toast.error(e);
        }
      }}
    >
      再検証（商品登録後など）
    </button>
  );
}

export { fmtNum };
