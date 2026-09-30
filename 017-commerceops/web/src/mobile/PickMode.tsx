import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, get, newRequestId, post } from '../api/client';
import { ErrorBox, Field, Loading, Modal, useOnline, useToast } from '../components/ui';
import { SHORT_REASON } from '../lib/labels';
import { enqueue, flushQueue, listQueued } from '../offline/queue';
import { feedbackDone, feedbackError, feedbackOk } from '../scanner/feedback';
import { ScanInput, type InputMethod, type ScanInputHandle } from '../scanner/ScanInput';
import { MobileShell, useUnsyncedCount } from './MobileShell';
import { matchesCode } from '../lib/gtin';

interface Group {
  key: string;
  locationId: string;
  locationCode: string;
  locationBarcode: string;
  zone: string | null;
  productId: string;
  sku: string;
  name: string;
  variant: string | null;
  imageUrl: string | null;
  barcodes: string[];
  required: number;
  picked: number;
  short: number;
  remaining: number;
  status: 'open' | 'done' | 'short';
  fulfillments: { number: string; qty: number }[];
}

type Feedback = { kind: 'ok' | 'error' | 'warn'; text: string } | null;

export default function PickMode() {
  const { taskId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const unsynced = useUnsyncedCount(taskId);
  const task = useQuery({ queryKey: ['pick-task', taskId], queryFn: () => get(`/pick-tasks/${taskId}`) });
  const [offlinePicked, setOfflinePicked] = useState<Record<string, number>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirmedLocation, setConfirmedLocation] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [modal, setModal] = useState<'qty' | 'short' | 'list' | 'history' | null>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<ScanInputHandle>(null);

  // 未同期分をローカル表示に反映（オフライン下書き）
  const refreshOffline = useCallback(async () => {
    const q = await listQueued(taskId);
    const m: Record<string, number> = {};
    for (const s of q) if (s.kind === 'pick') m[`${s.payload.locationId}:${s.payload.productId}`] = (m[`${s.payload.locationId}:${s.payload.productId}`] ?? 0) + Number(s.payload.qty ?? 1);
    setOfflinePicked(m);
  }, [taskId]);
  useEffect(() => {
    void refreshOffline();
    const h = () => void refreshOffline();
    window.addEventListener('offline-queue-changed', h);
    return () => window.removeEventListener('offline-queue-changed', h);
  }, [refreshOffline]);
  useEffect(() => {
    if (online && unsynced > 0) {
      void flushQueue().then((results) => {
        const rejected = results.filter((r) => !r.ok);
        if (results.length) toast.info(`未同期の読取を送信しました（${results.length - rejected.length} 件反映${rejected.length ? ` / ${rejected.length} 件はサーバー判断で拒否: ${rejected[0]!.message}` : ''}）`);
        void qc.invalidateQueries({ queryKey: ['pick-task', taskId] });
      });
    }
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups: Group[] = useMemo(
    () =>
      (task.data?.groups ?? []).map((g: Group) => {
        const extra = offlinePicked[g.key] ?? 0;
        const remaining = Math.max(0, g.remaining - extra);
        return { ...g, picked: g.picked + extra, remaining, status: remaining > 0 ? 'open' : g.short > 0 ? 'short' : 'done' };
      }),
    [task.data, offlinePicked],
  );
  const current = groups.find((g) => g.key === selectedKey && g.remaining > 0) ?? groups.find((g) => g.remaining > 0);
  const step: 'location' | 'item' = current && confirmedLocation === current.locationId ? 'item' : 'location';
  const totals = groups.reduce((a, g) => ({ required: a.required + g.required, done: a.done + g.picked + g.short }), { required: 0, done: 0 });

  const show = (kind: 'ok' | 'error' | 'warn', text: string) => {
    setFeedback({ kind, text });
    if (kind === 'error') feedbackError();
    else feedbackOk();
  };

  const refetch = () => qc.invalidateQueries({ queryKey: ['pick-task', taskId] });

  const handleApiError = (e: unknown) => {
    if (e instanceof ApiError && (e.code === 'NOT_ASSIGNED' || e.code === 'TASK_CLOSED')) {
      show('error', e.message);
      setTimeout(() => nav('/m/tasks'), 2500);
      return;
    }
    show('error', e instanceof Error ? e.message : String(e));
  };

  const submitPick = async (code: string, method: InputMethod, qty = 1) => {
    if (!current) return;
    const clientEventId = newRequestId();
    const payload = { locationId: current.locationId, productId: current.productId, code, qty, inputMethod: method };
    const offlineAccept = async () => {
      if (!matchesCode(current.barcodes, code)) {
        show('error', `違う商品です（正: ${current.sku}）※オフライン判定`);
        return;
      }
      if (qty > current.remaining) {
        show('error', `必要数を超えています（残り ${current.remaining}）`);
        return;
      }
      await enqueue({ clientEventId, kind: 'pick', taskId: taskId!, payload, createdAt: new Date().toISOString() });
      show('warn', `${current.sku} × ${qty} を未同期で記録しました（再接続時に送信）`);
    };
    if (!online) return offlineAccept();
    setBusy(true);
    try {
      const r = await post(`/pick-tasks/${taskId}/pick`, { clientEventId, locationId: current.locationId, code, qty, inputMethod: method });
      if (r.taskCompleted) {
        feedbackDone();
        setFeedback({ kind: 'ok', text: 'タスクのピッキングが完了しました' });
      } else if (r.group?.remaining === 0) {
        show('ok', `${current.sku} 完了。次のロケーションへ`);
      } else {
        show('ok', `${current.sku} OK（残り ${r.group?.remaining ?? '?'}）`);
      }
      await refetch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) show('error', e.message);
      else if (e instanceof ApiError && e.status === 0) await offlineAccept();
      else handleApiError(e);
    } finally {
      setBusy(false);
      scanRef.current?.focus();
    }
  };

  const onScan = async (code: string, method: InputMethod) => {
    if (!current || busy) return;
    if (step === 'location') {
      const clientEventId = newRequestId();
      const localOk = code === current.locationBarcode || code === current.locationCode;
      if (!online) {
        if (!localOk) return show('error', `ロケーションが違います（正: ${current.locationCode}）`);
        await enqueue({ clientEventId, kind: 'location', taskId: taskId!, payload: { code, expectedLocationId: current.locationId, inputMethod: method }, createdAt: new Date().toISOString() });
        setConfirmedLocation(current.locationId);
        return show('ok', `ロケーション ${current.locationCode} OK`);
      }
      setBusy(true);
      try {
        await post(`/pick-tasks/${taskId}/scan-location`, { clientEventId, code, expectedLocationId: current.locationId, inputMethod: method });
        setConfirmedLocation(current.locationId);
        show('ok', `ロケーション ${current.locationCode} OK。商品を読んでください`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 0 && localOk) {
          setConfirmedLocation(current.locationId);
          show('warn', `ロケーション ${current.locationCode} OK（オフライン判定）`);
        } else if (e instanceof ApiError && e.status === 422) show('error', e.message);
        else handleApiError(e);
      } finally {
        setBusy(false);
        scanRef.current?.focus();
      }
      return;
    }
    await submitPick(code, method, 1);
  };

  if (task.isLoading) return <MobileShell title="Pick" back="/m/tasks"><Loading /></MobileShell>;
  if (task.error) return <MobileShell title="Pick" back="/m/tasks"><ErrorBox error={task.error} /></MobileShell>;
  const t = task.data;
  const completed = !current;

  return (
    <MobileShell
      title={`${t.taskNumber}`}
      back="/m/tasks"
      right={
        <button className="btn btn-sm" style={{ color: '#1f4f8f' }} onClick={() => setModal('list')}>
          一覧
        </button>
      }
    >
      <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span>
          {t.waveNumber} {t.waveLabel} / {t.warehouseCode}
        </span>
        <span>
          {totals.done} / {totals.required} 個
        </span>
      </div>
      <div className="progress" style={{ marginBottom: 10 }} aria-label="進捗">
        <span style={{ width: `${totals.required ? (100 * totals.done) / totals.required : 0}%` }} />
      </div>
      {unsynced > 0 && <div className="unsynced" role="status">未同期 {unsynced} 件（端末に保存中。通信が戻ると自動送信）</div>}
      {feedback && (
        <div className={`scan-feedback ${feedback.kind}`} role="alert" aria-live="assertive">
          {feedback.text}
        </div>
      )}
      {completed ? (
        <div className="big-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.2rem' }}>✓</div>
          <h2>このタスクのピッキングは完了です</h2>
          <p className="muted">{unsynced > 0 ? '未同期の読取があります。通信が戻るまでこの画面を閉じないでください。' : 'ピック済みの商品を梱包場所へ運んでください。'}</p>
          <Link className="btn btn-primary btn-lg btn-block" to="/m/tasks">
            次のタスクへ
          </Link>
        </div>
      ) : (
        <>
          <div className="big-card">
            <div className="small muted">ロケーション {current!.zone ? `（ゾーン ${current!.zone}）` : ''}</div>
            <div className="loc-code">{current!.locationCode}</div>
            <hr className="divider" style={{ margin: '10px 0' }} />
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              {current!.imageUrl && <img src={current!.imageUrl} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontWeight: 700 }}>
                  {current!.sku}
                </div>
                <div>{current!.name}</div>
                {current!.variant && <div className="small muted">{current!.variant}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="qty-big">{current!.remaining}</div>
                <div className="small muted">残り / 必要 {current!.required}</div>
              </div>
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {current!.fulfillments.map((f) => `${f.number}×${f.qty}`).join('  ')}
            </div>
          </div>
          <div className="big-card">
            <div className="row" style={{ gap: 6, marginBottom: 8 }}>
              <span className={`badge ${step === 'location' ? 'primary' : 'success'}`}>① ロケーション{step === 'item' ? ' ✓' : ''}</span>
              <span className={`badge ${step === 'item' ? 'primary' : ''}`}>② 商品（1 scan = 1 個）</span>
            </div>
            <ScanInput
              ref={scanRef}
              id="pick-scan"
              label={step === 'location' ? `ロケーション ${current!.locationCode} のバーコードを読む` : `${current!.sku} の商品バーコードを読む`}
              onScan={(c, m) => void onScan(c, m)}
              disabled={busy}
            />
            <div className="grid grid-2" style={{ gap: 8, marginTop: 10 }}>
              <button className="btn btn-lg" disabled={step !== 'item' || busy} onClick={() => setModal('qty')}>
                数量をまとめて入力
              </button>
              <button className="btn btn-lg btn-danger" disabled={!online || busy} onClick={() => setModal('short')} title={online ? '' : 'Short はオンラインでのみ登録できます'}>
                棚にない（Short）
              </button>
            </div>
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn btn-sm" onClick={() => setModal('history')}>
          読取履歴・訂正
        </button>
        <button
          className="btn btn-sm"
          disabled={!online}
          onClick={async () => {
            try {
              await post(`/pick-tasks/${taskId}/release`);
              nav('/m/tasks');
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          担当を外す（中断）
        </button>
      </div>
      {modal === 'qty' && current && (
        <QtyModal
          group={current}
          onClose={() => setModal(null)}
          onSubmit={(qty) => {
            setModal(null);
            void submitPick(current.sku, 'manual', qty);
          }}
        />
      )}
      {modal === 'short' && current && (
        <ShortModal
          taskId={taskId!}
          group={current}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            setModal(null);
            show('warn', msg);
            void refetch();
          }}
        />
      )}
      {modal === 'list' && (
        <Modal title="ピック一覧（ロケーション順）" onClose={() => setModal(null)}>
          {groups.map((g) => (
            <button
              key={g.key}
              className="btn btn-block"
              style={{ justifyContent: 'space-between', marginBottom: 6, background: g.key === current?.key ? 'var(--c-primary-50)' : undefined }}
              disabled={g.remaining === 0}
              onClick={() => {
                setSelectedKey(g.key);
                setConfirmedLocation(null);
                setModal(null);
              }}
            >
              <span className="mono">{g.locationCode}</span>
              <span className="mono">{g.sku}</span>
              <span>{g.status === 'done' ? '✓' : g.status === 'short' ? `Short ${g.short}` : `${g.picked}/${g.required}`}</span>
            </button>
          ))}
        </Modal>
      )}
      {modal === 'history' && <HistoryModal taskId={taskId!} events={t.recentEvents} onClose={() => setModal(null)} onDone={() => void refetch()} online={online} />}
    </MobileShell>
  );
}

function QtyModal({ group, onClose, onSubmit }: { group: Group; onClose: () => void; onSubmit: (qty: number) => void }) {
  const [qty, setQty] = useState(group.remaining);
  const [confirm, setConfirm] = useState(false);
  return (
    <Modal
      title="数量をまとめて入力"
      onClose={onClose}
      footer={
        confirm ? (
          <>
            <button className="btn" onClick={() => setConfirm(false)}>
              戻る
            </button>
            <button className="btn btn-primary" onClick={() => onSubmit(qty)}>
              {qty} 個をピック済みにする
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button className="btn btn-primary" disabled={qty < 1 || qty > group.remaining} onClick={() => setConfirm(true)}>
              次へ
            </button>
          </>
        )
      }
    >
      {confirm ? (
        <div className="alert warning" style={{ fontSize: '1.1rem' }}>
          <strong>
            {group.sku} を {qty} 個
          </strong>
          、手元にあることを数えて確認しましたか？
        </div>
      ) : (
        <Field label={`数量（残り ${group.remaining} 個まで）`} htmlFor="qty-input" hint="読取だけで大量の数量は確定しません。実物を数えて入力してください。">
          <input id="qty-input" type="number" inputMode="numeric" min={1} max={group.remaining} value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ fontSize: 28, minHeight: 56 }} />
        </Field>
      )}
    </Modal>
  );
}

function ShortModal({ taskId, group, onClose, onDone }: { taskId: string; group: Group; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState('not_found');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Short Pick: ${group.sku}（残り ${group.remaining} 個）`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-danger"
            disabled={busy || (reason === 'other' && !note.trim())}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post(`/pick-tasks/${taskId}/short`, { clientEventId: newRequestId(), locationId: group.locationId, productId: group.productId, reasonCode: reason, note: note || undefined });
                feedbackError();
                onDone(`Short ${r.shortQty} 個を管理者に報告しました（注文はキャンセルされません）`);
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Short を報告
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <p className="small">見つかった分は先に読み取ってから、残りを Short にしてください。在庫は「調査中」になり、管理者が再割当・確認します。</p>
      <div className="stack">
        {Object.entries(SHORT_REASON).map(([k, v]) => (
          <label key={k} className="check" style={{ fontSize: '1.05rem', padding: '6px 0' }}>
            <input type="radio" name="short-reason" checked={reason === k} onChange={() => setReason(k)} /> {v}
          </label>
        ))}
      </div>
      <Field label={reason === 'other' ? 'メモ（必須）' : 'メモ'} htmlFor="short-note">
        <input id="short-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}

function HistoryModal({ taskId, events, onClose, onDone, online }: { taskId: string; events: any[]; onClose: () => void; onDone: () => void; online: boolean }) {
  const [err, setErr] = useState<unknown>(null);
  const LABEL: Record<string, string> = { pick: 'ピック', short: 'Short', mis_scan_sku: '誤SKU', mis_scan_location: '誤ロケ', over_pick: '数量過多' };
  return (
    <Modal title="読取履歴（直近50件）" onClose={onClose}>
      <ErrorBox error={err} />
      <p className="small muted">ピック済み数量は上書きしません。間違えた場合は「1個取消」で訂正の記録を追加します。</p>
      <table className="table">
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="small">{new Date(e.at).toLocaleTimeString('ja-JP')}</td>
              <td>
                <span className={`badge ${e.type === 'pick' ? 'success' : 'danger'}`}>{LABEL[e.type] ?? e.type}</span>
              </td>
              <td className="mono small">
                {e.locationCode} {e.sku}
              </td>
              <td className="num">
                {e.qty}
                {e.corrected ? `（${e.corrected}）` : ''}
              </td>
              <td>
                {e.type === 'pick' && e.qty + e.corrected > 0 && (
                  <button
                    className="btn btn-sm"
                    disabled={!online}
                    onClick={async () => {
                      try {
                        await post(`/pick-tasks/${taskId}/correct`, { clientEventId: newRequestId(), pickEventId: e.id, qty: 1 });
                        onDone();
                        onClose();
                      } catch (x) {
                        setErr(x);
                      }
                    }}
                  >
                    1個取消
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
