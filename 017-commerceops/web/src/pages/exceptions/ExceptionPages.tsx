import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { get, newRequestId, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ExportButton } from '../../components/ExportButton';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, Pagination, StatusBadge, useToast } from '../../components/ui';
import { fmtDateTime, relativeTime } from '../../lib/format';
import { EXCEPTION_STATUS, EXCEPTION_TYPE, RESOLUTION_CODE, SEVERITY } from '../../lib/labels';

const TABS = [
  { key: 'active', label: '未解決' },
  { key: 'open', label: '未対応' },
  { key: 'investigating', label: '調査中' },
  { key: 'resolved', label: '解決' },
  { key: 'ignored', label: '対応不要' },
  { key: '', label: 'すべて' },
];

export default function ExceptionsPage() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'active';
  const [type, setType] = useState(sp.get('type') ?? '');
  const [severity, setSeverity] = useState(sp.get('severity') ?? '');
  const [assignee, setAssignee] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ limit: '50', offset: String(offset) });
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  if (severity) params.set('severity', severity);
  if (assignee) params.set('assignee', assignee);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({ queryKey: ['exceptions', params.toString()], queryFn: () => get(`/exceptions?${params}`), placeholderData: keepPreviousData });
  const items: any[] = list.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="例外キュー"
        sub="欠品・Short Pick・住所不備・強制梱包・在庫不整合・返品差異・追跡番号重複・取込競合などを、未対応 → 調査中 → 解決 / 対応不要（理由必須）で管理します。"
        actions={<ExportButton path="/exceptions/export" filename="exceptions.csv" params={{ status, type, severity, assignee, q: q.trim() || undefined }} label="CSV 出力" />}
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
            {t.label} {t.key && list.data?.counts?.[t.key] ? <Badge tone={['active', 'open'].includes(t.key) ? 'danger' : ''}>{list.data.counts[t.key]}</Badge> : null}
          </button>
        ))}
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="ex-type">種類</label>
          <select id="ex-type" value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {Object.entries(EXCEPTION_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
                {list.data?.activeByType?.[k] ? `（${list.data.activeByType[k]}）` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ex-sev">重要度</label>
          <select id="ex-sev" value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ex-asg">担当</label>
          <select id="ex-asg" value={assignee} onChange={(e) => { setAssignee(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            <option value="me">自分</option>
            <option value="unassigned">未割当</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ex-q">検索</label>
          <input id="ex-q" type="search" placeholder="例外番号・注文番号・件名" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
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
                <th>重要度</th>
                <th>件名</th>
                <th>種類</th>
                <th>状態</th>
                <th>関連</th>
                <th>担当</th>
                <th>発生</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Badge tone={SEVERITY[e.severity]!.tone}>{SEVERITY[e.severity]!.label}</Badge>
                  </td>
                  <td>
                    <Link to={`/exceptions/${e.id}`}>{e.title}</Link>
                    <div className="small muted mono">{e.number}</div>
                  </td>
                  <td className="small">{EXCEPTION_TYPE[e.type] ?? e.type}</td>
                  <td>
                    <StatusBadge map={EXCEPTION_STATUS} value={e.status} />
                  </td>
                  <td className="small">
                    {[e.orderNumber, e.fulfillmentNumber, e.returnNumber, e.shipmentNumber, e.sku, e.warehouseCode].filter(Boolean).join(' / ') || '—'}
                  </td>
                  <td className="small">{e.assigneeName ?? <span className="muted">未割当</span>}</td>
                  <td className="small" title={fmtDateTime(e.createdAt)}>
                    {relativeTime(e.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="該当する例外はありません">{status === 'active' ? '未解決の例外はありません。' : null}</EmptyState>
      )}
      <Pagination total={list.data?.total ?? 0} capped={list.data?.totalCapped} limit={50} offset={offset} onChange={setOffset} />
    </>
  );
}

function DetailValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'object') {
      const keys = [...new Set(value.flatMap((v) => Object.keys(v as object)))];
      return (
        <table className="table">
          <thead>
            <tr>
              {keys.map((k) => (
                <th key={k}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.map((v, i) => (
              <tr key={i}>
                {keys.map((k) => (
                  <td key={k}>{String((v as Record<string, unknown>)[k] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <>{value.join(', ')}</>;
  }
  if (value && typeof value === 'object') return <code className="small">{JSON.stringify(value)}</code>;
  return <>{String(value ?? '')}</>;
}

export function ExceptionDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['exception', id], queryFn: () => get(`/exceptions/${id}`) });
  const users = useQuery({ queryKey: ['assignable', 'exceptions.manage'], queryFn: () => get('/users/assignable?perm=exceptions.manage'), enabled: can('exceptions.manage') });
  const [modal, setModal] = useState<null | 'resolve' | 'ignore'>(null);
  const [comment, setComment] = useState('');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const e = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['exception', id] });
    void qc.invalidateQueries({ queryKey: ['exceptions'] });
    void qc.invalidateQueries({ queryKey: ['nav-badges'] });
  };
  const setStatus = async (status: string, extra: object = {}) => {
    try {
      await post(`/exceptions/${id}/status`, { status, ...extra });
      toast.success('更新しました');
      refresh();
    } catch (err) {
      toast.error(err);
    }
  };
  const active = ['open', 'investigating'].includes(e.status);
  const manage = can('exceptions.manage');
  return (
    <>
      <PageHeader
        title={
          <span className="row">
            <Badge tone={SEVERITY[e.severity]!.tone}>重要度 {SEVERITY[e.severity]!.label}</Badge> {e.title}
          </span>
        }
        sub={
          <>
            <span className="mono">{e.number}</span> / {EXCEPTION_TYPE[e.type]} / <StatusBadge map={EXCEPTION_STATUS} value={e.status} /> / 発生 {fmtDateTime(e.createdAt)}
            {e.createdBy ? `（${e.createdBy}）` : ''}
          </>
        }
        actions={
          manage && (
            <>
              {e.status === 'open' && (
                <button className="btn" onClick={() => void setStatus('investigating')}>
                  調査中にする
                </button>
              )}
              {active && (
                <button className="btn btn-primary" onClick={() => setModal('resolve')}>
                  解決
                </button>
              )}
              {active && (
                <button className="btn" onClick={() => setModal('ignore')}>
                  対応不要
                </button>
              )}
              {!active && (
                <button className="btn" onClick={() => void setStatus('open')}>
                  再オープン
                </button>
              )}
            </>
          )
        }
      />
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>内容</h2>
          </div>
          <dl className="kv">
            {e.orderNumber && (
              <>
                <dt>注文</dt>
                <dd>{can('orders.read') ? <Link to={`/orders/${e.orderId}`}>{e.orderNumber}</Link> : e.orderNumber}</dd>
              </>
            )}
            {e.fulfillmentNumber && (
              <>
                <dt>出荷作業</dt>
                <dd>
                  {e.fulfillmentNumber} {can('fulfillment.manage') && <Link to="/fulfillments">（Fulfillment 一覧で対応）</Link>}
                </dd>
              </>
            )}
            {e.waveNumber && (
              <>
                <dt>Wave / タスク</dt>
                <dd>
                  <Link to={`/waves/${e.waveId}`}>{e.waveNumber}</Link> {e.pickTaskNumber}
                </dd>
              </>
            )}
            {e.shipmentNumber && (
              <>
                <dt>荷物</dt>
                <dd>
                  <Link to={`/shipments/${e.shipmentId}`}>{e.shipmentNumber}</Link>
                </dd>
              </>
            )}
            {e.returnNumber && (
              <>
                <dt>返品</dt>
                <dd>
                  <Link to={`/returns/${e.returnId}`}>{e.returnNumber}</Link>
                </dd>
              </>
            )}
            {e.importBatchNumber && (
              <>
                <dt>取込</dt>
                <dd>
                  <Link to={`/imports/${e.importBatchId}`}>{e.importBatchNumber}</Link>
                </dd>
              </>
            )}
            {e.sku && (
              <>
                <dt>商品</dt>
                <dd>
                  <span className="mono">{e.sku}</span> {e.productName}
                </dd>
              </>
            )}
            {(e.warehouseCode || e.locationCode) && (
              <>
                <dt>倉庫 / ロケーション</dt>
                <dd>
                  {e.warehouseCode} {e.locationCode}
                </dd>
              </>
            )}
            {Object.entries(e.detail ?? {}).map(([k, v]) => (
              <DetailRow key={k} k={k} v={v} />
            ))}
          </dl>
          {e.status === 'resolved' && (
            <div className="alert success" style={{ marginTop: 10, marginBottom: 0 }}>
              解決: {RESOLUTION_CODE[e.resolutionCode] ?? e.resolutionCode} {e.resolutionNote && `— ${e.resolutionNote}`}（{e.resolvedBy ?? 'システム'} / {fmtDateTime(e.resolvedAt)}）
            </div>
          )}
          {e.status === 'ignored' && (
            <div className="alert" style={{ marginTop: 10, marginBottom: 0 }}>
              対応不要: {e.ignoredReason}（{e.resolvedBy} / {fmtDateTime(e.resolvedAt)}）
            </div>
          )}
        </div>
        <div>
          {manage && active && (
            <div className="card">
              <div className="card-header">
                <h2>担当</h2>
              </div>
              <select
                aria-label="担当者"
                value={e.assigneeUserId ?? ''}
                onChange={async (ev) => {
                  try {
                    await post(`/exceptions/${id}/assign`, { userId: ev.target.value || null });
                    refresh();
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                <option value="">未割当</option>
                {users.data?.items.map((u: any) => (
                  <option key={u.userId} value={u.userId}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {e.balance && active && <HeldResolvePanel exc={e} onDone={refresh} />}
          <div className="card">
            <div className="card-header">
              <h2>対応履歴</h2>
            </div>
            <ul className="timeline">
              {e.events.map((ev: any) => (
                <li key={ev.id}>
                  <span className="small muted">{fmtDateTime(ev.at)}</span> {ev.actor ?? 'システム'} —{' '}
                  {ev.type === 'status' ? `${EXCEPTION_STATUS[ev.from]?.label ?? ev.from} → ${EXCEPTION_STATUS[ev.to]?.label ?? ev.to}` : ev.type === 'created' ? '発生' : ev.type === 'assigned' ? '担当変更' : ev.type === 'comment' ? 'コメント' : ev.type}
                  {ev.note && <div className="small">{ev.note}</div>}
                </li>
              ))}
            </ul>
            {manage && (
              <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
                <input aria-label="コメント" placeholder="調査内容などを記録（個人情報は書かない）" value={comment} onChange={(ev) => setComment(ev.target.value)} maxLength={1000} />
                <button
                  className="btn"
                  disabled={!comment.trim()}
                  onClick={async () => {
                    try {
                      await post(`/exceptions/${id}/comment`, { note: comment });
                      setComment('');
                      refresh();
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  記録
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {modal === 'resolve' && <ResolveModal onClose={() => setModal(null)} onSubmit={(b) => setStatus('resolved', b).then(() => setModal(null))} />}
      {modal === 'ignore' && <IgnoreModal onClose={() => setModal(null)} onSubmit={(reason) => setStatus('ignored', { ignoredReason: reason }).then(() => setModal(null))} />}
    </>
  );
}

const DETAIL_LABEL: Record<string, string> = {
  items: '明細',
  reason: '理由',
  note: 'メモ',
  category: '分類',
  code: 'コード',
  codes: 'コード',
  tracking: '追跡番号',
  carrier: '配送会社',
  unexpected: '想定外の品物',
  existingShipment: '使用中の荷物',
  line: '行',
  reporterRole: '報告者のロール',
};

function DetailRow({ k, v }: { k: string; v: unknown }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <>
      <dt>{DETAIL_LABEL[k] ?? k}</dt>
      <dd>
        <DetailValue value={v} />
      </dd>
    </>
  );
}

function ResolveModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: { resolutionCode: string; note: string | null }) => Promise<void> }) {
  const [code, setCode] = useState('fixed');
  const [note, setNote] = useState('');
  return (
    <Modal
      title="例外を解決"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={code === 'other' && !note.trim()} onClick={() => void onSubmit({ resolutionCode: code, note: note || null })}>
            解決にする
          </button>
        </>
      }
    >
      <Field label="解決方法" htmlFor="rs-code">
        <select id="rs-code" value={code} onChange={(e) => setCode(e.target.value)}>
          {Object.entries(RESOLUTION_CODE)
            .filter(([k]) => k !== 'auto')
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
      </Field>
      <Field label={code === 'other' ? 'メモ（必須）' : 'メモ'} htmlFor="rs-note">
        <textarea id="rs-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
}

function IgnoreModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title="対応不要にする"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={reason.trim().length < 2} onClick={() => void onSubmit(reason)}>
            対応不要にする
          </button>
        </>
      }
    >
      <Field label="理由（必須）" htmlFor="ig-reason" hint="なぜ対応が不要か、後から分かるように記録してください">
        <textarea id="ig-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
    </Modal>
  );
}

/** 在庫不整合（Short で調査中になった在庫）の解消: 紛失確定 / 発見 */
function HeldResolvePanel({ exc, onDone }: { exc: any; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const b = exc.balance;
  const [qty, setQty] = useState<number>(b.held);
  if (!can('inventory.adjust') || b.held <= 0) {
    return (
      <div className="card">
        <div className="card-header">
          <h2>在庫</h2>
        </div>
        <div className="small">
          {b.sku} @ {b.locationCode}: 在庫 {b.onHand} / 引当 {b.allocated} / 調査中 {b.held} / 引当可能 {b.available}
        </div>
      </div>
    );
  }
  const resolve = async (resolution: 'loss' | 'found') => {
    try {
      await post('/inventory/held/resolve', { balanceId: b.id, qty, resolution, reason: `${exc.number} の調査結果`, requestId: newRequestId() });
      toast.success(resolution === 'loss' ? '紛失として在庫を減らしました' : '発見として引当可能に戻しました');
      onDone();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="card">
      <div className="card-header">
        <h2>調査中の在庫</h2>
      </div>
      <p className="small">
        {b.sku} @ {b.locationCode}: 在庫 {b.onHand} / 引当 {b.allocated} / <strong>調査中 {b.held}</strong> / 引当可能 {b.available}
      </p>
      <div className="row">
        <input type="number" aria-label="数量" min={1} max={b.held} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(b.held, Number(e.target.value) || 1)))} style={{ width: 90 }} />
        <button className="btn" onClick={() => void resolve('found')}>
          見つかった（引当可能に戻す）
        </button>
        <button className="btn btn-danger" onClick={() => void resolve('loss')}>
          紛失確定（在庫を減らす）
        </button>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        在庫の処理後、この例外を「解決（在庫を調整）」にしてください。
      </p>
    </div>
  );
}
