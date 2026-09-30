import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, get, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ConfirmDialog, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, Pagination, StatusBadge, useToast } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { FULFILLMENT_STATUS, PICK_TASK_STATUS, WAVE_STATUS } from '../../lib/labels';
import { useWarehouses } from '../settings/WarehousesPage';

export default function WavesPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: ['waves', status, offset],
    queryFn: () => get(`/waves?limit=50&offset=${offset}${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader
        title="Wave・ピッキング"
        sub="複数の Fulfillment をまとめてピッキングします。Wave 作成時点の対象を固定（後から来た注文は混入しません）。"
        actions={
          can('waves.manage') && (
            <Link className="btn btn-primary" to="/waves/new">
              Wave を作成
            </Link>
          )
        }
      />
      <div className="tabs">
        {[['', 'すべて'], ['open', '未着手'], ['picking', 'ピッキング中'], ['picked', 'ピック完了'], ['completed', '完了'], ['cancelled', '取消']].map(([k, v]) => (
          <button key={k} className={`tab ${status === k ? 'active' : ''}`} onClick={() => { setStatus(k!); setOffset(0); }}>
            {v}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.items.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Wave</th>
                  <th>倉庫</th>
                  <th>状態</th>
                  <th className="num">Fulfillment</th>
                  <th>進捗（ピック / 必要）</th>
                  <th>作成</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((w: any) => (
                  <tr key={w.id}>
                    <td>
                      <Link to={`/waves/${w.id}`}>{w.waveNumber}</Link> {w.label && <span className="muted small">{w.label}</span>}
                    </td>
                    <td>{w.warehouseCode}</td>
                    <td>
                      <StatusBadge map={WAVE_STATUS} value={w.status} />
                    </td>
                    <td className="num">{w.fulfillmentCount}</td>
                    <td style={{ minWidth: 160 }}>
                      <div className="progress">
                        <span style={{ width: `${w.unitCount ? (100 * (w.pickedUnits + w.shortUnits)) / w.unitCount : 0}%` }} />
                      </div>
                      <span className="small">
                        {w.pickedUnits} / {w.unitCount}
                        {w.shortUnits > 0 && <Badge tone="danger">Short {w.shortUnits}</Badge>}
                      </span>
                    </td>
                    <td className="small">
                      {fmtDateTime(w.createdAt)}
                      <div className="muted">{w.createdBy}</div>
                    </td>
                    <td>
                      <Link className="btn btn-sm" to={`/print/pick-list/${w.id}`} target="_blank">
                        Pick List
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={50} total={list.data.total} onChange={setOffset} />
        </>
      ) : (
        <EmptyState title="Wave はありません" />
      )}
    </>
  );
}

export function WaveCreatePage() {
  const whs = useWarehouses();
  const nav = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const [warehouseId, setWarehouseId] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [minPriority, setMinPriority] = useState('');
  const [dueBefore, setDueBefore] = useState('');
  const [label, setLabel] = useState('');
  const [splitMode, setSplitMode] = useState('single');
  const [linesPerTask, setLinesPerTask] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!warehouseId && whs.data?.items[0]) setWarehouseId(whs.data.items[0].id);
  }, [whs.data, warehouseId]);
  const body = {
    warehouseId,
    shippingMethods: methods.length ? methods : undefined,
    minPriority: minPriority === '' ? undefined : Number(minPriority),
    dueBefore: dueBefore ? new Date(dueBefore).toISOString() : undefined,
  };
  const preview = useQuery({
    queryKey: ['wave-preview', JSON.stringify(body)],
    queryFn: () => post('/waves/preview', body),
    enabled: !!warehouseId,
  });
  useEffect(() => {
    if (preview.data) setSelected(new Set(preview.data.fulfillments.map((f: any) => f.id)));
  }, [preview.data]);
  const max = me?.organization?.settings?.wave?.maxFulfillments ?? 100;
  const chosen = preview.data?.fulfillments.filter((f: any) => selected.has(f.id)) ?? [];
  return (
    <>
      <PageHeader title="Wave を作成" sub="条件で Fulfillment を絞り込み、確認してから作成します。作成時点で対象が固定されます。" />
      <ErrorBox error={err ?? preview.error} />
      <div className="card">
        <div className="filters">
          <div className="field">
            <label htmlFor="wv-wh">倉庫</label>
            <select id="wv-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {whs.data?.items.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wv-prio">優先度（以上）</label>
            <select id="wv-prio" value={minPriority} onChange={(e) => setMinPriority(e.target.value)}>
              <option value="">指定なし</option>
              {[1, 3, 5, 9].map((p) => (
                <option key={p} value={p}>
                  {p} 以上
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wv-due">出荷期限（まで）</label>
            <input id="wv-due" type="datetime-local" value={dueBefore} onChange={(e) => setDueBefore(e.target.value)} />
          </div>
        </div>
        {preview.data?.availableShippingMethods?.length > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="small muted">配送方法:</span>
            {preview.data.availableShippingMethods.map((m: any) => (
              <button
                key={m.method}
                type="button"
                className={`chip ${methods.includes(m.method) ? 'active' : ''}`}
                onClick={() => setMethods(methods.includes(m.method) ? methods.filter((x) => x !== m.method) : [...methods, m.method])}
              >
                {m.method || '（未指定）'} {m.count}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-header">
          <h2>
            対象 {chosen.length} 件 / {fmtNum(chosen.reduce((s: number, f: any) => s + f.units, 0))} 個
          </h2>
          <span className="muted small">（1 Wave の上限 {max} 件）</span>
        </div>
        {preview.isLoading ? (
          <Loading />
        ) : preview.data?.fulfillments.length ? (
          <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="すべて選択"
                      checked={selected.size === preview.data.fulfillments.length}
                      onChange={(e) => setSelected(new Set(e.target.checked ? preview.data.fulfillments.map((f: any) => f.id) : []))}
                    />
                  </th>
                  <th>Fulfillment</th>
                  <th>注文</th>
                  <th>優先度</th>
                  <th>期限</th>
                  <th>配送方法</th>
                  <th className="num">明細 / 数量</th>
                </tr>
              </thead>
              <tbody>
                {preview.data.fulfillments.map((f: any) => (
                  <tr key={f.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${f.fulfillmentNumber} を含める`}
                        checked={selected.has(f.id)}
                        onChange={(e) => {
                          const n = new Set(selected);
                          if (e.target.checked) n.add(f.id);
                          else n.delete(f.id);
                          setSelected(n);
                        }}
                      />
                    </td>
                    <td>
                      {f.fulfillmentNumber} {f.type === 'replacement' && <Badge tone="info">交換</Badge>}
                    </td>
                    <td>{f.orderNumber}</td>
                    <td>{f.priority > 0 ? <Badge tone="danger">{f.priority}</Badge> : 0}</td>
                    <td className="small">{fmtDateTime(f.dueAt)}</td>
                    <td className="small">{f.shippingMethod ?? '—'}</td>
                    <td className="num">
                      {f.lines} / {f.units}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Wave 待ちの Fulfillment はありません">引当済み（全量 or 先行出荷）の注文がここに表示されます。保留中は対象外です。</EmptyState>
        )}
      </div>
      <div className="card">
        <div className="inline-fields">
          <Field label="Wave 名（任意）" htmlFor="wv-label" hint="例: 午前便 / 当日出荷 / ネコポス">
            <input id="wv-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </Field>
          <Field label="タスクの分け方" htmlFor="wv-split">
            <select id="wv-split" value={splitMode} onChange={(e) => setSplitMode(e.target.value)}>
              <option value="single">1 人で全部（1 タスク）</option>
              <option value="zone">ゾーンごと</option>
              <option value="lines">行数ごと</option>
            </select>
          </Field>
          {splitMode === 'lines' && (
            <Field label="1 タスクの行数" htmlFor="wv-lines">
              <input id="wv-lines" type="number" min={1} max={500} value={linesPerTask} onChange={(e) => setLinesPerTask(Number(e.target.value))} />
            </Field>
          )}
        </div>
        <button
          className="btn btn-primary"
          disabled={!chosen.length || chosen.length > max}
          onClick={async () => {
            setErr(null);
            try {
              const r = await post('/waves', { warehouseId, fulfillmentIds: chosen.map((f: any) => f.id), label: label || undefined, splitMode, linesPerTask, criteria: body });
              toast.success(`${r.waveNumber} を作成しました（${r.fulfillments} 件${r.excluded ? ` / ${r.excluded} 件は他で処理済みのため除外` : ''}）`);
              nav(`/waves/${r.waveId}`);
            } catch (e) {
              setErr(e);
            }
          }}
        >
          Wave を作成（{chosen.length} 件）
        </button>
      </div>
    </>
  );
}

export function WaveDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const wave = useQuery({ queryKey: ['wave', id], queryFn: () => get(`/waves/${id}`), refetchInterval: 10_000 });
  const [assign, setAssign] = useState<any>(null);
  const [cancel, setCancel] = useState(false);
  const [needConfirm, setNeedConfirm] = useState(false);
  if (wave.isLoading) return <Loading />;
  if (wave.error) return <ErrorBox error={wave.error} />;
  const w = wave.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['wave', id] });
  return (
    <>
      <PageHeader
        title={
          <span className="row">
            {w.waveNumber} <StatusBadge map={WAVE_STATUS} value={w.status} /> {w.label && <span className="muted">{w.label}</span>}
          </span>
        }
        sub={`${w.warehouseCode} ${w.warehouseName} / ${w.fulfillmentCount} 件 / ${w.lineCount} 行 / ${w.unitCount} 個 / 作成 ${fmtDateTime(w.createdAt)}`}
        actions={
          <>
            <Link className="btn" to={`/print/pick-list/${w.id}`} target="_blank">
              Pick List 印刷
            </Link>
            {can('waves.manage') && !['completed', 'cancelled'].includes(w.status) && (
              <button className="btn btn-danger" onClick={() => setCancel(true)}>
                Wave を取消
              </button>
            )}
          </>
        }
      />
      {w.cancelReason && <div className="alert warning">取消理由: {w.cancelReason}</div>}
      <div className="card">
        <div className="card-header">
          <h2>Pick タスク</h2>
          {can('waves.manage') && w.tasks.some((t: any) => ['open', 'in_progress'].includes(t.status)) && (
            <div className="actions">
              <button className="btn btn-sm" onClick={() => setAssign({ wave: true })}>
                まとめて割り当て
              </button>
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>タスク</th>
                <th>ゾーン</th>
                <th>状態</th>
                <th>担当</th>
                <th>進捗</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {w.tasks.map((t: any) => (
                <tr key={t.id}>
                  <td>{t.taskNumber}</td>
                  <td>{t.zone ?? '—'}</td>
                  <td>
                    <StatusBadge map={PICK_TASK_STATUS} value={t.status} />
                  </td>
                  <td className="small">
                    {t.assigneeName ?? <span className="muted">未担当</span>}
                    {t.claimExpiresAt && <div className="muted">期限 {fmtDateTime(t.claimExpiresAt)}</div>}
                  </td>
                  <td className="small">
                    {t.picked} / {t.unitCount}
                    {t.short > 0 && <Badge tone="danger">Short {t.short}</Badge>}
                  </td>
                  <td className="right nowrap">
                    {can('waves.manage') && ['open', 'in_progress'].includes(t.status) && (
                      <>
                        <button className="btn btn-sm" onClick={() => setAssign(t)}>
                          割当
                        </button>{' '}
                        {t.assigneeUserId && (
                          <button
                            className="btn btn-sm"
                            onClick={async () => {
                              try {
                                await post(`/pick-tasks/${t.id}/release`);
                                refresh();
                              } catch (e) {
                                toast.error(e);
                              }
                            }}
                          >
                            担当解除
                          </button>
                        )}
                      </>
                    )}
                    {can('pick.execute') && ['open', 'in_progress'].includes(t.status) && (
                      <Link className="btn btn-sm" to={`/m/pick/${t.id}`}>
                        ピック画面
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>含まれる Fulfillment（作成時に固定）</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fulfillment</th>
                <th>注文</th>
                <th>状態</th>
                <th>期限</th>
              </tr>
            </thead>
            <tbody>
              {w.fulfillments.map((f: any) => (
                <tr key={f.id} style={f.removedAt ? { opacity: 0.5 } : undefined}>
                  <td>{f.fulfillmentNumber}</td>
                  <td>
                    <Link to={`/orders/${f.orderId}`}>{f.orderNumber}</Link>
                  </td>
                  <td>
                    <StatusBadge map={FULFILLMENT_STATUS} value={f.status} />
                    {f.onHold && <Badge tone="danger">保留</Badge>}
                    {f.hasShort && <Badge tone="danger">Short</Badge>}
                    {f.removedAt && <Badge>除外: {f.removedReason}</Badge>}
                  </td>
                  <td className="small">{fmtDateTime(f.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {assign && <AssignModal task={assign.wave ? null : assign} wave={assign.wave ? { id: w.id, waveNumber: w.waveNumber } : null} onClose={() => setAssign(null)} onDone={refresh} />}
      {cancel && (
        <ConfirmDialog
          title={`${w.waveNumber} を取消`}
          message={needConfirm ? 'ピック済みの商品があります。取消すると棚戻しの例外が作成されます。本当に取消しますか？' : 'Wave を取消すと、Fulfillment は Wave 待ちに戻ります。'}
          requireReason
          danger
          confirmLabel={needConfirm ? '棚戻しを伴って取消' : '取消する'}
          onClose={() => {
            setCancel(false);
            setNeedConfirm(false);
          }}
          onConfirm={async (reason) => {
            try {
              await post(`/waves/${id}/cancel`, { reason, confirm: needConfirm });
              toast.success('Wave を取消しました');
              refresh();
            } catch (e) {
              if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') {
                setNeedConfirm(true);
                setTimeout(() => setCancel(true), 0);
              }
              throw e;
            }
          }}
        />
      )}
    </>
  );
}

/** 1 タスク、または Wave の未完了タスクをまとめて作業者に割り当てる */
function AssignModal({ task, wave, onClose, onDone }: { task: any; wave?: { id: string; waveNumber: string } | null; onClose: () => void; onDone: () => void }) {
  const users = useQuery({ queryKey: ['assignable-users'], queryFn: () => get('/users/assignable?perm=pick.execute') });
  const [userId, setUserId] = useState('');
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  return (
    <Modal
      title={wave ? `${wave.waveNumber} のタスクをまとめて割り当て` : `${task.taskNumber} を割り当て`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={!userId}
            onClick={async () => {
              try {
                if (wave) {
                  const r = await post(`/waves/${wave.id}/assign`, { userId, onlyUnassigned });
                  toast.success(`${r.assigned} 件のタスクを割り当てました`);
                } else {
                  await post(`/pick-tasks/${task.id}/assign`, { userId });
                }
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            割り当てる
          </button>
        </>
      }
    >
      <ErrorBox error={err ?? users.error} />
      {wave && (
        <label className="row" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} /> 未担当のタスクだけ（外すと担当中のタスクも付け替えます）
        </label>
      )}
      <Field label="作業者" htmlFor="assign-user" hint="現在の担当者がいる場合は付け替えます（監査ログに記録）">
        <select id="assign-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">選択</option>
          {users.data?.items.map((u: any) => (
            <option key={u.userId} value={u.userId}>
              {u.name}（{u.roleLabel}）
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

export function FulfillmentsPage() {
  const whs = useWarehouses();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [warehouseId, setWarehouseId] = useState('');
  const [flag, setFlag] = useState('');
  const [offset, setOffset] = useState(0);
  const [resolve, setResolve] = useState<any>(null);
  const params = new URLSearchParams({ limit: '50', offset: String(offset) });
  if (status) params.set('status', status);
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (flag === 'short') params.set('hasShort', 'true');
  if (flag === 'hold') params.set('onHold', 'true');
  if (flag === 'overdue') params.set('overdue', 'true');
  const list = useQuery({ queryKey: ['fulfillments', params.toString()], queryFn: () => get(`/fulfillments?${params}`), placeholderData: keepPreviousData });
  return (
    <>
      <PageHeader title="Fulfillment（出荷作業）" sub="1 注文 × 1 倉庫の作業単位。倉庫分割・先行出荷・交換で 1 注文に複数できることがあります。" />
      <div className="filters">
        <div className="field">
          <label htmlFor="ff-status">状態</label>
          <select id="ff-status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {Object.entries(FULFILLMENT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ff-wh">倉庫</label>
          <select id="ff-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ff-flag">絞り込み</label>
          <select id="ff-flag" value={flag} onChange={(e) => { setFlag(e.target.value); setOffset(0); }}>
            <option value="">なし</option>
            <option value="short">Short あり</option>
            <option value="hold">保留中</option>
            <option value="overdue">締切超過</option>
          </select>
        </div>
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.items.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fulfillment</th>
                  <th>注文</th>
                  <th>倉庫</th>
                  <th>状態</th>
                  <th>Wave</th>
                  <th className="num">数量（ピック）</th>
                  <th>期限</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((f: any) => (
                  <tr key={f.id}>
                    <td>
                      {f.fulfillmentNumber} {f.type === 'replacement' && <Badge tone="info">交換</Badge>}
                    </td>
                    <td>
                      <Link to={`/orders/${f.orderId}`}>{f.orderNumber}</Link>
                      <div className="muted small mono">{f.externalOrderId}</div>
                    </td>
                    <td>{f.warehouseCode}</td>
                    <td>
                      <StatusBadge map={FULFILLMENT_STATUS} value={f.status} />
                      {f.onHold && <Badge tone="danger">保留</Badge>}
                      {f.hasShort && <Badge tone="danger">Short {f.short}</Badge>}
                    </td>
                    <td>{f.waveNumber ? <Link to={`/waves/${f.waveId}`}>{f.waveNumber}</Link> : '—'}</td>
                    <td className="num">
                      {f.units}（{f.picked}）
                    </td>
                    <td className="small" style={f.dueAt && new Date(f.dueAt) < new Date() && !['shipped', 'cancelled'].includes(f.status) ? { color: 'var(--c-danger)', fontWeight: 700 } : undefined}>
                      {fmtDateTime(f.dueAt)}
                    </td>
                    <td>
                      {f.hasShort && (
                        <button className="btn btn-sm btn-warning" onClick={() => setResolve(f)}>
                          Short を解決
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={50} total={list.data.total} capped={list.data.totalCapped} onChange={setOffset} />
        </>
      ) : (
        <EmptyState title="該当する Fulfillment はありません" />
      )}
      {resolve && (
        <ResolveShortModal
          fulfillment={resolve}
          onClose={() => setResolve(null)}
          onDone={(msg) => {
            toast.success(msg);
            void qc.invalidateQueries({ queryKey: ['fulfillments'] });
          }}
        />
      )}
    </>
  );
}

export function ResolveShortModal({ fulfillment, onClose, onDone }: { fulfillment: any; onClose: () => void; onDone: (msg: string) => void }) {
  const whs = useWarehouses();
  const [action, setAction] = useState<'backlog' | 'reallocate'>('reallocate');
  const [warehouseId, setWarehouseId] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title={`${fulfillment.fulfillmentNumber} の Short を解決`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={action === 'reallocate' && !warehouseId}
            onClick={async () => {
              try {
                const r = await post(`/fulfillments/${fulfillment.id}/resolve-short`, { action, warehouseId: action === 'reallocate' ? warehouseId : undefined });
                onDone(action === 'reallocate' ? `Short ${r.shortUnits} 個のうち ${r.reallocated} 個を再割当しました` : `Short ${r.shortUnits} 個をバックログへ戻しました`);
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            実行
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <p className="small">注文はキャンセルされません。ピック済みの商品はこの Fulfillment で梱包・出荷できます（分割出荷）。在庫側の「調査中」は在庫画面・例外キューで確認してください。</p>
      <label className="check">
        <input type="radio" checked={action === 'reallocate'} onChange={() => setAction('reallocate')} /> 別の倉庫（または同じ倉庫の別ロケーション）から再割当する
      </label>
      {action === 'reallocate' && (
        <Field label="再割当する倉庫" htmlFor="rs-wh">
          <select id="rs-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">選択</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <label className="check">
        <input type="radio" checked={action === 'backlog'} onChange={() => setAction('backlog')} /> バックログへ戻す（入荷後などに改めて引当）
      </label>
    </Modal>
  );
}
