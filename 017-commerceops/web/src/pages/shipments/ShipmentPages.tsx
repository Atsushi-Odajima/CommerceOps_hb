import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, api, download, get, patch, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, Pagination, StatusBadge, useOnline, useToast } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { SHIPMENT_STATUS } from '../../lib/labels';
import { feedbackError, feedbackOk } from '../../scanner/feedback';
import { ScanInput, type ScanInputHandle } from '../../scanner/ScanInput';
import { useWarehouses } from '../settings/WarehousesPage';

interface Meta {
  carriers: { value: string; label: string }[];
  defaultCarrier: string | null;
  requireTracking: boolean;
}

export function useShipmentMeta() {
  return useQuery<Meta>({ queryKey: ['shipment-meta'], queryFn: () => get('/shipments/meta'), staleTime: 300_000 });
}

const TABS = [
  { key: 'draft', label: '出荷待ち' },
  { key: 'shipped', label: '出荷済み' },
  { key: '', label: 'すべて' },
];

export default function ShipmentsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useShipmentMeta();
  const whs = useWarehouses();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'draft';
  const [warehouseId, setWarehouseId] = useState('');
  const [carrier, setCarrier] = useState('');
  const [missing, setMissing] = useState(false);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<any>(null);
  const params = new URLSearchParams({ limit: '50', offset: String(offset) });
  if (status) params.set('status', status);
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (carrier) params.set('carrier', carrier);
  if (missing && status === 'draft') params.set('missingTracking', 'true');
  if (q.trim()) params.set('q', q.trim());
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const list = useQuery({ queryKey: ['shipments', params.toString()], queryFn: () => get(`/shipments?${params}`), placeholderData: keepPreviousData });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shipments'] });
    setSelected(new Set());
  };
  const canManage = can('shipments.manage');
  const items: any[] = list.data?.items ?? [];
  const drafts = items.filter((s) => s.status === 'draft');
  const exportCsv = async (type: 'pending' | 'shipped', encoding: 'utf-8' | 'shift_jis') => {
    try {
      const p = new URLSearchParams({ type, encoding });
      if (warehouseId) p.set('warehouseId', warehouseId);
      if (type === 'shipped' && from) p.set('from', from);
      if (type === 'shipped' && to) p.set('to', to);
      await download(`/shipments/export?${p}`, `${type}.csv`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <PageHeader
        title="出荷"
        sub="梱包済みの荷物に配送会社・追跡番号を入れて出荷確定します。出荷確定で在庫が減ります（再送しても二重に減りません）。"
        actions={
          <>
            {canManage && (
              <button className="btn" onClick={() => setImportOpen(true)}>
                追跡番号 CSV 取込
              </button>
            )}
            {can('export.csv') && can('orders.read_ship_to') && (
              <button className="btn" onClick={() => void exportCsv('pending', 'utf-8')} title="送り状ソフト等への取込用（配送会社の公式形式ではありません）">
                出荷予定 CSV
              </button>
            )}
            {can('export.csv') && (
              <button className="btn" onClick={() => void exportCsv('shipped', 'utf-8')} title="EC サイトへの追跡番号反映用">
                出荷実績 CSV
              </button>
            )}
          </>
        }
      />
      {canManage && meta.data && <ScanShipPanel meta={meta.data} onDone={refresh} />}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            className={`tab ${status === t.key ? 'active' : ''}`}
            onClick={() => {
              const next = new URLSearchParams(sp);
              next.set('status', t.key);
              setSp(next);
              setOffset(0);
              setSelected(new Set());
            }}
          >
            {t.label} {t.key && list.data?.counts?.[t.key] !== undefined && <Badge tone={t.key === 'draft' ? 'warning' : ''}>{list.data.counts[t.key]}</Badge>}
          </button>
        ))}
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="sh-q">検索</label>
          <input id="sh-q" type="search" placeholder="出荷番号・注文番号・追跡番号" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        </div>
        <div className="field">
          <label htmlFor="sh-wh">倉庫</label>
          <select id="sh-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sh-carrier">配送会社</label>
          <select id="sh-carrier" value={carrier} onChange={(e) => { setCarrier(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {meta.data?.carriers.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {status !== 'draft' && (
          <>
            <div className="field">
              <label htmlFor="sh-from">出荷日（から）</label>
              <input id="sh-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
            </div>
            <div className="field">
              <label htmlFor="sh-to">出荷日（まで）</label>
              <input id="sh-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
            </div>
          </>
        )}
        {status === 'draft' && (
          <label className="check" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={missing} onChange={(e) => { setMissing(e.target.checked); setOffset(0); }} /> 追跡番号未入力のみ
          </label>
        )}
      </div>
      <ErrorBox error={list.error} />
      {canManage && selected.size > 0 && (
        <div className="alert info row" style={{ justifyContent: 'space-between' }}>
          <span>{selected.size} 件選択中</span>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                const r = await post('/shipments/bulk-confirm', { shipmentIds: [...selected] });
                setBulkResult(r);
                if (r.failed === 0) toast.success(`${r.confirmed} 件を出荷確定しました`);
                refresh();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            選択した荷物を出荷確定
          </button>
        </div>
      )}
      {bulkResult && bulkResult.failed > 0 && (
        <div className="alert warning">
          <strong>
            {bulkResult.confirmed} 件を確定、{bulkResult.failed} 件は確定できませんでした:
          </strong>
          <ul>
            {bulkResult.results
              .filter((r: any) => !r.ok)
              .map((r: any) => (
                <li key={r.shipmentId}>
                  {items.find((i) => i.id === r.shipmentId)?.shipmentNumber ?? r.shipmentId}: {r.error}
                </li>
              ))}
          </ul>
          <button className="btn btn-sm" onClick={() => setBulkResult(null)}>
            閉じる
          </button>
        </div>
      )}
      {list.isLoading ? (
        <Loading />
      ) : items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {canManage && status === 'draft' && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="すべて選択"
                      checked={drafts.length > 0 && drafts.every((d) => selected.has(d.id))}
                      onChange={(e) => setSelected(new Set(e.target.checked ? drafts.map((d) => d.id) : []))}
                    />
                  </th>
                )}
                <th>出荷番号</th>
                <th>注文</th>
                <th>箱</th>
                {items.some((i) => i.recipientName !== undefined) && <th>送付先</th>}
                <th>状態</th>
                <th>配送会社 / 追跡番号</th>
                <th>{status === 'draft' ? '' : '出荷日時'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={selected.has(s.id) ? 'selected' : ''}>
                  {canManage && status === 'draft' && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${s.shipmentNumber} を選択`}
                        checked={selected.has(s.id)}
                        onChange={(e) => {
                          const n = new Set(selected);
                          if (e.target.checked) n.add(s.id);
                          else n.delete(s.id);
                          setSelected(n);
                        }}
                      />
                    </td>
                  )}
                  <td>
                    <Link to={`/shipments/${s.id}`} className="mono">
                      {s.shipmentNumber}
                    </Link>
                    <div className="small muted">{s.warehouseCode}</div>
                  </td>
                  <td>
                    <Link to={`/orders/${s.orderId}`}>{s.orderNumber}</Link>
                    <div className="small muted">{s.channelName}</div>
                  </td>
                  <td>
                    {s.boxNo}
                    <div className="small muted">{s.units} 個</div>
                  </td>
                  {s.recipientName !== undefined && <td>{s.recipientName}</td>}
                  <td>
                    <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
                    {s.onHold && s.status === 'draft' && <Badge tone="danger">保留</Badge>}
                  </td>
                  {s.status === 'draft' && canManage && meta.data ? (
                    <InlineTracking shipment={s} meta={meta.data} onDone={refresh} />
                  ) : (
                    <>
                      <td className="small">
                        {s.carrierLabel || '—'}
                        <div className="mono">{s.noTracking ? '追跡番号なし' : s.trackingNumber ?? '—'}</div>
                      </td>
                      <td className="small">{fmtDateTime(s.shippedAt)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title={status === 'draft' ? '出荷待ちの荷物はありません' : '該当する荷物はありません'}>
          {status === 'draft' ? 'Packing Station で梱包を完了すると、ここに出荷待ちの荷物が表示されます。' : null}
        </EmptyState>
      )}
      <Pagination total={list.data?.total ?? 0} capped={list.data?.totalCapped} limit={50} offset={offset} onChange={setOffset} />
      {importOpen && <TrackingImportModal onClose={() => setImportOpen(false)} onDone={refresh} />}
    </>
  );
}

function InlineTracking({ shipment, meta, onDone }: { shipment: any; meta: Meta; onDone: () => void }) {
  const toast = useToast();
  const [carrier, setCarrier] = useState<string>(shipment.carrier ?? meta.defaultCarrier ?? '');
  const [tracking, setTracking] = useState<string>(shipment.trackingNumber ?? '');
  const [noTracking, setNoTracking] = useState<boolean>(shipment.noTracking);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCarrier(shipment.carrier ?? meta.defaultCarrier ?? '');
    setTracking(shipment.trackingNumber ?? '');
    setNoTracking(shipment.noTracking);
  }, [shipment.carrier, shipment.trackingNumber, shipment.noTracking, meta.defaultCarrier]);
  const dirty = carrier !== (shipment.carrier ?? '') || tracking !== (shipment.trackingNumber ?? '') || noTracking !== shipment.noTracking;
  const save = async () => {
    if (!dirty) return;
    await patch(`/shipments/${shipment.id}`, { carrier: carrier || null, trackingNumber: noTracking ? null : tracking || null, noTracking });
  };
  return (
    <>
      <td>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <select aria-label={`${shipment.shipmentNumber} の配送会社`} value={carrier} onChange={(e) => setCarrier(e.target.value)} style={{ minWidth: 110 }}>
            <option value="">配送会社</option>
            {meta.carriers.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            aria-label={`${shipment.shipmentNumber} の追跡番号`}
            className="mono"
            placeholder={noTracking ? '追跡番号なし' : '追跡番号'}
            value={tracking}
            disabled={noTracking}
            onChange={(e) => setTracking(e.target.value)}
            style={{ minWidth: 150 }}
          />
        </div>
        <label className="check small" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={noTracking} onChange={(e) => setNoTracking(e.target.checked)} /> 追跡番号なし
        </label>
      </td>
      <td>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <button
            className="btn btn-sm"
            disabled={busy || !dirty}
            onClick={async () => {
              setBusy(true);
              try {
                await save();
                toast.success('保存しました');
                onDone();
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || !carrier || (!tracking && !noTracking && meta.requireTracking) || shipment.onHold}
            onClick={async () => {
              setBusy(true);
              try {
                await save();
                const r = await post(`/shipments/${shipment.id}/confirm`, {});
                toast.success(r.alreadyShipped ? `${shipment.shipmentNumber} は出荷確定済みです` : `${shipment.shipmentNumber} を出荷確定しました`);
                onDone();
              } catch (e) {
                toast.error(e);
                onDone();
              } finally {
                setBusy(false);
              }
            }}
          >
            出荷確定
          </button>
        </div>
      </td>
    </>
  );
}

/** scan 出荷: ① 荷物コード（出荷作業票の SH- バーコード）→ ② 送り状の追跡番号バーコード → 自動で出荷確定 */
function ScanShipPanel({ meta, onDone }: { meta: Meta; onDone: () => void }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [carrier, setCarrier] = useState(meta.defaultCarrier ?? '');
  const [shipmentCode, setShipmentCode] = useState<string | null>(null);
  const [noTracking, setNoTracking] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<ScanInputHandle>(null);
  const finish = async (code: string, tracking: string | null) => {
    setBusy(true);
    try {
      const r = await post('/shipments/scan-confirm', { shipmentCode: code, trackingCode: tracking ?? undefined, carrier: carrier || undefined, noTracking: tracking === null });
      feedbackOk();
      setFeedback({ kind: r.alreadyShipped ? 'warn' : 'ok', text: r.alreadyShipped ? `${r.shipmentNumber} は出荷確定済みです` : `${r.shipmentNumber} を出荷確定しました` });
      onDone();
    } catch (e) {
      feedbackError();
      setFeedback({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setShipmentCode(null);
      setBusy(false);
      ref.current?.focus();
    }
  };
  if (!open) {
    return (
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setOpen(true)}>
          scan で出荷確定（ハンディスキャナ / カメラ）
        </button>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-header">
        <h2>scan で出荷確定</h2>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          閉じる
        </button>
      </div>
      <div className="inline-fields">
        <Field label="配送会社" htmlFor="scan-carrier">
          <select id="scan-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            <option value="">荷物に設定済みの配送会社</option>
            {meta.carriers.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="check" style={{ alignSelf: 'center' }}>
          <input type="checkbox" checked={noTracking} onChange={(e) => setNoTracking(e.target.checked)} /> 追跡番号なしの配送
        </label>
      </div>
      <ScanInput
        ref={ref}
        id="scan-ship"
        label={shipmentCode ? `② ${shipmentCode} の送り状（追跡番号）を読む` : '① 荷物コード（SH-）を読む'}
        placeholder={shipmentCode ? '追跡番号' : '例: SH-000123'}
        disabled={busy || !online}
        onScan={(code) => {
          if (!shipmentCode) {
            if (!/^SH-\d+$/i.test(code.trim())) {
              feedbackError();
              setFeedback({ kind: 'error', text: `荷物コード（SH-）ではありません: ${code}` });
              return;
            }
            if (noTracking) {
              void finish(code, null);
              return;
            }
            setShipmentCode(code.trim().toUpperCase());
            setFeedback({ kind: 'ok', text: `${code.trim().toUpperCase()} を読みました。続けて追跡番号を読んでください` });
            return;
          }
          void finish(shipmentCode, code);
        }}
      />
      {shipmentCode && (
        <button className="btn btn-sm btn-ghost" onClick={() => setShipmentCode(null)} style={{ marginTop: 6 }}>
          ① からやり直す
        </button>
      )}
      {feedback && (
        <div className={`scan-feedback ${feedback.kind}`} role="alert" aria-live="assertive">
          {feedback.text}
        </div>
      )}
    </div>
  );
}

function TrackingImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState('utf-8');
  const [confirm, setConfirm] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('encoding', encoding);
      fd.append('dryRun', String(dryRun));
      fd.append('confirm', String(confirm));
      fd.append('file', file!);
      const r = await api('/shipments/tracking-import', { method: 'POST', body: fd });
      setResult(r);
      if (!dryRun) onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const ACTION: Record<string, { label: string; tone: 'success' | 'danger' | '' | 'info' | 'warning' }> = {
    update: { label: result?.dryRun ? '更新予定' : '更新', tone: 'info' },
    confirmed: { label: '出荷確定', tone: 'success' },
    unchanged: { label: '変更なし', tone: '' },
    error: { label: 'エラー', tone: 'danger' },
  };
  return (
    <Modal
      title="追跡番号 CSV 取込"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            閉じる
          </button>
          <button className="btn" disabled={!file || busy} onClick={() => void run(true)}>
            検証する
          </button>
          <button className="btn btn-primary" disabled={!file || busy || !result?.dryRun || result.valid === 0} onClick={() => void run(false)} title="先に「検証する」で内容を確認してください">
            取り込む（{result?.dryRun ? result.valid : 0} 件）
          </button>
        </>
      }
    >
      <p className="small">
        列: <code>出荷番号</code>（または <code>注文番号</code> + <code>箱番号</code>）・<code>配送会社</code>・<code>追跡番号</code>・<code>出荷日</code>（任意）。
        出荷済みの荷物の追跡番号は上書きしません（荷物の画面で理由を入力して訂正）。
      </p>
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="CSV ファイル" htmlFor="ti-file">
          <input id="ti-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
        </Field>
        <Field label="文字コード" htmlFor="ti-enc">
          <select id="ti-enc" value={encoding} onChange={(e) => { setEncoding(e.target.value); setResult(null); }}>
            <option value="utf-8">UTF-8</option>
            <option value="shift_jis">Shift_JIS</option>
          </select>
        </Field>
        <label className="check" style={{ alignSelf: 'center' }}>
          <input type="checkbox" checked={confirm} onChange={(e) => { setConfirm(e.target.checked); setResult(null); }} /> 追跡番号を入れた荷物を出荷確定する
        </label>
      </div>
      {result && (
        <>
          <div className={`alert ${result.errors ? 'warning' : 'success'}`}>
            {result.dryRun ? '検証結果' : '取込結果'}: 全 {result.total} 行 / 有効 {result.valid} / 更新 {result.updated} / 出荷確定 {result.confirmed} / 変更なし {result.unchanged} / エラー {result.errors}
          </div>
          <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>行</th>
                  <th>出荷番号</th>
                  <th>追跡番号</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r: any) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td className="mono">{r.shipmentNumber ?? '—'}</td>
                    <td className="mono">{r.trackingNumber ?? '—'}</td>
                    <td>
                      <Badge tone={ACTION[r.action]!.tone}>{ACTION[r.action]!.label}</Badge> <span className="small">{r.message}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

export function ShipmentDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useShipmentMeta();
  const q = useQuery({ queryKey: ['shipment', id], queryFn: () => get(`/shipments/${id}`) });
  const [form, setForm] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) {
      setForm({
        carrier: q.data.carrier ?? meta.data?.defaultCarrier ?? '',
        service: q.data.service ?? '',
        trackingNumber: q.data.trackingNumber ?? '',
        noTracking: q.data.noTracking,
        weightG: q.data.weightG ?? '',
        packageType: q.data.packageType ?? '',
      });
    }
  }, [q.data, meta.data?.defaultCarrier]);
  if (q.isLoading || !form) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const s = q.data;
  const draft = s.status === 'draft';
  const canManage = can('shipments.manage');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shipment', id] });
    void qc.invalidateQueries({ queryKey: ['shipments'] });
  };
  const save = async () => {
    const body: Record<string, unknown> = draft
      ? {
          carrier: form.carrier || null,
          service: form.service || null,
          trackingNumber: form.noTracking ? null : form.trackingNumber || null,
          noTracking: form.noTracking,
          weightG: form.weightG === '' ? null : Number(form.weightG),
          packageType: form.packageType || null,
        }
      : { carrier: form.carrier || null, trackingNumber: form.noTracking ? null : form.trackingNumber || null, noTracking: form.noTracking, reason };
    await patch(`/shipments/${id}`, body);
  };
  return (
    <>
      <PageHeader
        title={
          <span className="row">
            荷物 <span className="mono">{s.shipmentNumber}</span> <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
          </span>
        }
        sub={
          <>
            注文 <Link to={`/orders/${s.orderId}`}>{s.orderNumber}</Link> / {s.channelName} / 出荷作業 {s.fulfillmentNumber} / 倉庫 {s.warehouseCode} / 箱 {s.boxNo}
          </>
        }
        actions={
          <Link className="btn" to={`/print/shipment/${s.id}`} target="_blank">
            作業票を印刷
          </Link>
        }
      />
      <ErrorBox error={err} />
      {s.onHold && draft && <div className="alert danger">この注文は保留中のため出荷確定できません。</div>}
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>配送情報</h2>
          </div>
          <div className="inline-fields">
            <Field label="配送会社" htmlFor="sd-carrier">
              <select id="sd-carrier" value={form.carrier} disabled={!canManage} onChange={(e) => setForm({ ...form, carrier: e.target.value })}>
                <option value="">未選択</option>
                {meta.data?.carriers.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="配送方法" htmlFor="sd-service">
              <input id="sd-service" value={form.service} disabled={!canManage || !draft} onChange={(e) => setForm({ ...form, service: e.target.value })} maxLength={60} />
            </Field>
          </div>
          <Field label="追跡番号" htmlFor="sd-tracking" hint="ハイフン・空白は自動で除去します">
            <input id="sd-tracking" className="mono" value={form.trackingNumber} disabled={!canManage || form.noTracking} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} maxLength={60} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.noTracking} disabled={!canManage} onChange={(e) => setForm({ ...form, noTracking: e.target.checked })} /> 追跡番号なし
          </label>
          {draft && (
            <div className="inline-fields" style={{ marginTop: 10 }}>
              <Field label="重量（g）" htmlFor="sd-weight">
                <input id="sd-weight" type="number" min={0} value={form.weightG} disabled={!canManage} onChange={(e) => setForm({ ...form, weightG: e.target.value })} />
              </Field>
              <Field label="荷姿" htmlFor="sd-pkg">
                <input id="sd-pkg" value={form.packageType} disabled={!canManage} onChange={(e) => setForm({ ...form, packageType: e.target.value })} maxLength={40} placeholder="例: 60サイズ" />
              </Field>
            </div>
          )}
          {!draft && canManage && s.status === 'shipped' && (
            <Field label="訂正理由（出荷済みの訂正に必須）" htmlFor="sd-reason">
              <input id="sd-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
          )}
          {canManage && s.status !== 'cancelled' && (
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn"
                disabled={busy || (!draft && !reason.trim())}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await save();
                    toast.success(draft ? '保存しました' : '追跡番号を訂正しました（監査ログに記録）');
                    setReason('');
                    refresh();
                  } catch (e) {
                    setErr(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {draft ? '保存' : '訂正を保存'}
              </button>
              {draft && (
                <button
                  className="btn btn-primary"
                  disabled={busy || s.onHold}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      await save();
                      await post(`/shipments/${id}/confirm`, {});
                      toast.success('出荷確定しました（在庫を減算）');
                      refresh();
                    } catch (e) {
                      setErr(e);
                      refresh();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  保存して出荷確定
                </button>
              )}
            </div>
          )}
          {s.status === 'shipped' && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              出荷日時 {fmtDateTime(s.shippedAt)}（{s.confirmedBy ?? '—'}）。出荷済みの荷物は取消できません（返品で処理します）。
            </p>
          )}
        </div>
        <div>
          <div className="card">
            <div className="card-header">
              <h2>内容</h2>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>商品</th>
                  <th className="num">数量</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((i: any) => (
                  <tr key={i.id}>
                    <td className="mono">{i.sku}</td>
                    <td>
                      {i.name}
                      {i.variant ? ` / ${i.variant}` : ''}
                    </td>
                    <td className="num">{i.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.shipTo && (
            <div className="card">
              <div className="card-header">
                <h2>送付先</h2>
              </div>
              <div style={{ fontWeight: 700 }}>{s.shipTo.name} 様</div>
              <div className="small">
                〒{s.shipTo.postalCode} {s.shipTo.prefecture}
                {s.shipTo.city}
                {s.shipTo.address1} {s.shipTo.address2}
              </div>
              {s.shipTo.phone && <div className="small">TEL {s.shipTo.phone}</div>}
            </div>
          )}
          {s.siblings.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>同じ注文の他の荷物</h2>
              </div>
              {s.siblings.map((x: any) => (
                <div key={x.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <Link to={`/shipments/${x.id}`} className="mono">
                    {x.shipmentNumber}
                  </Link>
                  <span>
                    箱 {x.boxNo} <StatusBadge map={SHIPMENT_STATUS} value={x.status} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {s.history.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>履歴</h2>
          </div>
          <ul className="timeline">
            {s.history.map((h: any, i: number) => (
              <li key={i}>
                {fmtDateTime(h.at)} {h.actor ?? 'システム'} — {h.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
