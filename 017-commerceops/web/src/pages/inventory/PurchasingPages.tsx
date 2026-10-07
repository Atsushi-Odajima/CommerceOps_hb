/**
 * 仕入先・発注・補充・棚卸の画面（StockPilot #013 から統合。デザインは既存部品の組み合わせのみ）
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, newRequestId, post, put } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { useWarehouses } from '../settings/WarehousesPage';

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '処理に失敗しました';
}

function useSuppliers() {
  return useQuery({ queryKey: ['suppliers'], queryFn: () => get<{ items: any[] }>('/suppliers?includeInactive=true') });
}

function useProducts() {
  return useQuery({ queryKey: ['products-all'], queryFn: () => get<{ items: any[] }>('/products?limit=200') });
}

// ---------------------------------------------------------------- 仕入先
export function SuppliersPage() {
  const { can } = useAuth();
  const list = useSuppliers();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>仕入先</h2>
        {can('purchasing.manage') && (
          <button className="btn btn-primary" onClick={() => setEdit({ code: '', name: '', contact: '', leadTimeDays: '', note: '', active: true })}>
            仕入先を追加
          </button>
        )}
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : list.data?.items.length === 0 ? <EmptyState title="仕入先がありません" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>コード</th>
                <th>名称</th>
                <th>連絡先</th>
                <th className="num">リードタイム（日）</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td>
                  <td>{s.name}</td>
                  <td className="small">{s.contact}</td>
                  <td className="num">{s.leadTimeDays ?? '—'}</td>
                  <td>{s.active ? <Badge tone="success">有効</Badge> : <Badge>無効</Badge>}</td>
                  <td>{can('purchasing.manage') && <button className="btn btn-sm" onClick={() => setEdit({ ...s, leadTimeDays: s.leadTimeDays ?? '' })}>編集</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <SupplierForm initial={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SupplierForm({ initial, onClose }: { initial: any; onClose: () => void }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const save = async () => {
    setErr(null);
    const body = { code: f.code, name: f.name, contact: f.contact || null, note: f.note || null, leadTimeDays: f.leadTimeDays === '' ? null : Number(f.leadTimeDays), active: f.active };
    try {
      if (f.id) await put(`/suppliers/${f.id}`, body);
      else await post('/suppliers', body);
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      toast.success('保存しました');
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal title={f.id ? '仕入先を編集' : '仕入先を追加'} onClose={onClose} footer={<button className="btn btn-primary" onClick={() => void save()}>保存</button>}>
      {err && <div className="alert alert-error">{err}</div>}
      <Field label="コード"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      <Field label="名称"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="連絡先"><input value={f.contact ?? ''} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field>
      <Field label="リードタイム（日）"><input type="number" min={0} value={f.leadTimeDays} onChange={(e) => setF({ ...f, leadTimeDays: e.target.value })} /></Field>
      <Field label="メモ"><textarea value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 有効</label>
    </Modal>
  );
}

// ---------------------------------------------------------------- 発注
export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState('open');
  const list = useQuery({ queryKey: ['purchase-orders', status], queryFn: () => get(`/purchase-orders?limit=100${status ? `&status=${status}` : ''}`) });
  const [creating, setCreating] = useState(false);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>発注</h2>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態">
            <option value="open">入荷待ちあり</option>
            <option value="draft">下書き</option>
            <option value="placed">発注済み（すべて）</option>
            <option value="cancelled">取消</option>
            <option value="">すべて</option>
          </select>
          {can('purchasing.manage') && <button className="btn btn-primary" onClick={() => setCreating(true)}>発注を作成</button>}
        </div>
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : list.data?.items.length === 0 ? <EmptyState title="該当する発注はありません" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>発注番号</th>
                <th>状態</th>
                <th>仕入先</th>
                <th>倉庫</th>
                <th>希望納期</th>
                <th className="num">発注数</th>
                <th className="num">入荷済み</th>
                <th className="num">発注残</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((p: any) => (
                <tr key={p.id}>
                  <td><Link to={`/inventory/purchase-orders/${p.id}`} className="mono">{p.poNumber}</Link></td>
                  <td><Badge>{p.displayStatusLabel}</Badge></td>
                  <td>{p.supplierName}</td>
                  <td className="mono">{p.warehouseCode}</td>
                  <td className="small">{p.expectedDate ? String(p.expectedDate).slice(0, 10) : '—'}</td>
                  <td className="num">{p.orderedQty}</td>
                  <td className="num">{p.receivedQty}</td>
                  <td className="num">{p.openQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <PoForm onClose={() => setCreating(false)} />}
    </div>
  );
}

function PoForm({ onClose }: { onClose: () => void }) {
  const suppliers = useSuppliers();
  const whs = useWarehouses();
  const products = useProducts();
  const navigate = useNavigate();
  const [f, setF] = useState({ supplierId: '', warehouseId: '', expectedDate: '', note: '' });
  const [lines, setLines] = useState([{ productId: '', qty: '1' }]);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      const r = await post('/purchase-orders', {
        supplierId: f.supplierId,
        warehouseId: f.warehouseId,
        expectedDate: f.expectedDate || null,
        note: f.note || null,
        lines: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, qty: Number(l.qty) })),
      });
      navigate(`/inventory/purchase-orders/${r.id}`);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal title="発注を作成（下書き）" onClose={onClose} wide footer={<button className="btn btn-primary" onClick={() => void save()}>下書きを保存</button>}>
      {err && <div className="alert alert-error">{err}</div>}
      <Field label="仕入先">
        <select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
          <option value="">選択してください</option>
          {suppliers.data?.items.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
        </select>
      </Field>
      <Field label="入荷する倉庫">
        <select value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
          <option value="">選択してください</option>
          {whs.data?.items.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}
        </select>
      </Field>
      <Field label="希望納期"><input type="date" value={f.expectedDate} onChange={(e) => setF({ ...f, expectedDate: e.target.value })} /></Field>
      <Field label="メモ"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <h3>明細（入荷先は倉庫の既定ロケーション。入荷時に変更できます）</h3>
      {lines.map((l, i) => (
        <div className="row" key={i}>
          <select value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))} aria-label={`商品${i + 1}`}>
            <option value="">商品を選択</option>
            {products.data?.items.map((p: any) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}
          </select>
          <input type="number" min={1} style={{ width: 100 }} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label={`数量${i + 1}`} />
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setLines([...lines, { productId: '', qty: '1' }])}>行を追加</button>
    </Modal>
  );
}

export function PurchaseOrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const po = useQuery({ queryKey: ['purchase-order', id], queryFn: () => get(`/purchase-orders/${id}`) });
  const locs = useQuery({ queryKey: ['locations', po.data?.warehouseId], queryFn: () => get(`/warehouses/${po.data.warehouseId}/locations`), enabled: !!po.data?.warehouseId });
  const [recv, setRecv] = useState<Record<string, { qty: string; locationId: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['purchase-order', id] });
      await qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.success(msg);
      setRecv({});
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  if (po.isLoading) return <Loading />;
  if (po.error) return <ErrorBox error={po.error} />;
  const p = po.data;
  const canManage = can('purchasing.manage');
  const canReceive = canManage || can('inventory.adjust');
  const receiveLines = Object.entries(recv)
    .filter(([, v]) => Number(v.qty) > 0)
    .map(([lineId, v]) => ({ lineId, qty: Number(v.qty), locationId: v.locationId || null }));
  return (
    <div className="card">
      <p><Link to="/inventory/purchase-orders">← 発注一覧</Link></p>
      <h2>
        発注 <span className="mono">{p.poNumber}</span> <Badge>{p.displayStatusLabel}</Badge>
      </h2>
      <p className="small">
        仕入先: {p.supplier.code} {p.supplier.name} ／ 倉庫: {p.warehouseCode} ／ 希望納期: {p.expectedDate ?? '—'} ／ 作成: {fmtDateTime(p.createdAt)}
        {p.note ? ` ／ メモ: ${p.note}` : ''}
      </p>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>SKU</th>
              <th>商品</th>
              <th>入荷先</th>
              <th className="num">発注数</th>
              <th className="num">入荷済み</th>
              <th className="num">打切り</th>
              <th className="num">発注残</th>
              {p.status === 'placed' && canReceive && <th>今回の入荷</th>}
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.lineNo}</td>
                <td className="mono">{l.sku}</td>
                <td>{l.productName}</td>
                <td className="mono">{l.locationCode}</td>
                <td className="num">{l.orderedQty}</td>
                <td className="num">{l.receivedQty}</td>
                <td className="num" title={l.closeReason ?? ''}>{l.closedQty}</td>
                <td className="num">{l.openQty}</td>
                {p.status === 'placed' && canReceive && (
                  <td>
                    {l.openQty > 0 && (
                      <div className="row">
                        <input type="number" min={0} max={l.openQty} style={{ width: 80 }} aria-label={`明細${l.lineNo}の入荷数`} value={recv[l.id]?.qty ?? ''} onChange={(e) => setRecv({ ...recv, [l.id]: { qty: e.target.value, locationId: recv[l.id]?.locationId ?? '' } })} />
                        <select aria-label={`明細${l.lineNo}の入荷先`} value={recv[l.id]?.locationId ?? ''} onChange={(e) => setRecv({ ...recv, [l.id]: { qty: recv[l.id]?.qty ?? '', locationId: e.target.value } })}>
                          <option value="">{l.locationCode}（既定）</option>
                          {locs.data?.items.map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}
                        </select>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {p.status === 'draft' && canManage && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => post(`/purchase-orders/${id}/place`), '発注済みにしました')}>発注済みにする</button>
        )}
        {p.status === 'placed' && canReceive && (
          <button className="btn btn-primary" disabled={busy || receiveLines.length === 0} onClick={() => void act(() => post(`/purchase-orders/${id}/receive`, { requestId: newRequestId(), lines: receiveLines }), '入荷しました')}>入荷を登録</button>
        )}
        {p.status === 'placed' && canManage && p.lines.some((l: any) => l.openQty > 0) && (
          <button className="btn" disabled={busy} onClick={() => { const reason = window.prompt('未入荷分を打ち切る理由'); if (reason) void act(() => post(`/purchase-orders/${id}/close`, { reason }), '未入荷分を打ち切りました'); }}>未入荷分を打ち切る</button>
        )}
        {(p.status === 'draft' || (p.status === 'placed' && p.lines.every((l: any) => l.receivedQty === 0))) && canManage && (
          <button className="btn btn-danger" disabled={busy} onClick={() => { if (window.confirm('この発注を取り消しますか？')) void act(() => post(`/purchase-orders/${id}/cancel`), '取り消しました'); }}>取消</button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 補充
export function ReplenishmentPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const list = useQuery({ queryKey: ['replenishment', all], queryFn: () => get<{ items: any[] }>(`/replenishment?all=${all}`) });
  const whs = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [settingsFor, setSettingsFor] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const make = async () => {
    setErr(null);
    const items = (list.data?.items ?? []).filter((s) => Number(picked[s.productId] ?? 0) > 0).map((s) => ({ productId: s.productId, qty: Number(picked[s.productId]), basisP: s.p }));
    try {
      const r = await post('/replenishment/drafts', { warehouseId, items });
      toast.success(`発注の下書きを ${r.created.length} 件作成しました`);
      setPicked({});
      await qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    } catch (e) {
      setErr(errMsg(e));
      await qc.invalidateQueries({ queryKey: ['replenishment'] });
    }
  };
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>補充候補</h2>
        <div className="row">
          <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> 補充設定のある全商品を表示</label>
          {can('purchasing.manage') && <button className="btn" onClick={() => setSettingsFor({})}>補充設定を追加・編集</button>}
        </div>
      </div>
      <p className="small">
        補充判断数量 P = 引当可能在庫 + 発注残 − 未引当の受注。P が発注点以下なら、目標在庫まで（発注単位・最小発注数量で切り上げ）を推奨します。
      </p>
      <ErrorBox error={list.error} />
      {err && <div className="alert alert-error">{err}</div>}
      {list.isLoading ? <Loading /> : list.data?.items.length === 0 ? <EmptyState title="補充が必要な商品はありません" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>商品</th>
                <th>仕入先</th>
                <th className="num">引当可能</th>
                <th className="num">発注残</th>
                <th className="num">未引当受注</th>
                <th className="num">P</th>
                <th className="num">発注点 / 目標</th>
                <th className="num">推奨</th>
                <th>注意</th>
                {can('purchasing.manage') && <th>発注数</th>}
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((s) => (
                <tr key={s.productId}>
                  <td className="mono"><button className="btn btn-ghost btn-sm" onClick={() => setSettingsFor(s)}>{s.sku}</button></td>
                  <td>{s.name}</td>
                  <td>{s.supplierName ?? '（未設定）'}</td>
                  <td className="num">{s.usable}</td>
                  <td className="num">{s.openPo}</td>
                  <td className="num">{s.demand}</td>
                  <td className="num">{s.p}</td>
                  <td className="num">{s.reorderPoint} / {s.targetStock}</td>
                  <td className="num">{s.recommended}</td>
                  <td className="small">
                    {s.belowSafety && <Badge tone="danger">安全在庫割れ</Badge>} {s.overduePo > 0 && <Badge tone="warning">納期超過 {s.overduePo}</Badge>}
                  </td>
                  {can('purchasing.manage') && (
                    <td>
                      <input type="number" min={0} style={{ width: 80 }} aria-label={`${s.sku}の発注数`} placeholder={String(s.recommended)} value={picked[s.productId] ?? ''} onChange={(e) => setPicked({ ...picked, [s.productId]: e.target.value })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can('purchasing.manage') && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => setPicked(Object.fromEntries((list.data?.items ?? []).filter((s) => s.recommended > 0).map((s) => [s.productId, String(s.recommended)])))}>推奨数を入れる</button>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="入荷する倉庫">
            <option value="">入荷する倉庫を選択</option>
            {whs.data?.items.map((w: any) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!warehouseId || !Object.values(picked).some((v) => Number(v) > 0)} onClick={() => void make()}>仕入先ごとに発注の下書きを作成</button>
        </div>
      )}
      {settingsFor && <ReplenishmentForm initial={settingsFor} onClose={() => setSettingsFor(null)} />}
    </div>
  );
}

function ReplenishmentForm({ initial, onClose }: { initial: any; onClose: () => void }) {
  const suppliers = useSuppliers();
  const products = useProducts();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    productId: initial.productId ?? '',
    supplierId: initial.supplierId ?? '',
    safetyStock: String(initial.safetyStock ?? 0),
    reorderPoint: String(initial.reorderPoint ?? ''),
    targetStock: String(initial.targetStock ?? ''),
    orderMultiple: String(initial.orderMultiple ?? 1),
    minOrderQty: String(initial.minOrderQty ?? 0),
    leadTimeDays: initial.leadTimeDays == null ? '' : String(initial.leadTimeDays),
  });
  const [err, setErr] = useState<string | null>(null);
  const save = async (remove = false) => {
    setErr(null);
    try {
      await put(`/products/${f.productId}/replenishment`, {
        settings: remove
          ? null
          : {
              supplierId: f.supplierId || null,
              safetyStock: Number(f.safetyStock),
              reorderPoint: Number(f.reorderPoint),
              targetStock: Number(f.targetStock),
              orderMultiple: Number(f.orderMultiple),
              minOrderQty: Number(f.minOrderQty),
              leadTimeDays: f.leadTimeDays === '' ? null : Number(f.leadTimeDays),
            },
      });
      await qc.invalidateQueries({ queryKey: ['replenishment'] });
      toast.success(remove ? '補充設定を削除しました' : '補充設定を保存しました');
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const num = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Modal
      title="補充設定"
      onClose={onClose}
      footer={
        <>
          {initial.productId && <button className="btn btn-danger" onClick={() => void save(true)}>設定を削除</button>}
          <button className="btn btn-primary" disabled={!f.productId} onClick={() => void save()}>保存</button>
        </>
      }
    >
      {err && <div className="alert alert-error">{err}</div>}
      <Field label="商品">
        <select value={f.productId} disabled={!!initial.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
          <option value="">選択してください</option>
          {products.data?.items.map((p: any) => <option key={p.id} value={p.id}>{p.sku} {p.name}</option>)}
        </select>
      </Field>
      <Field label="仕入先">
        <select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
          <option value="">（未設定）</option>
          {suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
        </select>
      </Field>
      {num('safetyStock', '安全在庫')}
      {num('reorderPoint', '発注点', '安全在庫 ≦ 発注点 ＜ 目標在庫')}
      {num('targetStock', '目標在庫')}
      {num('orderMultiple', '発注単位')}
      {num('minOrderQty', '最小発注数量')}
      {num('leadTimeDays', 'リードタイム（日）', '空欄なら仕入先の設定')}
    </Modal>
  );
}

// ---------------------------------------------------------------- 棚卸
export function StocktakesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['stocktakes'], queryFn: () => get<{ items: any[] }>('/stocktakes?limit=100') });
  const whs = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [locationId, setLocationId] = useState('');
  const locs = useQuery({ queryKey: ['locations', warehouseId], queryFn: () => get(`/warehouses/${warehouseId}/locations`), enabled: !!warehouseId });
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setErr(null);
    try {
      const r = await post('/stocktakes', { locationId });
      navigate(`/inventory/stocktakes/${r.id}`);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <div className="card">
      <h2>棚卸</h2>
      <p className="small">1回の棚卸で1つのロケーションを数えます。確定時に、開始後に在庫が動いていたら確定できません（数え直してください）。</p>
      {can('stocktake.count') && (
        <div className="row">
          <select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLocationId(''); }} aria-label="倉庫">
            <option value="">倉庫を選択</option>
            {whs.data?.items.map((w: any) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="ロケーション" disabled={!warehouseId}>
            <option value="">ロケーションを選択</option>
            {locs.data?.items.map((l: any) => <option key={l.id} value={l.id}>{l.code}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!locationId} onClick={() => void start()}>棚卸を開始</button>
        </div>
      )}
      {err && <div className="alert alert-error">{err}</div>}
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : list.data?.items.length === 0 ? <EmptyState title="棚卸はまだありません" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>開始</th>
                <th>倉庫 / ロケーション</th>
                <th>状態</th>
                <th className="num">行数</th>
                <th className="num">未計数</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/inventory/stocktakes/${s.id}`}>{fmtDateTime(s.createdAt)}</Link></td>
                  <td className="mono">{s.warehouseCode} / {s.locationCode}</td>
                  <td><Badge>{s.statusLabel}</Badge></td>
                  <td className="num">{s.lineCount}</td>
                  <td className="num">{s.uncounted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ST_LABEL: Record<string, string> = { counting: '計数中', review: '差異確認', confirmed: '確定', cancelled: '中止' };

export function StocktakeDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const st = useQuery({ queryKey: ['stocktake', id], queryFn: () => get(`/stocktakes/${id}`) });
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { counted: string; reason: string }>>({});
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setErr(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['stocktake', id] });
      await qc.invalidateQueries({ queryKey: ['stocktakes'] });
      if (msg) toast.success(msg);
    } catch (e) {
      setErr(errMsg(e));
      await qc.invalidateQueries({ queryKey: ['stocktake', id] });
    }
  };
  if (st.isLoading) return <Loading />;
  if (st.error) return <ErrorBox error={st.error} />;
  const s = st.data;
  const editable = (s.status === 'counting' || s.status === 'review') && can('stocktake.count');
  const saveLine = (l: any) => {
    const d = draft[l.id] ?? { counted: l.countedQty == null ? '' : String(l.countedQty), reason: l.reason ?? '' };
    return act(async () => {
      await put(`/stocktakes/${id}/lines/${l.id}`, { countedQty: d.counted === '' ? null : Number(d.counted), reason: d.reason || null, version: l.version });
      setDraft((x) => {
        const n = { ...x };
        delete n[l.id];
        return n;
      });
    });
  };
  return (
    <div className="card">
      <p><Link to="/inventory/stocktakes">← 棚卸一覧</Link></p>
      <h2>
        棚卸 <span className="mono">{s.warehouseCode} / {s.locationCode}</span> <Badge>{ST_LABEL[s.status]}</Badge>
      </h2>
      {err && <div className="alert alert-error">{err}</div>}
      {editable && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => post(`/stocktakes/${id}/lines`, { code }), '商品を追加しました').then(() => setCode('')); }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="SKU またはバーコードで商品を追加" aria-label="追加する商品" />
          <button className="btn" disabled={!code}>追加</button>
        </form>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>商品</th>
              <th className="num">理論在庫</th>
              <th className="num">実数</th>
              <th className="num">差異</th>
              <th>理由</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l: any) => {
              const d = draft[l.id] ?? { counted: l.countedQty == null ? '' : String(l.countedQty), reason: l.reason ?? '' };
              return (
                <tr key={l.id}>
                  <td className="mono">{l.sku}</td>
                  <td>{l.name}</td>
                  <td className="num">{l.expectedQty}</td>
                  <td className="num">
                    {editable ? (
                      <input type="number" min={0} style={{ width: 90 }} aria-label={`${l.sku}の実数`} value={d.counted} placeholder="未計数" onChange={(e) => setDraft({ ...draft, [l.id]: { ...d, counted: e.target.value } })} />
                    ) : (l.countedQty ?? '未計数')}
                  </td>
                  <td className="num">{l.variance == null ? '' : l.variance > 0 ? `+${l.variance}` : l.variance}</td>
                  <td>
                    {editable ? (
                      <input value={d.reason} aria-label={`${l.sku}の差異理由`} onChange={(e) => setDraft({ ...draft, [l.id]: { ...d, reason: e.target.value } })} />
                    ) : l.reason}
                  </td>
                  {editable && <td><button className="btn btn-sm" disabled={!draft[l.id]} onClick={() => void saveLine(l)}>保存</button></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {s.status === 'counting' && can('stocktake.count') && <button className="btn btn-primary" onClick={() => void act(() => post(`/stocktakes/${id}/review`), '差異確認に進みました')}>差異確認へ</button>}
        {s.status === 'review' && can('stocktake.confirm') && <button className="btn btn-primary" onClick={() => void act(() => post(`/stocktakes/${id}/confirm`), '棚卸を確定し、差異を在庫に反映しました')}>確定して在庫に反映</button>}
        {(s.status === 'counting' || s.status === 'review') && can('stocktake.confirm') && (
          <button className="btn btn-danger" onClick={() => { if (window.confirm('棚卸を中止しますか？（実数は在庫に反映されません）')) void act(() => post(`/stocktakes/${id}/cancel`), '中止しました'); }}>中止</button>
        )}
      </div>
    </div>
  );
}
