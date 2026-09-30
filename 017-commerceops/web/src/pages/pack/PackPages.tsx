import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, get, newRequestId, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ConfirmDialog, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, useOnline, useToast } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { feedbackDone, feedbackError, feedbackOk } from '../../scanner/feedback';
import { ScanInput, type InputMethod, type ScanInputHandle } from '../../scanner/ScanInput';
import { useWarehouses } from '../settings/WarehousesPage';

/** Packing Station ホーム: 注文 / 出荷作業コードを読んで開始。梱包待ち・梱包中の一覧 */
export default function PackHome() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { can } = useAuth();
  const whs = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [choices, setChoices] = useState<any[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<any>(null);
  const q = useQuery({
    queryKey: ['pack-queue', warehouseId],
    queryFn: () => get(`/pack/queue${warehouseId ? `?warehouseId=${warehouseId}` : ''}`),
    refetchInterval: 15_000,
  });

  const open = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/pack/open', body);
      if (r.choices) {
        setChoices(r.choices);
        return;
      }
      feedbackOk();
      if (r.takenOver) {
        toast.info(
          r.takeoverReason === 'manager'
            ? '管理者として梱包を引き継ぎました（scan 済みの数量は保持。前の担当者は操作できなくなります）'
            : '作業期限が切れていた梱包を引き継ぎました（scan 済みの数量は保持）',
        );
      }
      nav(`/pack/${r.sessionId}`);
    } catch (e) {
      feedbackError();
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const items = q.data?.items ?? [];
  const active = items.filter((i: any) => i.session);
  const waiting = items.filter((i: any) => !i.session);
  return (
    <>
      <PageHeader title="Packing Station" sub="注文番号・出荷作業番号（F-）のバーコード / QR を読むと梱包を開始します。PC・iPad 向け画面です。" />
      {!online && <div className="alert warning">オフラインです。梱包の開始・scan・完了はオンラインでのみ行えます。</div>}
      <div className="card">
        <ScanInput id="pack-open" label="注文 / 出荷作業コード" placeholder="例: F-000123 または SO-000456" onScan={(code) => void open({ code })} disabled={busy || !online} />
        <ErrorBox error={error} />
      </div>
      {choices && (
        <Modal title="梱包する出荷作業を選んでください" onClose={() => setChoices(null)}>
          <p className="small muted">この注文には梱包できる出荷作業が複数あります（倉庫分割・先行出荷など）。</p>
          {choices.map((c) => (
            <button key={c.fulfillmentId} className="btn btn-block" style={{ marginBottom: 8, justifyContent: 'space-between' }} onClick={() => { setChoices(null); void open({ fulfillmentId: c.fulfillmentId }); }}>
              <span className="mono">{c.fulfillmentNumber}</span>
              <span>{c.warehouseCode}</span>
            </button>
          ))}
        </Modal>
      )}
      <div className="filters">
        <div className="field">
          <label htmlFor="pk-wh">倉庫</label>
          <select id="pk-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">すべて</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ErrorBox error={q.error} />
      <div className="card">
        <div className="card-header">
          <h2>梱包中（{active.length}）</h2>
        </div>
        {active.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>出荷作業</th>
                  <th>注文</th>
                  <th>担当</th>
                  <th>開始</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {active.map((i: any) => (
                  <tr key={i.fulfillmentId}>
                    <td className="mono">{i.fulfillmentNumber}</td>
                    <td>{i.orderNumber}</td>
                    <td>
                      {i.session.packerName}
                      {i.session.mine && <Badge tone="primary">自分</Badge>}
                      {i.session.expired && <Badge tone="warning">期限切れ</Badge>}
                    </td>
                    <td className="small">{fmtDateTime(i.session.startedAt)}</td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      {(i.session.mine || i.session.expired) && (
                        <button className="btn btn-sm btn-primary" disabled={busy || !online} onClick={() => void open({ fulfillmentId: i.fulfillmentId })}>
                          {i.session.mine ? '再開' : '引き継ぐ'}
                        </button>
                      )}
                      {!i.session.mine && !i.session.expired && can('fulfillment.manage') && (
                        <button className="btn btn-sm" disabled={busy || !online} onClick={() => void open({ fulfillmentId: i.fulfillmentId, takeover: true })}>
                          管理者として引き継ぐ
                        </button>
                      )}
                      {(i.session.mine || can('fulfillment.manage')) && (
                        <button className="btn btn-sm btn-ghost" disabled={!online} onClick={() => setCancelTarget(i)}>
                          中止
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">梱包中の作業はありません。</p>
        )}
      </div>
      <div className="card">
        <div className="card-header">
          <h2>梱包待ち（{waiting.length}）</h2>
          <span className="muted small">ピッキング完了・保留なし</span>
        </div>
        {q.isLoading ? (
          <Loading />
        ) : waiting.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>出荷作業</th>
                  <th>注文</th>
                  <th>倉庫 / Wave</th>
                  <th>優先度</th>
                  <th>期限</th>
                  <th className="num">行 / 個</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waiting.map((i: any) => (
                  <tr key={i.fulfillmentId}>
                    <td className="mono">
                      {i.fulfillmentNumber} {i.type === 'replacement' && <Badge tone="info">交換</Badge>}
                    </td>
                    <td>{i.orderNumber}</td>
                    <td className="small">
                      {i.warehouseCode} {i.waveNumber}
                    </td>
                    <td>{i.priority > 0 ? <Badge tone="danger">{i.priority}</Badge> : 0}</td>
                    <td className="small">{fmtDateTime(i.dueAt)}</td>
                    <td className="num">
                      {i.lines} / {i.units}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-primary" disabled={busy || !online} onClick={() => void open({ fulfillmentId: i.fulfillmentId })}>
                        梱包開始
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="梱包待ちはありません">ピッキングが完了した出荷作業がここに表示されます。</EmptyState>
        )}
      </div>
      {q.data?.recent?.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>自分が最近完了した梱包（24 時間）</h2>
          </div>
          <table className="table">
            <tbody>
              {q.data.recent.map((r: any) => (
                <tr key={r.sessionId}>
                  <td className="mono">{r.fulfillmentNumber}</td>
                  <td>{r.orderNumber}</td>
                  <td className="small">{fmtDateTime(r.completedAt)}</td>
                  <td>
                    {r.boxes} 箱 {r.forced && <Badge tone="danger">強制完了</Badge>} {r.misScanCount > 0 && <Badge tone="warning">誤 scan {r.misScanCount}</Badge>}
                  </td>
                  <td>
                    <Link className="btn btn-sm" to={`/print/packing-slip/${r.fulfillmentId}`} target="_blank">
                      納品書
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cancelTarget && (
        <ConfirmDialog
          title={`${cancelTarget.fulfillmentNumber} の梱包を中止`}
          message="scan 済みの数量は 0 に戻ります（記録は履歴として残ります）。箱から商品を出し、最初から梱包し直してください。"
          confirmLabel="中止する"
          danger
          requireReason
          onClose={() => setCancelTarget(null)}
          onConfirm={async (reason) => {
            await post(`/pack/sessions/${cancelTarget.session.id}/cancel`, { reason });
            toast.success('梱包を中止しました');
            await qc.invalidateQueries({ queryKey: ['pack-queue'] });
          }}
        />
      )}
    </>
  );
}

type Feedback = { kind: 'ok' | 'error' | 'warn'; text: string } | null;

/** 梱包画面（1 出荷作業） */
export function PackStation() {
  const { sessionId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { me, can } = useAuth();
  const q = useQuery({ queryKey: ['pack-session', sessionId], queryFn: () => get(`/pack/sessions/${sessionId}`) });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | 'force' | 'cancel' | { bulk: any }>(null);
  const [completeError, setCompleteError] = useState<unknown>(null);
  const scanRef = useRef<ScanInputHandle>(null);
  const refetch = () => qc.invalidateQueries({ queryKey: ['pack-session', sessionId] });
  useEffect(() => {
    if (feedback?.kind === 'ok') {
      const t = setTimeout(() => setFeedback((f) => (f?.kind === 'ok' ? null : f)), 2500);
      return () => clearTimeout(t);
    }
  }, [feedback]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      feedbackError();
      setFeedback({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      if (e instanceof ApiError && ['NOT_ASSIGNED', 'SESSION_CLOSED'].includes(e.code)) void refetch();
    } finally {
      setBusy(false);
      scanRef.current?.focus();
    }
  };

  const onScan = (code: string, method: InputMethod, qty = 1) =>
    run(async () => {
      try {
        const r = await post(`/pack/sessions/${sessionId}/scan`, { clientEventId: newRequestId(), code, qty, inputMethod: method });
        if (r.allPacked) {
          feedbackDone();
          setFeedback({ kind: 'ok', text: `${r.item.sku} OK — 全商品の検品が終わりました。「梱包完了」を押してください` });
        } else {
          feedbackOk();
          setFeedback({ kind: 'ok', text: `${r.item.sku} OK（残り ${r.item.remaining}）` });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          feedbackError();
          setFeedback({ kind: 'error', text: e.message });
        } else throw e;
      } finally {
        await refetch();
      }
    });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const v = q.data;
  const f = v.fulfillment;
  const mine = v.packerUserId === me?.user.id;
  const activeMine = v.status === 'active' && mine;
  const totalRequired = v.items.reduce((s: number, i: any) => s + i.required, 0);
  const totalPacked = v.items.reduce((s: number, i: any) => s + i.packed, 0);

  const complete = (extra: Record<string, unknown> = {}) =>
    run(async () => {
      setCompleteError(null);
      try {
        await post(`/pack/sessions/${sessionId}/complete`, { requestId: newRequestId(), ...extra });
        feedbackDone();
        setFeedback({ kind: 'ok', text: '梱包を完了しました' });
        toast.success(`${f.fulfillmentNumber} の梱包を完了しました`);
      } catch (e) {
        setCompleteError(e);
        throw e;
      } finally {
        await refetch();
      }
    });

  return (
    <>
      <PageHeader
        title={
          <>
            梱包 <span className="mono">{f.fulfillmentNumber}</span> {f.type === 'replacement' && <Badge tone="info">交換品</Badge>}
          </>
        }
        sub={`${f.orderNumber} / ${f.channelName} / 倉庫 ${f.warehouseCode}${f.waveNumber ? ` / ${f.waveNumber}` : ''}${f.shippingMethod ? ` / ${f.shippingMethod}` : ''}`}
        actions={
          <>
            <Link className="btn" to={`/print/packing-slip/${f.id}`} target="_blank">
              納品書を印刷
            </Link>
            <Link className="btn" to="/pack">
              一覧へ
            </Link>
          </>
        }
      />
      {!online && <div className="alert warning">オフラインです。scan・梱包完了はオンラインでのみ行えます（オフラインで確定しません）。</div>}
      {f.onHold && <div className="alert danger">この注文は保留中です（{f.holdReason}）。保留が解除されるまで梱包できません。</div>}
      {v.status === 'active' && !mine && (
        <div className="alert warning">
          この梱包は {v.packerName} が担当しています。{v.claimExpiresAt && new Date(v.claimExpiresAt) < new Date() ? '作業期限が切れているため、一覧から引き継げます。' : ''}
        </div>
      )}
      {v.status === 'cancelled' && <div className="alert warning">この梱包は中止されました。一覧から開き直してください。</div>}
      {v.status === 'completed' ? (
        <div className="card" style={{ borderColor: 'var(--c-success)' }}>
          <h2 style={{ marginTop: 0 }}>✓ 梱包完了 {v.forced && <Badge tone="danger">強制完了</Badge>}</h2>
          <p className="muted">
            {fmtDateTime(v.completedAt)} / 誤 scan {v.misScanCount} 回。次は出荷作業で配送会社と追跡番号を入力し、出荷を確定します。
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>荷物</th>
                <th>箱</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {v.shipments.map((s: any) => (
                <tr key={s.id}>
                  <td className="mono">{s.shipmentNumber}</td>
                  <td>{s.boxNo}</td>
                  <td>{s.items.map((i: any) => `${i.sku}×${i.quantity}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary btn-lg" onClick={() => nav('/pack')}>
              次の注文へ
            </button>
            <Link className="btn btn-lg" to={`/print/packing-slip/${f.id}`} target="_blank">
              納品書を印刷
            </Link>
            {v.shipments.map((s: any) => (
              <Link key={s.id} className="btn btn-lg" to={`/print/shipment/${s.id}`} target="_blank">
                作業票 {s.shipmentNumber}
              </Link>
            ))}
            {can('shipments.manage') && (
              <Link className="btn btn-lg" to="/shipments?status=draft">
                出荷作業へ
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="pack-grid">
          <div>
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <strong>
                  箱 {v.currentBox} ・ 検品 {totalPacked} / {totalRequired} 個
                </strong>
                {v.misScanCount > 0 && <Badge tone="warning">誤 scan {v.misScanCount} 回</Badge>}
              </div>
              <div className="progress" style={{ marginBottom: 10 }} aria-label="検品の進捗">
                <span style={{ width: `${totalRequired ? (100 * totalPacked) / totalRequired : 0}%` }} />
              </div>
              <ScanInput
                ref={scanRef}
                id="pack-scan"
                label="商品のバーコードを読む（1 scan = 1 個）"
                onScan={(code, m) => void onScan(code, m)}
                disabled={busy || !online || !activeMine || f.onHold}
              />
              {v.allPacked && activeMine && (
                <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 10 }} disabled={busy || !online || f.onHold} onClick={() => void complete()}>
                  ✓ 梱包完了（全 {totalRequired} 個 検品済み）
                </button>
              )}
              {feedback && (
                <div className={`scan-feedback ${feedback.kind}`} role="alert" aria-live="assertive" style={feedback.kind === 'error' ? { fontSize: '1.3rem', padding: 18 } : undefined}>
                  {feedback.text}
                  {feedback.kind === 'error' && (
                    <div>
                      <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setFeedback(null)}>
                        確認しました
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="card" style={{ padding: 0 }}>
              {v.items.map((i: any) => (
                <div key={i.fulfillmentItemId} className={`pack-line ${i.remaining === 0 ? 'done' : ''}`}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                    {i.imageUrl && <img src={i.imageUrl} alt="" style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8 }} referrerPolicy="no-referrer" />}
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontWeight: 700 }}>
                        {i.remaining === 0 ? '✓ ' : ''}
                        {i.sku}
                      </div>
                      <div>{i.name}</div>
                      {i.variant && <div className="small muted">{i.variant}</div>}
                      <div className="small muted">{i.barcodes.join(', ')}</div>
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <button
                          className="btn btn-sm"
                          disabled={busy || !activeMine || i.packed === 0 || !online}
                          onClick={() =>
                            void run(async () => {
                              await post(`/pack/sessions/${sessionId}/correct`, { clientEventId: newRequestId(), fulfillmentItemId: i.fulfillmentItemId, qty: 1 });
                              setFeedback({ kind: 'warn', text: `${i.sku} を 1 個取り消しました（箱から 1 個出してください）` });
                              await refetch();
                            })
                          }
                        >
                          1 個取消
                        </button>
                        {i.required > 1 && (
                          <button className="btn btn-sm" disabled={busy || !activeMine || i.remaining === 0 || i.packed === 0 || !online} onClick={() => setModal({ bulk: i })} title="1 個 scan した後に、残りを数えて入力できます">
                            残りをまとめて入力
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="n">
                    {i.required}
                    <small>必要</small>
                  </div>
                  <div className="n" style={{ color: 'var(--c-success)' }}>
                    {i.packed}
                    <small>scan 済</small>
                  </div>
                  <div className="n" style={{ color: i.remaining ? 'var(--c-danger)' : 'var(--c-text-muted)' }}>
                    {i.remaining}
                    <small>残り</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            {f.shipTo && (
              <div className="card">
                <div className="card-header">
                  <h2>送付先</h2>
                </div>
                <div style={{ fontWeight: 700 }}>{f.shipTo.name} 様</div>
                <div className="small">
                  〒{f.shipTo.postalCode} {f.shipTo.prefecture}
                  {f.shipTo.city}
                  {f.shipTo.address1} {f.shipTo.address2}
                </div>
                {f.notes && (
                  <div className="alert info" style={{ marginTop: 8, marginBottom: 0 }}>
                    備考: {f.notes}
                  </div>
                )}
              </div>
            )}
            <div className="card">
              <div className="card-header">
                <h2>箱</h2>
              </div>
              {v.boxes.map((b: any) => (
                <div key={b.boxNo} className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontWeight: b.boxNo === v.currentBox ? 700 : 400 }}>
                  <span>
                    箱 {b.boxNo} {b.boxNo === v.currentBox && <Badge tone="primary">作業中</Badge>}
                  </span>
                  <span>{b.units} 個</span>
                </div>
              ))}
              <button
                className="btn btn-block"
                style={{ marginTop: 8 }}
                disabled={busy || !activeMine || !online || !v.boxes.find((b: any) => b.boxNo === v.currentBox)?.units || v.allPacked}
                onClick={() =>
                  void run(async () => {
                    const r = await post(`/pack/sessions/${sessionId}/next-box`, { clientEventId: newRequestId() });
                    setFeedback({ kind: 'ok', text: `箱 ${r.currentBox - 1} を閉じました。箱 ${r.currentBox} に入れてください` });
                    await refetch();
                  })
                }
              >
                箱を閉じて次の箱へ
              </button>
            </div>
            <div className="card">
              <ErrorBox error={completeError} />
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !activeMine || !v.allPacked || !online || f.onHold} onClick={() => void complete()}>
                梱包完了
              </button>
              {!v.allPacked && <p className="small muted" style={{ marginBottom: 0 }}>全商品の scan 済 = 必要数 になると押せます。</p>}
              {v.canForce && !v.allPacked && (
                <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} disabled={busy || !activeMine || !online || f.onHold} onClick={() => setModal('force')}>
                  強制完了（管理者）
                </button>
              )}
              {activeMine && (
                <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} disabled={!online} onClick={() => setModal('cancel')}>
                  梱包を中止
                </button>
              )}
            </div>
            <div className="card">
              <div className="card-header">
                <h2>履歴</h2>
              </div>
              <ul className="plain small" style={{ maxHeight: 280, overflow: 'auto' }}>
                {v.events.map((e: any) => (
                  <li key={e.id} style={{ color: e.misScan ? 'var(--c-danger)' : undefined, padding: '2px 0' }}>
                    {fmtDateTime(e.at).slice(11)} {e.misScan ? '✕ ' : ''}
                    {e.message ?? e.type} {e.boxNo > 1 ? `（箱 ${e.boxNo}）` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {modal === 'force' && (
        <ConfirmDialog
          title="強制完了（検品未完了）"
          danger
          requireReason
          reasonLabel="理由"
          confirmLabel="未検品のまま完了する"
          message={
            <div className="alert danger" style={{ marginBottom: 0 }}>
              <strong>全数の scan 検品が終わっていません。</strong>
              <ul>
                {v.items
                  .filter((i: any) => i.remaining > 0)
                  .map((i: any) => (
                    <li key={i.fulfillmentItemId}>
                      {i.sku}: scan {i.packed} / 必要 {i.required}
                    </li>
                  ))}
              </ul>
              未検品分は目視で確認済みとして梱包扱いになり、誤出荷の原因になります。例外キューと監査ログに記録されます。
            </div>
          }
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`/pack/sessions/${sessionId}/complete`, { requestId: newRequestId(), force: true, reason });
            toast.success('強制完了しました（例外キューに記録）');
            await refetch();
          }}
        />
      )}
      {modal === 'cancel' && (
        <ConfirmDialog
          title="梱包を中止"
          danger
          requireReason
          confirmLabel="中止する"
          message="scan 済みの数量は 0 に戻ります。箱から商品を出してください。"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`/pack/sessions/${sessionId}/cancel`, { reason });
            toast.success('梱包を中止しました');
            nav('/pack');
          }}
        />
      )}
      {modal && typeof modal === 'object' && 'bulk' in modal && (
        <BulkModal
          item={modal.bulk}
          onClose={() => setModal(null)}
          onSubmit={(qty) => {
            setModal(null);
            void onScan(modal.bulk.sku, 'manual', qty);
          }}
        />
      )}
    </>
  );
}

function BulkModal({ item, onClose, onSubmit }: { item: any; onClose: () => void; onSubmit: (qty: number) => void }) {
  const [qty, setQty] = useState<number>(item.remaining);
  const [confirm, setConfirm] = useState(false);
  return (
    <Modal
      title={`${item.sku} の残りをまとめて入力`}
      onClose={onClose}
      footer={
        confirm ? (
          <>
            <button className="btn" onClick={() => setConfirm(false)}>
              戻る
            </button>
            <button className="btn btn-primary" onClick={() => onSubmit(qty)}>
              {qty} 個を検品済みにする
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button className="btn btn-primary" disabled={!(qty >= 1 && qty <= item.remaining)} onClick={() => setConfirm(true)}>
              次へ
            </button>
          </>
        )
      }
    >
      {confirm ? (
        <div className="alert warning" style={{ fontSize: '1.1rem' }}>
          <strong>
            {item.sku} を {qty} 個
          </strong>
          、実物を数えて箱に入れたことを確認しましたか？
        </div>
      ) : (
        <Field label={`数量（残り ${item.remaining} 個まで）`} htmlFor="bulk-qty" hint="同じ商品を 1 個 scan して商品を確認した後にだけ使えます">
          <input id="bulk-qty" type="number" inputMode="numeric" min={1} max={item.remaining} value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ fontSize: 24 }} />
        </Field>
      )}
    </Modal>
  );
}
