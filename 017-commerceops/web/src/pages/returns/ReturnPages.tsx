import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, get, newRequestId, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ConfirmDialog, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, Pagination, StatusBadge, useOnline, useToast } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { DISPOSITION, ORDER_STATUS, RETURN_REASON, RETURN_STATUS } from '../../lib/labels';
import { useWarehouses } from '../settings/WarehousesPage';
import { ExportButton } from '../../components/ExportButton';

const TABS = [
  { key: 'open', label: '未完了' },
  { key: 'to_authorize', label: '承認待ち' },
  { key: 'to_receive', label: '到着待ち' },
  { key: 'to_inspect', label: '検品待ち' },
  { key: 'done', label: '完了・却下・取消' },
  { key: '', label: 'すべて' },
];

export default function ReturnsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'open';
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ limit: '50', offset: String(offset) });
  if (status) params.set('status', status);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({ queryKey: ['returns', params.toString()], queryFn: () => get(`/returns?${params}`), placeholderData: keepPreviousData });
  const items: any[] = list.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="返品・交換"
        sub="返品は元の注文・荷物に紐づけて管理します。到着しただけでは在庫に戻らず、検品で「再販可」にした分だけ販売可能在庫に戻ります。"
        actions={
          <>
            <ExportButton path="/returns/export" filename="returns.csv" requirePerm="returns.read" label="CSV 出力" />
            {can('returns.request') && (
              <Link className="btn btn-primary" to="/returns/new">
                返品を受け付ける
              </Link>
            )}
          </>
        }
      />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            className={`tab ${status === t.key ? 'active' : ''}`}
            onClick={() => {
              const n = new URLSearchParams(sp);
              n.set('status', t.key);
              setSp(n);
              setOffset(0);
            }}
          >
            {t.label} {t.key && list.data?.counts?.[t.key] ? <Badge tone={t.key === 'done' ? '' : 'warning'}>{list.data.counts[t.key]}</Badge> : null}
          </button>
        ))}
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="rt-q">検索</label>
          <input id="rt-q" type="search" placeholder="返品番号（RT-）・注文番号" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        </div>
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>返品番号</th>
                <th>注文</th>
                <th>理由</th>
                <th>状態</th>
                <th className="num">申請 / 到着 / 検品</th>
                <th>交換</th>
                <th>受付日時</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/returns/${r.id}`} className="mono">
                      {r.returnNumber}
                    </Link>
                  </td>
                  <td>
                    {can('orders.read') ? <Link to={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : r.orderNumber}
                    <div className="small muted">{r.channelName}</div>
                  </td>
                  <td>{RETURN_REASON[r.reasonCode]}</td>
                  <td>
                    <StatusBadge map={RETURN_STATUS} value={r.status} />
                  </td>
                  <td className="num">
                    {r.requested} / {r.received} / {r.inspected}
                  </td>
                  <td>{r.exchangeNumber ?? '—'}</td>
                  <td className="small">{fmtDateTime(r.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="該当する返品はありません" />
      )}
      <Pagination total={list.data?.total ?? 0} capped={list.data?.totalCapped} limit={50} offset={offset} onChange={setOffset} />
    </>
  );
}

export function NewReturnPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [orderId, setOrderId] = useState(sp.get('orderId') ?? '');
  const [code, setCode] = useState('');
  const [lookupErr, setLookupErr] = useState<unknown>(null);
  const data = useQuery({ queryKey: ['returnable', orderId], queryFn: () => get(`/orders/${orderId}/returnable`), enabled: !!orderId });
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reasonCode, setReasonCode] = useState('defective');
  const [shipmentId, setShipmentId] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const findOrder = async () => {
    setLookupErr(null);
    try {
      const r = await get(`/orders?q=${encodeURIComponent(code.trim())}&limit=5`);
      const hit = r.items.find((o: any) => o.orderNumber === code.trim().toUpperCase() || o.externalOrderId === code.trim()) ?? r.items[0];
      if (!hit) throw new Error('該当する注文がありません');
      setOrderId(hit.id);
      setQty({});
    } catch (e) {
      setLookupErr(e);
    }
  };
  const d = data.data;
  const chosen = d ? d.items.filter((i: any) => (qty[i.orderItemId] ?? 0) > 0) : [];
  return (
    <>
      <PageHeader title="返品を受け付ける" sub="出荷済みの数量まで返品を受け付けられます。受付だけでは在庫は変わりません。" />
      <div className="card">
        {!orderId ? (
          <div className="inline-fields">
            <Field label="注文番号 / 外部注文番号" htmlFor="nr-code">
              <input id="nr-code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void findOrder()} />
            </Field>
            <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={!code.trim()} onClick={() => void findOrder()}>
              注文を探す
            </button>
          </div>
        ) : (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              注文 <strong>{d?.orderNumber}</strong> {d && <StatusBadge map={ORDER_STATUS} value={d.orderStatus} />}
            </div>
            {!sp.get('orderId') && (
              <button className="btn btn-sm" onClick={() => setOrderId('')}>
                別の注文
              </button>
            )}
          </div>
        )}
        <ErrorBox error={lookupErr ?? data.error} />
      </div>
      {d && (
        <div className="card">
          <ErrorBox error={err} />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>商品</th>
                  <th className="num">出荷済 / 返品済</th>
                  <th style={{ width: 140 }}>返品数量</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((i: any) => (
                  <tr key={i.orderItemId}>
                    <td className="mono">{i.sku}</td>
                    <td>
                      {i.name}
                      {i.variant ? ` / ${i.variant}` : ''}
                    </td>
                    <td className="num">
                      {i.shippedQty} / {i.returnedQty}
                    </td>
                    <td>
                      <input
                        type="number"
                        aria-label={`${i.sku} の返品数量`}
                        min={0}
                        max={i.returnableQty}
                        disabled={i.returnableQty === 0}
                        value={qty[i.orderItemId] ?? 0}
                        onChange={(e) => setQty({ ...qty, [i.orderItemId]: Math.max(0, Math.min(i.returnableQty, Number(e.target.value) || 0)) })}
                      />
                      <div className="small muted">最大 {i.returnableQty}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inline-fields" style={{ marginTop: 12 }}>
            <Field label="返品理由" htmlFor="nr-reason">
              <select id="nr-reason" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                {Object.entries(RETURN_REASON).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            {d.shipments.length > 1 && (
              <Field label="対象の荷物（任意）" htmlFor="nr-ship">
                <select id="nr-ship" value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
                  <option value="">指定しない</option>
                  {d.shipments.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.shipmentNumber}（箱 {s.boxNo}）
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Field label="お客様からの連絡内容" htmlFor="nr-cnote" hint={reasonCode === 'other' ? '「その他」の場合はいずれかのメモが必須です' : undefined}>
            <textarea id="nr-cnote" value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} maxLength={1000} />
          </Field>
          <Field label="社内メモ" htmlFor="nr-inote">
            <textarea id="nr-inote" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} maxLength={1000} />
          </Field>
          <button
            className="btn btn-primary"
            disabled={!chosen.length || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await post('/returns', {
                  orderId,
                  shipmentId: shipmentId || null,
                  reasonCode,
                  customerNote: customerNote || null,
                  internalNote: internalNote || null,
                  items: chosen.map((i: any) => ({ orderItemId: i.orderItemId, qty: qty[i.orderItemId] })),
                });
                nav(`/returns/${r.id}`);
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            返品を受け付ける（{chosen.reduce((s: number, i: any) => s + qty[i.orderItemId]!, 0)} 個）
          </button>
        </div>
      )}
    </>
  );
}

export function useReturn(id: string | undefined) {
  return useQuery({ queryKey: ['return', id], queryFn: () => get(`/returns/${id}`), enabled: !!id });
}

export function ReturnDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useReturn(id);
  const [modal, setModal] = useState<null | 'reject' | 'cancel' | 'transit' | 'receive' | 'exchange'>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const r = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['return', id] });
    void qc.invalidateQueries({ queryKey: ['returns'] });
  };
  const act = async (path: string, body: object = {}, msg = '更新しました') => {
    try {
      await post(`/returns/${id}/${path}`, body);
      toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  const openExchange = r.exchanges.find((e: any) => e.status !== 'cancelled');
  const canExchange = can('exchanges.create') && !openExchange && ['authorized', 'in_transit', 'received', 'inspecting', 'completed'].includes(r.status);
  return (
    <>
      <PageHeader
        title={
          <span className="row">
            返品 <span className="mono">{r.returnNumber}</span> <StatusBadge map={RETURN_STATUS} value={r.status} />
          </span>
        }
        sub={
          <>
            注文 {can('orders.read') ? <Link to={`/orders/${r.orderId}`}>{r.orderNumber}</Link> : r.orderNumber} / {r.channelName} / 理由: {RETURN_REASON[r.reasonCode]}
            {r.warehouseCode && ` / 返品倉庫 ${r.warehouseCode}`}
            {r.shipmentNumber && ` / 荷物 ${r.shipmentNumber}`}
            {can('audit.read') && (
              <>
                {' '}
                / <Link to={`/audit?entityType=return&entityId=${r.id}`}>操作履歴（監査ログ）</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {r.status === 'requested' && can('returns.request') && (
              <button className="btn btn-primary" onClick={() => void act('authorize', {}, '返品を承認しました')}>
                承認
              </button>
            )}
            {r.status === 'authorized' && can('returns.request') && (
              <button className="btn" onClick={() => setModal('transit')}>
                返送中にする
              </button>
            )}
            {['requested', 'authorized', 'in_transit'].includes(r.status) && can('returns.receive') && (
              <button className="btn btn-primary" onClick={() => setModal('receive')}>
                到着を登録
              </button>
            )}
            {canExchange && (
              <button className="btn" onClick={() => setModal('exchange')}>
                交換品を手配
              </button>
            )}
            {['requested', 'authorized'].includes(r.status) && can('returns.request') && (
              <button className="btn" onClick={() => setModal('reject')}>
                却下
              </button>
            )}
            {['requested', 'authorized', 'in_transit'].includes(r.status) && can('returns.request') && (
              <button className="btn btn-ghost" onClick={() => setModal('cancel')}>
                取消
              </button>
            )}
            <Link className="btn" to={`/print/return/${r.id}`} target="_blank">
              受領票を印刷
            </Link>
          </>
        }
      />
      {['received', 'inspecting'].includes(r.status) && can('returns.inspect') && (
        // 一部だけ確定した後は、最新の未検品数で入力欄を作り直す（古い行のまま再送すると到着数超過になる）
        <InspectPanel key={r.items.map((i: any) => `${i.id}:${i.inspectedQty}`).join(',')} ret={r} onDone={refresh} />
      )}
      {['received', 'inspecting'].includes(r.status) && !can('returns.inspect') && (
        <div className="alert info">到着済みです。検品（再販可・破損などの判定）は管理者が行います。</div>
      )}
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>返品明細</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>商品</th>
                <th className="num">申請</th>
                <th className="num">到着</th>
                <th className="num">検品</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((i: any) => (
                <tr key={i.id}>
                  <td className="mono">{i.sku}</td>
                  <td>
                    {i.name}
                    {i.variant ? ` / ${i.variant}` : ''}
                  </td>
                  <td className="num">{i.requestedQty}</td>
                  <td className="num">{i.receivedQty}</td>
                  <td className="num">{i.inspectedQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.customerNote && (
            <p className="small">
              <strong>お客様の連絡:</strong> {r.customerNote}
            </p>
          )}
          {r.internalNote && (
            <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
              <strong>社内メモ:</strong> {r.internalNote}
            </p>
          )}
          {r.returnTrackingNumber && (
            <p className="small">
              返送の追跡番号: <span className="mono">{r.returnTrackingNumber}</span> {r.returnCarrier}
            </p>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h2>経過</h2>
          </div>
          <ul className="timeline">
            {r.timeline.map((t: any) => (
              <li key={t.key}>
                <strong>{RETURN_STATUS[t.key]?.label ?? t.key}</strong> {fmtDateTime(t.at)} {t.by ? `（${t.by}）` : ''}
                {t.note && <div className="small muted">理由: {t.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {r.inspections.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>検品結果</h2>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>SKU</th>
                  <th>判定</th>
                  <th className="num">数量</th>
                  <th>戻し先</th>
                  <th>検品者</th>
                  <th>理由 / メモ</th>
                </tr>
              </thead>
              <tbody>
                {r.inspections.map((x: any) => (
                  <tr key={x.id}>
                    <td className="small">{fmtDateTime(x.inspectedAt)}</td>
                    <td className="mono">{x.sku}</td>
                    <td>
                      <Badge tone={DISPOSITION[x.disposition]!.tone}>{DISPOSITION[x.disposition]!.label}</Badge>
                    </td>
                    <td className="num">{x.qty}</td>
                    <td className="mono">{x.locationCode ?? '—'}</td>
                    <td>{x.inspector}</td>
                    <td className="small">
                      {x.reason}
                      {x.note && <div className="muted">{x.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {r.photos.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>写真</h2>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {r.photos.map((p: any) => (
              <a key={p.id} href={`/api/attachments/${p.id}`} target="_blank" rel="noreferrer">
                <img src={`/api/attachments/${p.id}`} alt={p.filename} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--c-border)' }} />
              </a>
            ))}
          </div>
        </div>
      )}
      {r.exchanges.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>交換</h2>
          </div>
          {r.exchanges.map((e: any) => (
            <div key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <strong className="mono">{e.exchangeNumber}</strong> <Badge tone={e.status === 'completed' ? 'success' : e.status === 'cancelled' ? '' : 'info'}>{{ open: '手配中', completed: '発送済', cancelled: '取消' }[e.status as string]}</Badge>{' '}
                {e.items.map((i: any) => `${i.sku}×${i.quantity}`).join(', ')}
              </span>
              <span>
                交換品の注文 {can('orders.read') ? <Link to={`/orders/${e.replacementOrderId}`}>{e.replacementOrderNumber}</Link> : e.replacementOrderNumber}{' '}
                {e.replacementStatus && <StatusBadge map={ORDER_STATUS} value={e.replacementStatus} />}
              </span>
            </div>
          ))}
          <p className="small muted" style={{ marginBottom: 0 }}>
            交換品は通常の注文と同じく、引当 → Wave → ピッキング → 梱包 → 出荷確定の流れで発送します。
          </p>
        </div>
      )}
      {modal === 'reject' && (
        <ConfirmDialog title="返品を却下" requireReason danger confirmLabel="却下する" message="却下すると返品可能数が元に戻ります。" onClose={() => setModal(null)} onConfirm={(reason) => act('reject', { reason }, '却下しました')} />
      )}
      {modal === 'cancel' && (
        <ConfirmDialog title="返品を取消" requireReason danger confirmLabel="取消する" message="到着前の返品を取り消します。" onClose={() => setModal(null)} onConfirm={(reason) => act('cancel', { reason }, '取消しました')} />
      )}
      {modal === 'transit' && <TransitModal onClose={() => setModal(null)} onSubmit={(b) => act('in-transit', b, '返送中にしました')} />}
      {modal === 'receive' && <ReceiveModal ret={r} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'exchange' && <ExchangeModal ret={r} onClose={() => setModal(null)} onDone={refresh} />}
    </>
  );
}

function TransitModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: { carrier?: string; trackingNumber?: string }) => Promise<void> }) {
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  return (
    <Modal
      title="返送中にする"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={() => void onSubmit({ carrier: carrier || undefined, trackingNumber: tracking || undefined }).then(onClose)}>
            保存
          </button>
        </>
      }
    >
      <Field label="返送の配送会社（任意）" htmlFor="tr-carrier">
        <input id="tr-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={40} />
      </Field>
      <Field label="返送の追跡番号（任意）" htmlFor="tr-tracking">
        <input id="tr-tracking" className="mono" value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={60} />
      </Field>
    </Modal>
  );
}

export function ReceiveModal({ ret, onClose, onDone }: { ret: any; onClose: () => void; onDone: () => void }) {
  const whs = useWarehouses();
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState(ret.warehouseId ?? '');
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(ret.items.map((i: any) => [i.id, i.requestedQty])));
  const [unexpected, setUnexpected] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!warehouseId && whs.data?.items[0]) setWarehouseId(whs.data.items[0].id);
  }, [whs.data, warehouseId]);
  return (
    <Modal
      title={`${ret.returnNumber} の到着を登録`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !warehouseId}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await post(`/returns/${ret.id}/receive`, { warehouseId, items: ret.items.map((i: any) => ({ returnItemId: i.id, receivedQty: qty[i.id] ?? 0 })), unexpected: unexpected || null, note: note || null });
                toast.success(r.discrepancies?.length || r.unexpected ? '到着を登録しました（差異を例外キューに登録）' : '到着を登録しました（在庫はまだ変わりません）');
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            到着を登録
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <p className="small">届いた数量を確認して入力してください。到着の登録だけでは在庫は増えません（検品で判定します）。</p>
      <Field label="到着した倉庫" htmlFor="rc-wh">
        <select id="rc-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          {whs.data?.items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} {w.name}
            </option>
          ))}
        </select>
      </Field>
      <table className="table">
        <thead>
          <tr>
            <th>SKU</th>
            <th className="num">申請</th>
            <th style={{ width: 120 }}>到着</th>
          </tr>
        </thead>
        <tbody>
          {ret.items.map((i: any) => (
            <tr key={i.id}>
              <td className="mono">{i.sku}</td>
              <td className="num">{i.requestedQty}</td>
              <td>
                <input type="number" aria-label={`${i.sku} の到着数量`} min={0} max={i.requestedQty} value={qty[i.id] ?? 0} onChange={(e) => setQty({ ...qty, [i.id]: Math.max(0, Math.min(i.requestedQty, Number(e.target.value) || 0)) })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="想定外の品物・申請より多い場合（任意）" htmlFor="rc-unexp" hint="記入すると例外キューに「返品差異」として登録されます">
        <input id="rc-unexp" value={unexpected} onChange={(e) => setUnexpected(e.target.value)} maxLength={300} />
      </Field>
      <Field label="到着メモ（任意）" htmlFor="rc-note">
        <input id="rc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}

interface Line {
  key: string;
  returnItemId: string;
  disposition: string;
  qty: number;
  reason: string;
  note: string;
  locationId: string;
}

/** 検品フォーム（PC）。1 明細を複数の判定に分割できる。送信 ID は成功するまで同じものを使う（再送で二重 Restock しない） */
export function InspectPanel({ ret, onDone }: { ret: any; onDone: () => void }) {
  const toast = useToast();
  const online = useOnline();
  const pending = ret.items.filter((i: any) => i.receivedQty - i.inspectedQty > 0);
  const [lines, setLines] = useState<Line[]>(() => pending.map((i: any) => ({ key: newRequestId(), returnItemId: i.id, disposition: 'restock', qty: i.receivedQty - i.inspectedQty, reason: '', note: '', locationId: '' })));
  const [requestId, setRequestId] = useState(newRequestId);
  const [photos, setPhotos] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const locs = useQuery({
    queryKey: ['locations', ret.warehouseId],
    queryFn: () => get(`/warehouses/${ret.warehouseId}/locations`),
    enabled: !!ret.warehouseId,
  });
  const pickLocs = (locs.data?.items ?? []).filter((l: any) => l.kind === 'pick' && l.active);
  const setLine = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const totalFor = (itemId: string) => lines.filter((l) => l.returnItemId === itemId).reduce((s, l) => s + (l.qty || 0), 0);
  const invalid = pending.some((i: any) => totalFor(i.id) > i.receivedQty - i.inspectedQty) || lines.some((l) => l.qty < 1 || (l.disposition !== 'restock' && !l.reason.trim()));
  if (!pending.length) return null;
  return (
    <div className="card" style={{ borderColor: 'var(--c-warning)' }}>
      <div className="card-header">
        <h2>検品・判定</h2>
        <span className="small muted">再販可（Restock）だけが販売可能在庫に戻ります</span>
      </div>
      <ErrorBox error={err} />
      {pending.map((i: any) => (
        <div key={i.id} style={{ borderBottom: '1px solid var(--c-border)', padding: '8px 0' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong className="mono">{i.sku}</strong>
            <span className={totalFor(i.id) > i.receivedQty - i.inspectedQty ? 'text-danger' : 'small muted'}>
              未検品 {i.receivedQty - i.inspectedQty} 個 / 入力 {totalFor(i.id)} 個
            </span>
          </div>
          {lines
            .filter((l) => l.returnItemId === i.id)
            .map((l) => (
              <div key={l.key} className="inline-fields" style={{ alignItems: 'flex-end' }}>
                <Field label="判定" htmlFor={`d-${l.key}`}>
                  <select id={`d-${l.key}`} value={l.disposition} onChange={(e) => setLine(l.key, { disposition: e.target.value })}>
                    {Object.entries(DISPOSITION).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="数量" htmlFor={`q-${l.key}`}>
                  <input id={`q-${l.key}`} type="number" min={1} value={l.qty} onChange={(e) => setLine(l.key, { qty: Number(e.target.value) || 0 })} style={{ width: 90 }} />
                </Field>
                {l.disposition === 'restock' ? (
                  <Field label="戻し先（任意）" htmlFor={`l-${l.key}`}>
                    <select id={`l-${l.key}`} value={l.locationId} onChange={(e) => setLine(l.key, { locationId: e.target.value })}>
                      <option value="">自動（在庫のある棚 / 既定）</option>
                      {pickLocs.map((x: any) => (
                        <option key={x.id} value={x.id}>
                          {x.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field label="理由（必須）" htmlFor={`r-${l.key}`}>
                    <input id={`r-${l.key}`} value={l.reason} onChange={(e) => setLine(l.key, { reason: e.target.value })} maxLength={300} placeholder="例: 外箱破損・キズ" />
                  </Field>
                )}
                <Field label="メモ" htmlFor={`n-${l.key}`}>
                  <input id={`n-${l.key}`} value={l.note} onChange={(e) => setLine(l.key, { note: e.target.value })} maxLength={500} />
                </Field>
                {lines.filter((x) => x.returnItemId === i.id).length > 1 && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label="この行を削除">
                    ✕
                  </button>
                )}
              </div>
            ))}
          <button
            className="btn btn-sm"
            onClick={() => setLines([...lines, { key: newRequestId(), returnItemId: i.id, disposition: 'damaged', qty: 1, reason: '', note: '', locationId: '' }])}
          >
            判定を分ける（行を追加）
          </button>
        </div>
      ))}
      <PhotoUpload returnId={ret.id} photos={photos} setPhotos={setPhotos} />
      <button
        className="btn btn-primary"
        style={{ marginTop: 10 }}
        disabled={busy || invalid || !online}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await post(`/returns/${ret.id}/inspect`, {
              clientRequestId: requestId,
              lines: lines.map((l) => ({ returnItemId: l.returnItemId, disposition: l.disposition, qty: l.qty, reason: l.reason || null, note: l.note || null, locationId: l.locationId || null })),
              attachmentIds: photos.map((p) => p.id),
            });
            toast.success(r.duplicate ? '既に登録済みの検品です' : r.status === 'completed' ? '検品を確定しました（返品完了）' : '検品を確定しました');
            setRequestId(newRequestId());
            onDone();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        検品結果を確定（在庫に反映）
      </button>
      {!online && <p className="small text-danger">オフラインでは確定できません。</p>}
    </div>
  );
}

export function PhotoUpload({ returnId, photos, setPhotos }: { returnId: string; photos: { id: string; name: string }[]; setPhotos: (p: { id: string; name: string }[]) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <label htmlFor={`photo-${returnId}`} className="btn btn-sm" style={{ cursor: 'pointer' }}>
        {busy ? 'アップロード中…' : '写真を追加（任意）'}
      </label>
      <input
        id={`photo-${returnId}`}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            const fd = new FormData();
            fd.append('file', file);
            const r = await api(`/returns/${returnId}/attachments`, { method: 'POST', body: fd });
            setPhotos([...photos, { id: r.id, name: file.name }]);
          } catch (err) {
            toast.error(err);
          } finally {
            setBusy(false);
          }
        }}
      />
      {photos.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          {photos.map((p) => (
            <img key={p.id} src={`/api/attachments/${p.id}`} alt={p.name} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
          ))}
        </div>
      )}
      <p className="small muted" style={{ margin: '4px 0 0' }}>写真はこのシステム内にのみ保存します（外部の画像認識サービスには送りません）。</p>
    </div>
  );
}

function ExchangeModal({ ret, onClose, onDone }: { ret: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<{ sku: string; quantity: number; originalOrderItemId: string | null }[]>(
    ret.items.map((i: any) => ({ sku: i.sku, quantity: i.requestedQty, originalOrderItemId: i.orderItemId })),
  );
  const [note, setNote] = useState('');
  const [allocateNow, setAllocateNow] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="交換品を手配"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !items.some((i) => i.sku.trim() && i.quantity > 0)}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await post(`/returns/${ret.id}/exchange`, { items: items.filter((i) => i.sku.trim() && i.quantity > 0), note: note || null, allocateNow });
                const alloc: Record<string, string> = { full: '全量引当済み', partial: '一部引当（残りは入荷待ち）', none: '在庫不足（欠品として例外キューへ）', skipped: '引当対象外', already: '引当済み' };
                toast.success(`交換 ${r.exchangeNumber} を作成しました（交換品の注文 ${r.replacementOrderNumber}${r.allocation ? ` / ${alloc[r.allocation] ?? r.allocation}` : ''}）`);
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            交換品の注文を作成
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <p className="small">
        交換品は「交換品の注文」（単価 0・元の注文と同じ送付先）として作成し、通常の注文と同じく 引当 → Wave → ピッキング → 梱包 → 出荷確定 で発送します。別の SKU（サイズ交換など）も指定できます。
      </p>
      {items.map((it, idx) => (
        <div key={idx} className="inline-fields">
          <Field label="SKU" htmlFor={`ex-sku-${idx}`}>
            <input id={`ex-sku-${idx}`} className="mono" value={it.sku} onChange={(e) => setItems(items.map((x, k) => (k === idx ? { ...x, sku: e.target.value } : x)))} />
          </Field>
          <Field label="数量" htmlFor={`ex-q-${idx}`}>
            <input id={`ex-q-${idx}`} type="number" min={0} value={it.quantity} onChange={(e) => setItems(items.map((x, k) => (k === idx ? { ...x, quantity: Number(e.target.value) || 0 } : x)))} style={{ width: 90 }} />
          </Field>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setItems([...items, { sku: '', quantity: 1, originalOrderItemId: null }])}>
        商品を追加
      </button>
      <Field label="メモ（任意）" htmlFor="ex-note">
        <input id="ex-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={allocateNow} onChange={(e) => setAllocateNow(e.target.checked)} /> 作成後すぐに在庫を引き当てる（通常の引当ルール）
      </label>
    </Modal>
  );
}
