import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get, newRequestId, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, Pagination, useToast } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { useWarehouses } from '../settings/WarehousesPage';

export default function InventoryPage() {
  const { can } = useAuth();
  const whs = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<any>(null);
  const [modal, setModal] = useState<'receipt' | 'import' | null>(null);
  const limit = 50;
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), filter });
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (query) params.set('q', query);
  const list = useQuery({ queryKey: ['inventory', params.toString()], queryFn: () => get(`/inventory?${params}`), placeholderData: keepPreviousData });
  return (
    <div className="card">
      <div className="card-header">
        <h2>在庫一覧</h2>
        {can('inventory.adjust') && (
          <div className="actions">
            <button className="btn btn-sm" onClick={() => setModal('import')}>
              在庫CSV取込
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setModal('receipt')}>
              入荷を登録
            </button>
          </div>
        )}
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(q.trim());
        }}
      >
        <div className="field">
          <label htmlFor="inv-wh">倉庫</label>
          <select id="inv-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="inv-q">SKU・商品名</label>
          <input id="inv-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="inv-filter">表示</label>
          <select id="inv-filter" value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }}>
            <option value="all">すべて</option>
            <option value="available">引当可能あり</option>
            <option value="shortage">未引当の需要あり（欠品）</option>
            <option value="held">調査中あり</option>
            <option value="nonsellable">返品保留・破損あり</option>
          </select>
        </div>
        <button className="btn">検索</button>
      </form>
      <p className="small muted">Available（引当可能）= OnHand − Allocated（引当済）− 調査中（Short Pick 等）。返品保留・破損ロケーションの数量は含みません。</p>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.items.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>倉庫</th>
                  <th className="num">OnHand</th>
                  <th className="num">Allocated</th>
                  <th className="num">調査中</th>
                  <th className="num">Available</th>
                  <th className="num">返品保留 / 破損</th>
                  <th className="num">未引当の需要</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r: any) => (
                  <tr key={`${r.productId}-${r.warehouseId}`}>
                    <td>
                      <code>{r.sku}</code>
                      <div className="small muted">
                        {r.name} {r.variant}
                      </div>
                    </td>
                    <td>{r.warehouseCode}</td>
                    <td className="num">{fmtNum(r.onHand)}</td>
                    <td className="num">{fmtNum(r.allocated)}</td>
                    <td className="num">{r.held ? <Badge tone="danger">{r.held}</Badge> : 0}</td>
                    <td className="num">
                      <strong>{fmtNum(r.available)}</strong>
                    </td>
                    <td className="num small">
                      {r.quarantine} / {r.damaged}
                    </td>
                    <td className="num">{r.unallocatedDemand > 0 ? <Badge tone="warning">{r.unallocatedDemand}</Badge> : '—'}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => setDetail(r)}>
                        ロケーション別
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={limit} total={list.data.total} onChange={setOffset} />
        </>
      ) : (
        <EmptyState title="在庫データがありません">入荷の登録、または在庫CSV取込で初期在庫を登録してください。</EmptyState>
      )}
      {detail && <BalanceModal row={detail} onClose={() => setDetail(null)} />}
      {modal === 'receipt' && <ReceiptModal onClose={() => setModal(null)} />}
      {modal === 'import' && <InventoryImportModal onClose={() => setModal(null)} />}
    </div>
  );
}

function BalanceModal({ row, onClose }: { row: any; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const bal = useQuery({ queryKey: ['balances', row.productId, row.warehouseId], queryFn: () => get(`/inventory/balances?productId=${row.productId}&warehouseId=${row.warehouseId}`) });
  const [action, setAction] = useState<{ kind: 'adjust' | 'transfer' | 'held'; balance: any } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['balances', row.productId, row.warehouseId] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
  };
  return (
    <Modal title={`${row.sku} — ${row.warehouseCode}`} onClose={onClose} wide>
      <ErrorBox error={bal.error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>ロケーション</th>
              <th className="num">OnHand</th>
              <th className="num">Allocated</th>
              <th className="num">調査中</th>
              <th className="num">Available</th>
              {can('inventory.adjust') && <th />}
            </tr>
          </thead>
          <tbody>
            {bal.data?.items.map((b: any) => (
              <tr key={b.id}>
                <td className="mono">
                  {b.locationCode} {b.kind !== 'pick' && <Badge tone="warning">{b.kind === 'damaged' ? '破損' : '返品保留'}</Badge>}
                </td>
                <td className="num">{b.onHand}</td>
                <td className="num">{b.allocated}</td>
                <td className="num">{b.held}</td>
                <td className="num">{b.available}</td>
                {can('inventory.adjust') && (
                  <td className="right nowrap">
                    <button className="btn btn-sm" onClick={() => setAction({ kind: 'adjust', balance: b })}>
                      調整
                    </button>{' '}
                    <button className="btn btn-sm" onClick={() => setAction({ kind: 'transfer', balance: b })}>
                      移動
                    </button>{' '}
                    {b.held > 0 && (
                      <button className="btn btn-sm btn-warning" onClick={() => setAction({ kind: 'held', balance: b })}>
                        調査中を解消
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {action?.kind === 'adjust' && <AdjustForm row={row} balance={action.balance} onDone={() => { setAction(null); refresh(); toast.success('調整しました'); }} />}
      {action?.kind === 'transfer' && <TransferForm row={row} balance={action.balance} onDone={() => { setAction(null); refresh(); toast.success('移動しました'); }} />}
      {action?.kind === 'held' && <HeldForm balance={action.balance} onDone={() => { setAction(null); refresh(); toast.success('調査中在庫を解消しました'); }} />}
    </Modal>
  );
}

function AdjustForm({ row, balance, onDone }: { row: any; balance: any; onDone: () => void }) {
  const [qty, setQty] = useState(balance.onHand);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [reqId] = useState(newRequestId);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>在庫調整（{balance.locationCode}）</h3>
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="実在庫数（OnHand）" htmlFor="adj-qty" hint={`引当済 ${balance.allocated} + 調査中 ${balance.held} を下回る値にはできません`}>
          <input id="adj-qty" type="number" min={0} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
        </Field>
        <Field label="理由（必須）" htmlFor="adj-reason">
          <input id="adj-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="棚卸差異 など" />
        </Field>
      </div>
      <button
        className="btn btn-primary btn-sm"
        disabled={!reason.trim()}
        onClick={async () => {
          try {
            await post('/inventory/adjustments', { locationId: balance.locationId, productId: row.productId, mode: 'set', qty, reason, requestId: reqId });
            onDone();
          } catch (e) {
            setErr(e);
          }
        }}
      >
        調整を記録
      </button>
    </div>
  );
}

function TransferForm({ row, balance, onDone }: { row: any; balance: any; onDone: () => void }) {
  const locs = useQuery({ queryKey: ['locations', balance.warehouseId], queryFn: () => get(`/warehouses/${balance.warehouseId}/locations`) });
  const [to, setTo] = useState('');
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState<unknown>(null);
  const [reqId] = useState(newRequestId);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>ロケーション移動（{balance.locationCode} から）</h3>
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="移動先" htmlFor="tr-to">
          <select id="tr-to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">選択</option>
            {locs.data?.items
              .filter((l: any) => l.id !== balance.locationId)
              .map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.code}（{l.kind === 'pick' ? '販売可能' : l.kind === 'damaged' ? '破損' : '返品保留'}）
                </option>
              ))}
          </select>
        </Field>
        <Field label={`数量（最大 ${balance.available}）`} htmlFor="tr-qty">
          <input id="tr-qty" type="number" min={1} max={balance.available} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
        </Field>
      </div>
      <button
        className="btn btn-primary btn-sm"
        disabled={!to}
        onClick={async () => {
          try {
            await post('/inventory/transfers', { fromLocationId: balance.locationId, toLocationId: to, productId: row.productId, qty, requestId: reqId });
            onDone();
          } catch (e) {
            setErr(e);
          }
        }}
      >
        移動を記録
      </button>
    </div>
  );
}

function HeldForm({ balance, onDone }: { balance: any; onDone: () => void }) {
  const [qty, setQty] = useState(balance.held);
  const [err, setErr] = useState<unknown>(null);
  const [reqId] = useState(newRequestId);
  const go = async (resolution: 'loss' | 'found') => {
    try {
      await post('/inventory/held/resolve', { balanceId: balance.id, qty, resolution, requestId: reqId });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>調査中在庫の解消（{balance.locationCode}）</h3>
      <p className="small muted">Short Pick などで「現物が見つからない」とされた数量です。棚を確認して結果を記録してください。</p>
      <ErrorBox error={err} />
      <Field label={`数量（最大 ${balance.held}）`} htmlFor="held-qty">
        <input id="held-qty" type="number" min={1} max={balance.held} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
      </Field>
      <div className="row">
        <button className="btn btn-danger btn-sm" onClick={() => void go('loss')}>
          紛失を確定（OnHand を減らす）
        </button>
        <button className="btn btn-sm" onClick={() => void go('found')}>
          見つかった（引当可能に戻す）
        </button>
      </div>
    </div>
  );
}

function ReceiptModal({ onClose }: { onClose: () => void }) {
  const whs = useWarehouses();
  const qc = useQueryClient();
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState<unknown>(null);
  const [reqId, setReqId] = useState(newRequestId);
  const locs = useQuery({ queryKey: ['locations', warehouseId], queryFn: () => get(`/warehouses/${warehouseId}/locations?kind=pick`), enabled: !!warehouseId });
  return (
    <Modal
      title="入荷を登録（簡易）"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            閉じる
          </button>
          <button
            className="btn btn-primary"
            disabled={!locationId || !sku.trim() || qty < 1}
            onClick={async () => {
              setErr(null);
              try {
                const p = await get(`/products/lookup?code=${encodeURIComponent(sku.trim())}`);
                const r = await post('/inventory/receipts', { locationId, productId: p.product.id, qty, reason: '入荷', requestId: reqId });
                toast.success(r.applied ? `${p.product.sku} を ${qty} 個入荷しました` : '登録済みです（二重登録を防止しました）');
                setSku('');
                setReqId(newRequestId());
                void qc.invalidateQueries({ queryKey: ['inventory'] });
              } catch (e) {
                setErr(e);
              }
            }}
          >
            登録
          </button>
        </>
      }
    >
      <p className="small muted">仕入発注・検品を伴う本格的な入荷管理は StockPilot（#013）の領域です。ここでは出荷に必要な在庫数の登録のみ行います。</p>
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="倉庫" htmlFor="rc-wh">
          <select id="rc-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLocationId(''); }}>
            <option value="">選択</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ロケーション" htmlFor="rc-loc">
          <select id="rc-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!warehouseId}>
            <option value="">選択</option>
            {locs.data?.items.map((l: any) => (
              <option key={l.id} value={l.id}>
                {l.code}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="SKU またはバーコード" htmlFor="rc-sku">
          <input id="rc-sku" type="text" value={sku} onChange={(e) => setSku(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="数量" htmlFor="rc-qty">
          <input id="rc-qty" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
        </Field>
      </div>
    </Modal>
  );
}

function InventoryImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState('set');
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setErr(null);
    const fd = new FormData();
    fd.append('mode', mode);
    fd.append('dryRun', String(dryRun));
    fd.append('file', file);
    try {
      const r = await api('/inventory/import', { method: 'POST', body: fd });
      setResult(r);
      if (!dryRun && r.ok) {
        toast.success(`在庫を ${r.changed} 件反映しました`);
        void qc.invalidateQueries({ queryKey: ['inventory'] });
      }
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title="在庫 CSV 取込" onClose={onClose} footer={<button className="btn" onClick={onClose}>閉じる</button>}>
      <p className="small">
        列: <code>warehouse_code,location_code,sku,qty</code>。全行が正しい場合のみ反映します（テンプレート: inventory_template.csv）。
      </p>
      <ErrorBox error={err} />
      <Field label="ファイル" htmlFor="ii-file">
        <input id="ii-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
      </Field>
      <Field label="方法" htmlFor="ii-mode">
        <select id="ii-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="set">実数で上書き（初期在庫・棚卸結果）</option>
          <option value="add">加算（入荷）</option>
        </select>
      </Field>
      <div className="row">
        <button className="btn" disabled={!file} onClick={() => void run(true)}>
          検証のみ
        </button>
        <button className="btn btn-primary" disabled={!file} onClick={() => void run(false)}>
          反映する
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 10 }} className={`alert ${result.ok ? 'success' : 'danger'}`}>
          {result.ok ? (result.dryRun ? `問題ありません（${result.rows}行）` : `反映しました（${result.changed}件変更）`) : `${result.errorCount}件のエラー（反映していません）`}
          {!result.ok && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {result.errors.slice(0, 15).map((e: any, i: number) => (
                <li key={i}>
                  {e.line}行目: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

export function MovementsPage() {
  const [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: ['movements', offset], queryFn: () => get(`/inventory/movements?limit=50&offset=${offset}`), placeholderData: keepPreviousData });
  const TYPE: Record<string, string> = {
    receipt: '入荷',
    adjust: '調整',
    ship: '出荷',
    restock: '返品再入庫',
    return_damaged: '返品（破損）',
    return_quarantine: '返品（保留）',
    discard: '廃棄記録',
    hold: '調査中へ',
    unhold: '調査中解除',
    hold_loss: '紛失確定',
    transfer_out: '移動（出）',
    transfer_in: '移動（入）',
    restore: '復元',
  };
  return (
    <div className="card">
      <h2>在庫履歴（OnHand・調査中の変動）</h2>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>種別</th>
                  <th>SKU</th>
                  <th>倉庫 / ロケーション</th>
                  <th className="num">OnHand</th>
                  <th className="num">調査中</th>
                  <th>理由</th>
                  <th>実行者</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((m: any) => (
                  <tr key={m.id}>
                    <td className="small">{fmtDateTime(m.createdAt)}</td>
                    <td>
                      <Badge>{TYPE[m.type] ?? m.type}</Badge>
                    </td>
                    <td>
                      <code>{m.sku}</code>
                    </td>
                    <td className="mono small">
                      {m.warehouseCode} / {m.locationCode}
                    </td>
                    <td className="num">{m.onHandDelta > 0 ? `+${m.onHandDelta}` : m.onHandDelta}</td>
                    <td className="num">{m.heldDelta ? (m.heldDelta > 0 ? `+${m.heldDelta}` : m.heldDelta) : ''}</td>
                    <td className="small">{m.reason}</td>
                    <td className="small">{m.actor ?? 'システム'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={50} total={list.data?.total ?? 0} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
