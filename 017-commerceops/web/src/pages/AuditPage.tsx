import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get } from '../api/client';
import { ExportButton } from '../components/ExportButton';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader, Pagination } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { AUDIT_ACTION, AUDIT_ENTITY, AUDIT_PREFIX, auditEntityLink } from '../lib/labels';

const ACTOR_TYPE: Record<string, string> = { system: 'システム', job: '自動処理' };

/**
 * 監査ログ（追記専用。変更・削除はできない）。誰が・いつ・何をしたかを確認する。
 * 氏名・住所・電話・メール等の個人情報は記録していない（注文番号・件数・理由の有無など）。
 */
export default function AuditPage() {
  const [sp, setSp] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const f = {
    action: sp.get('action') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    entityId: sp.get('entityId') ?? '',
    entityType: sp.get('entityType') ?? '',
    actorId: sp.get('actorId') ?? '',
    actorName: sp.get('actorName') ?? '',
    q: sp.get('q') ?? '',
  };
  const setFilter = (patch: Partial<typeof f>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) n.set(k, v);
      else n.delete(k);
    }
    setSp(n);
    setOffset(0);
  };
  const params = new URLSearchParams({ limit: '50', offset: String(offset) });
  for (const k of ['action', 'from', 'to', 'entityId', 'entityType', 'actorId', 'q'] as const) if (f[k]) params.set(k, f[k]);
  const list = useQuery({ queryKey: ['audit', params.toString()], queryFn: () => get(`/audit?${params}`), placeholderData: keepPreviousData });
  const items: any[] = list.data?.items ?? [];
  const exportParams = { action: f.action || undefined, from: f.from || undefined, to: f.to || undefined, entityId: f.entityId || undefined, entityType: f.entityType || undefined, actorId: f.actorId || undefined, q: f.q || undefined };
  return (
    <>
      <PageHeader
        title="監査ログ"
        sub="重要な操作（取込・引当・出荷確定・返品検品・在庫調整・権限変更・CSV 出力・バックアップ等）を記録しています。記録は追記のみで、変更・削除はできません。個人情報は記録しません。"
        actions={<ExportButton path="/audit/export" filename="audit.csv" params={exportParams} />}
      />
      <div className="filters">
        <div className="field">
          <label htmlFor="au-from">期間（開始）</label>
          <input id="au-from" type="date" value={f.from} onChange={(e) => setFilter({ from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="au-to">期間（終了）</label>
          <input id="au-to" type="date" value={f.to} onChange={(e) => setFilter({ to: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="au-action">操作の種類</label>
          <select id="au-action" value={f.action} onChange={(e) => setFilter({ action: e.target.value })}>
            <option value="">すべて</option>
            {(list.data?.prefixes ?? []).map((p: string) => (
              <option key={p} value={p}>
                {AUDIT_PREFIX[p] ?? p}
              </option>
            ))}
          </select>
        </div>
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q: q.trim() });
          }}
        >
          <label htmlFor="au-q">内容で検索</label>
          <input id="au-q" type="search" value={q} maxLength={60} placeholder="例: SO-000123、RT-000045" onChange={(e) => setQ(e.target.value)} onBlur={() => setFilter({ q: q.trim() })} />
        </form>
      </div>
      {(f.entityId || f.actorId) && (
        <div className="chips" aria-label="適用中の絞り込み">
          {f.entityId && (
            <button className="chip" onClick={() => setFilter({ entityId: '', entityType: '' })} aria-label="対象の絞り込みを解除">
              対象: {AUDIT_ENTITY[f.entityType] ?? (f.entityType || '指定')} {f.entityId.slice(0, 8)}… ✕
            </button>
          )}
          {f.actorId && (
            <button className="chip" onClick={() => setFilter({ actorId: '', actorName: '' })} aria-label="実行者の絞り込みを解除">
              実行者: {f.actorName || f.actorId.slice(0, 8)} ✕
            </button>
          )}
        </div>
      )}
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="該当する記録はありません" />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>日時</th>
                <th>実行者</th>
                <th>操作</th>
                <th>内容</th>
                <th>対象</th>
                <th>詳細</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const link = auditEntityLink(a.entityType, a.entityId);
                const meta = a.metadata && Object.keys(a.metadata).length ? a.metadata : null;
                return (
                  <tr key={a.id}>
                    <td className="nowrap small">{fmtDateTime(a.at)}</td>
                    <td className="small nowrap">
                      {a.actorUserId ? (
                        <button className="link" onClick={() => setFilter({ actorId: a.actorUserId, actorName: a.actorName ?? '' })} title="この実行者で絞り込み">
                          {a.actorName ?? '（削除されたユーザー）'}
                        </button>
                      ) : (
                        <Badge>{ACTOR_TYPE[a.actorType] ?? a.actorType}</Badge>
                      )}
                    </td>
                    <td className="small">
                      {AUDIT_ACTION[a.action] ?? a.action}
                      <div className="muted mono tiny">{a.action}</div>
                    </td>
                    <td className="small">{a.summary ?? '—'}</td>
                    <td className="small nowrap">
                      {a.entityType ? (
                        link ? (
                          <Link to={link}>{AUDIT_ENTITY[a.entityType] ?? a.entityType}を開く</Link>
                        ) : (
                          <span className="muted">{AUDIT_ENTITY[a.entityType] ?? a.entityType}</span>
                        )
                      ) : (
                        '—'
                      )}
                      {a.entityId && (
                        <>
                          <br />
                          <button className="link tiny" onClick={() => setFilter({ entityId: a.entityId, entityType: a.entityType ?? '' })} title="この対象の記録だけ表示">
                            この対象の履歴
                          </button>
                        </>
                      )}
                    </td>
                    <td className="small nowrap">
                      {meta || a.ip ? (
                        <details>
                          <summary>表示</summary>
                          {meta && <pre className="mono tiny pre-wrap">{JSON.stringify(meta, null, 2)}</pre>}
                          {a.ip && <div className="tiny muted">IP: {a.ip}</div>}
                          {a.requestId && <div className="tiny muted mono">req: {a.requestId}</div>}
                        </details>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination offset={offset} limit={50} total={list.data?.total ?? 0} onChange={setOffset} />
        </div>
      )}
    </>
  );
}
