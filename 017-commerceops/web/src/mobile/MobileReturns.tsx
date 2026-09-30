import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, newRequestId, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Badge, ErrorBox, Loading, StatusBadge, useOnline, useToast } from '../components/ui';
import { DISPOSITION, RETURN_REASON, RETURN_STATUS } from '../lib/labels';
import { PhotoUpload } from '../pages/returns/ReturnPages';
import { useWarehouses } from '../pages/settings/WarehousesPage';
import { feedbackDone, feedbackError, feedbackOk } from '../scanner/feedback';
import { ScanInput } from '../scanner/ScanInput';
import { MobileShell } from './MobileShell';

/** スマホ: 返品の到着 scan・検品。確定操作はオンラインのみ（オフラインで Restock しない） */
export default function MobileReturns() {
  const [returnId, setReturnId] = useState<string | null>(null);
  const [choices, setChoices] = useState<any[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const online = useOnline();
  const lookup = async (code: string) => {
    setErr(null);
    setChoices(null);
    try {
      const r = await get(`/returns/lookup?code=${encodeURIComponent(code)}`);
      const open = r.items.filter((x: any) => !['completed', 'rejected', 'cancelled'].includes(x.status));
      if (!r.items.length) throw new Error(`「${code}」に該当する返品はありません`);
      feedbackOk();
      if (open.length === 1) setReturnId(open[0].id);
      else setChoices(r.items);
    } catch (e) {
      feedbackError();
      setErr(e);
    }
  };
  return (
    <MobileShell title="返品の到着・検品" back={returnId ? undefined : '/m'}>
      {!online && <div className="alert warning">オフラインです。到着登録・検品の確定はできません。</div>}
      {returnId ? (
        <ReturnWork returnId={returnId} onBack={() => setReturnId(null)} />
      ) : (
        <>
          <div className="big-card">
            <ScanInput id="rt-scan" label="返品受領票の RMA コード（RT-）または注文番号" onScan={(c) => void lookup(c)} />
          </div>
          <ErrorBox error={err} />
          {choices?.map((c) => (
            <button key={c.id} className="big-card btn-block" style={{ textAlign: 'left', display: 'block', width: '100%' }} onClick={() => setReturnId(c.id)}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="mono">{c.returnNumber}</strong>
                <StatusBadge map={RETURN_STATUS} value={c.status} />
              </div>
              <div className="small muted">注文 {c.orderNumber}</div>
            </button>
          ))}
        </>
      )}
    </MobileShell>
  );
}

function ReturnWork({ returnId, onBack }: { returnId: string; onBack: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['return', returnId], queryFn: () => get(`/returns/${returnId}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['return', returnId] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const r = q.data;
  const receivable = ['requested', 'authorized', 'in_transit'].includes(r.status);
  const inspectable = ['received', 'inspecting'].includes(r.status);
  return (
    <>
      <div className="big-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong className="mono" style={{ fontSize: '1.2rem' }}>
            {r.returnNumber}
          </strong>
          <StatusBadge map={RETURN_STATUS} value={r.status} />
        </div>
        <div className="small muted">
          注文 {r.orderNumber} / {RETURN_REASON[r.reasonCode]}
        </div>
        <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={onBack}>
          別の返品を読む
        </button>
      </div>
      {receivable && can('returns.receive') && <MobileReceive ret={r} onDone={refresh} />}
      {receivable && !can('returns.receive') && <div className="alert info">到着登録の権限がありません。</div>}
      {inspectable && can('returns.inspect') && <MobileInspect key={r.items.map((i: any) => `${i.id}:${i.inspectedQty}`).join(',')} ret={r} onDone={refresh} />}
      {inspectable && !can('returns.inspect') && <div className="alert info">到着済みです。検品（再販可・破損の判定）は管理者が行います。</div>}
      {r.status === 'completed' && (
        <div className="alert success">
          検品完了。{r.inspections.map((x: any) => `${x.sku} ${DISPOSITION[x.disposition]!.label} ×${x.qty}`).join(' / ')}
        </div>
      )}
    </>
  );
}

function MobileReceive({ ret, onDone }: { ret: any; onDone: () => void }) {
  const whs = useWarehouses();
  const toast = useToast();
  const online = useOnline();
  const [warehouseId, setWarehouseId] = useState(ret.warehouseId ?? '');
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(ret.items.map((i: any) => [i.id, i.requestedQty])));
  const [unexpected, setUnexpected] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!warehouseId && whs.data?.items[0]) setWarehouseId(whs.data.items[0].id);
  }, [whs.data, warehouseId]);
  return (
    <div className="big-card">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>到着を登録</h2>
      <p className="small muted">届いた数を数えて入力します。到着の登録だけでは在庫は増えません。</p>
      <ErrorBox error={err} />
      <label htmlFor="mr-wh">到着した倉庫</label>
      <select id="mr-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
        {whs.data?.items.map((w) => (
          <option key={w.id} value={w.id}>
            {w.code} {w.name}
          </option>
        ))}
      </select>
      {ret.items.map((i: any) => (
        <div key={i.id} className="row" style={{ justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--c-border)' }}>
          <div>
            <div className="mono" style={{ fontWeight: 700 }}>
              {i.sku}
            </div>
            <div className="small muted">申請 {i.requestedQty} 個</div>
          </div>
          <Stepper value={qty[i.id] ?? 0} max={i.requestedQty} onChange={(v) => setQty({ ...qty, [i.id]: v })} label={`${i.sku} の到着数量`} />
        </div>
      ))}
      <label htmlFor="mr-unexp" style={{ marginTop: 8 }}>
        想定外の品物（任意）
      </label>
      <input id="mr-unexp" value={unexpected} onChange={(e) => setUnexpected(e.target.value)} maxLength={300} placeholder="例: 別の商品が同梱" />
      <button
        className="btn btn-primary btn-lg btn-block"
        style={{ marginTop: 10 }}
        disabled={busy || !online || !warehouseId}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await post(`/returns/${ret.id}/receive`, { warehouseId, items: ret.items.map((i: any) => ({ returnItemId: i.id, receivedQty: qty[i.id] ?? 0 })), unexpected: unexpected || null });
            feedbackDone();
            toast.success('到着を登録しました');
            onDone();
          } catch (e) {
            feedbackError();
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        到着を登録
      </button>
    </div>
  );
}

function Stepper({ value, max, onChange, label }: { value: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }} role="group" aria-label={label}>
      <button className="btn btn-lg" style={{ minWidth: 48 }} onClick={() => onChange(Math.max(0, value - 1))} aria-label="1 減らす">
        −
      </button>
      <span style={{ minWidth: 36, textAlign: 'center', fontSize: '1.4rem', fontWeight: 800 }} aria-live="polite">
        {value}
      </span>
      <button className="btn btn-lg" style={{ minWidth: 48 }} onClick={() => onChange(Math.min(max, value + 1))} aria-label="1 増やす">
        ＋
      </button>
    </div>
  );
}

/** スマホ検品: 明細ごとに判定と数量を選ぶ（1 明細 = 1 判定。分割は PC 画面で） */
function MobileInspect({ ret, onDone }: { ret: any; onDone: () => void }) {
  const toast = useToast();
  const online = useOnline();
  const pending = ret.items.filter((i: any) => i.receivedQty - i.inspectedQty > 0);
  const [state, setState] = useState<Record<string, { disposition: string; qty: number; reason: string }>>(
    Object.fromEntries(pending.map((i: any) => [i.id, { disposition: 'restock', qty: i.receivedQty - i.inspectedQty, reason: '' }])),
  );
  const [requestId, setRequestId] = useState(newRequestId);
  const [photos, setPhotos] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const invalid = pending.some((i: any) => {
    const s = state[i.id]!;
    return s.qty < 1 || (s.disposition !== 'restock' && !s.reason.trim());
  });
  return (
    <div className="big-card">
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>検品</h2>
      <p className="small muted">「再販可」だけが販売可能在庫に戻ります。破損・保留・廃棄は理由を入力してください。</p>
      <ErrorBox error={err} />
      {pending.map((i: any) => {
        const s = state[i.id]!;
        const set = (p: Partial<typeof s>) => setState({ ...state, [i.id]: { ...s, ...p } });
        return (
          <div key={i.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--c-border)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong className="mono">{i.sku}</strong>
              <span className="small muted">未検品 {i.receivedQty - i.inspectedQty} 個</span>
            </div>
            <div className="grid grid-2" style={{ gap: 6, marginTop: 6 }}>
              {Object.entries(DISPOSITION).map(([k, v]) => (
                <button key={k} className={`btn btn-lg ${s.disposition === k ? 'btn-primary' : ''}`} aria-pressed={s.disposition === k} onClick={() => set({ disposition: k })}>
                  {v.label.replace(/（.*）/, '')}
                </button>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span>数量</span>
              <Stepper value={s.qty} max={i.receivedQty - i.inspectedQty} onChange={(v) => set({ qty: v })} label={`${i.sku} の検品数量`} />
            </div>
            {s.disposition !== 'restock' && (
              <>
                <label htmlFor={`mi-r-${i.id}`}>理由（必須）</label>
                <input id={`mi-r-${i.id}`} value={s.reason} onChange={(e) => set({ reason: e.target.value })} maxLength={300} placeholder="例: 外箱破損・キズ" />
              </>
            )}
            <div className="small muted" style={{ marginTop: 4 }}>
              <Badge tone={DISPOSITION[s.disposition]!.tone}>{DISPOSITION[s.disposition]!.label}</Badge> {DISPOSITION[s.disposition]!.help}
            </div>
          </div>
        );
      })}
      <PhotoUpload returnId={ret.id} photos={photos} setPhotos={setPhotos} />
      <button
        className="btn btn-primary btn-lg btn-block"
        style={{ marginTop: 10 }}
        disabled={busy || invalid || !online}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await post(`/returns/${ret.id}/inspect`, {
              clientRequestId: requestId,
              lines: pending.map((i: any) => ({ returnItemId: i.id, disposition: state[i.id]!.disposition, qty: state[i.id]!.qty, reason: state[i.id]!.reason || null })),
              attachmentIds: photos.map((p) => p.id),
            });
            feedbackDone();
            toast.success('検品を確定しました');
            setRequestId(newRequestId());
            onDone();
          } catch (e) {
            feedbackError();
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        検品結果を確定
      </button>
    </div>
  );
}
