import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { api, get, post } from '../../api/client';
import { Badge, ConfirmDialog, EmptyState, ErrorBox, Field, Loading, PageHeader, Pagination, useToast } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { IMPORT_CLASS } from '../../lib/labels';

const BATCH_STATUS: Record<string, { label: string; tone: any }> = {
  previewed: { label: 'プレビュー中（未確定）', tone: 'warning' },
  committed: { label: '確定済', tone: 'success' },
  cancelled: { label: '取消', tone: '' },
  failed: { label: '失敗', tone: 'danger' },
  expired: { label: '期限切れ', tone: '' },
};

export default function ImportsPage() {
  const [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: ['imports', offset], queryFn: () => get(`/imports?limit=30&offset=${offset}`), placeholderData: keepPreviousData });
  return (
    <>
      <PageHeader
        title="注文取込（CSV）"
        sub="ファイル → 文字コード → Profile → プレビュー → 検証 → 重複/競合判定 → 確定。確定するまで注文は作成されません。"
        actions={
          <Link className="btn btn-primary" to="/imports/new">
            新しい取込
          </Link>
        }
      />
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.items.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>取込番号</th>
                  <th>チャネル / Profile</th>
                  <th>ファイル</th>
                  <th>状態</th>
                  <th className="num">注文</th>
                  <th>結果</th>
                  <th>作成</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((b: any) => (
                  <tr key={b.id}>
                    <td>
                      <Link to={`/imports/${b.id}`}>{b.batchNumber}</Link>
                    </td>
                    <td>
                      {b.channelName}
                      <div className="muted small">{b.profileName}</div>
                    </td>
                    <td className="small">{b.filename}</td>
                    <td>
                      <Badge tone={BATCH_STATUS[b.status]?.tone}>{BATCH_STATUS[b.status]?.label ?? b.status}</Badge>
                    </td>
                    <td className="num">{fmtNum(b.orderCount)}</td>
                    <td className="small">
                      {b.summary?.commit ? `新規 ${b.summary.commit.created} / 更新 ${b.summary.commit.updated} / 重複 ${b.summary.commit.skippedIdentical} / 競合 ${b.summary.commit.conflicts}` : '—'}
                    </td>
                    <td className="small">
                      {fmtDateTime(b.createdAt)}
                      <div className="muted">{b.createdBy}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={30} total={list.data.total} onChange={setOffset} />
        </>
      ) : (
        <EmptyState title="取込履歴はありません">「新しい取込」から CSV を取り込んでください。</EmptyState>
      )}
    </>
  );
}

export function NewImportPage() {
  const profiles = useQuery({ queryKey: ['import-profiles', ''], queryFn: () => get<{ items: any[] }>('/import-profiles') });
  const [profileId, setProfileId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const nav = useNavigate();
  const activeProfiles = profiles.data?.items.filter((p) => p.active) ?? [];
  return (
    <>
      <PageHeader title="新しい取込" sub="手順 1/2: Profile とファイルを選んでプレビュー" />
      <ErrorBox error={err} />
      <div className="card">
        {profiles.isLoading ? (
          <Loading />
        ) : activeProfiles.length === 0 ? (
          <div className="alert warning">
            Import Profile がありません。<Link to="/settings/import-profiles/new">設定 → Import Profile</Link> で作成してください（Owner 権限）。
          </div>
        ) : (
          <>
            <Field label="Import Profile（チャネル）" htmlFor="imp-profile">
              <select id="imp-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">選択してください</option>
                {activeProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.channelName} — {p.name}（{p.encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="注文 CSV ファイル" htmlFor="imp-file" hint="同じファイルの二重取込はできません。最大 20MB / 10 万行。">
              <input id="imp-file" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <button
              className="btn btn-primary"
              disabled={!profileId || !file || busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const fd = new FormData();
                  fd.append('profileId', profileId);
                  fd.append('file', file!);
                  const r = await api('/imports/preview', { method: 'POST', body: fd });
                  nav(`/imports/${r.batchId}`);
                } catch (e) {
                  setErr(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '解析中…' : 'プレビュー'}
            </button>
          </>
        )}
      </div>
    </>
  );
}

export function ImportDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const batch = useQuery({ queryKey: ['import', id], queryFn: () => get(`/imports/${id}`) });
  const [cls, setCls] = useState('');
  const [offset, setOffset] = useState(0);
  const rows = useQuery({
    queryKey: ['import-orders', id, cls, offset],
    queryFn: () => get(`/imports/${id}/orders?limit=100&offset=${offset}${cls ? `&classification=${cls}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const [apply, setApply] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  if (batch.isLoading) return <Loading />;
  if (batch.error) return <ErrorBox error={batch.error} />;
  const b = batch.data;
  const s = b.summary;
  const previewed = b.status === 'previewed';

  return (
    <>
      <PageHeader
        title={`取込 ${b.batchNumber}`}
        sub={`${b.channelName} / ${b.profileName}（v${b.profileVersion}） / ${b.filename} / ${b.encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'} / ${fmtNum(b.rowCount)}行`}
        actions={
          previewed ? (
            <>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await post(`/imports/${id}/cancel`);
                    toast.info('取込を取り消しました');
                    nav('/imports');
                  } catch (e) {
                    setErr(e);
                  }
                }}
              >
                取消
              </button>
              <button className="btn btn-primary" onClick={() => setConfirm(true)}>
                確定する
              </button>
            </>
          ) : (
            <Badge tone={BATCH_STATUS[b.status]?.tone}>{BATCH_STATUS[b.status]?.label}</Badge>
          )
        }
      />
      <ErrorBox error={err} />
      <div className="tiles">
        {Object.entries(IMPORT_CLASS).map(([k, v]) => (
          <button key={k} className="tile" style={{ textAlign: 'left', cursor: 'pointer', borderColor: cls === k ? 'var(--c-primary)' : undefined }} onClick={() => { setCls(cls === k ? '' : k); setOffset(0); }}>
            <div className="label">{v.label}</div>
            <div className="value">{fmtNum(s.byClass?.[k] ?? 0)}</div>
            <div className="note">{v.help}</div>
          </button>
        ))}
      </div>
      {previewed && (
        <div className="alert info">
          確定すると <strong>新規 {fmtNum(s.newOrders)} 件（{fmtNum(s.newLines)} 明細・合計数量 {fmtNum(s.newQty)}）</strong> を作成します
          {s.newWithValidationIssues > 0 && <>（うち {s.newWithValidationIssues} 件は「要確認」）</>}。更新候補は選択したものだけ更新します。
          競合・取消候補は注文を変更せず例外キューに登録します。
        </div>
      )}
      {b.summary?.commit && (
        <div className="alert success">
          確定結果: 新規 {b.summary.commit.created}（要確認 {b.summary.commit.createdValidationRequired}） / 更新 {b.summary.commit.updated} / 重複スキップ{' '}
          {b.summary.commit.skippedIdentical} / 更新見送り {b.summary.commit.skippedUpdateNotApplied} / 競合 {b.summary.commit.conflicts} / 取消候補{' '}
          {b.summary.commit.cancelCandidates} / エラー {b.summary.commit.invalidSkipped}
        </div>
      )}
      {s.orphanRowCount > 0 && (
        <div className="alert danger">
          注文番号を読み取れない行が {s.orphanRowCount} 行あります（取り込まれません）:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {s.orphanRows.slice(0, 10).map((r: any) => (
              <li key={r.line}>
                {r.line}行目: {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="card">
        <div className="card-header">
          <h2>注文ごとの判定 {cls && <Badge tone={IMPORT_CLASS[cls]?.tone}>{IMPORT_CLASS[cls]?.label}</Badge>}</h2>
        </div>
        {rows.isLoading ? (
          <Loading />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {previewed && <th>更新</th>}
                    <th>外部注文番号</th>
                    <th>判定</th>
                    <th>明細</th>
                    <th>送付先</th>
                    <th>行</th>
                    <th>エラー / 注意</th>
                    {!previewed && <th>結果</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.data?.items.map((r: any) => (
                    <tr key={r.id}>
                      {previewed && (
                        <td>
                          {r.classification === 'update_candidate' && (
                            <input
                              type="checkbox"
                              aria-label={`${r.externalOrderId} を更新する`}
                              checked={apply.has(r.id)}
                              onChange={(e) => {
                                const next = new Set(apply);
                                if (e.target.checked) next.add(r.id);
                                else next.delete(r.id);
                                setApply(next);
                              }}
                            />
                          )}
                        </td>
                      )}
                      <td className="mono">
                        {r.existingOrderId ? <Link to={`/orders/${r.existingOrderId}`}>{r.externalOrderId}</Link> : r.externalOrderId}
                      </td>
                      <td>
                        <Badge tone={IMPORT_CLASS[r.classification]?.tone}>{IMPORT_CLASS[r.classification]?.label}</Badge>
                        {r.changed?.length > 0 && <div className="small muted">変更: {r.changed.join('・')}</div>}
                      </td>
                      <td className="small">
                        {r.lines.map((l: any, i: number) => (
                          <div key={i}>
                            <code>{l.sku}</code> × {l.quantity}
                          </div>
                        ))}
                      </td>
                      <td className="small">
                        {r.recipientName} {r.prefecture}
                      </td>
                      <td className="small">{r.rowNumbers.join(', ')}</td>
                      <td className="small">
                        {r.errors.map((e: any, i: number) => (
                          <div key={`e${i}`} style={{ color: 'var(--c-danger)' }}>
                            {e.line ? `${e.line}行目 ` : ''}
                            {e.message}
                          </div>
                        ))}
                        {r.warnings.map((w: any, i: number) => (
                          <div key={`w${i}`} style={{ color: 'var(--c-warning)' }}>
                            {w.line ? `${w.line}行目 ` : ''}
                            {w.message}
                          </div>
                        ))}
                      </td>
                      {!previewed && (
                        <td className="small">
                          {r.resultOrderId ? <Link to={`/orders/${r.resultOrderId}`}>{RESULT_LABEL[r.result] ?? r.result}</Link> : RESULT_LABEL[r.result] ?? r.result ?? '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={offset} limit={100} total={rows.data?.total ?? 0} onChange={setOffset} />
          </>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="取込を確定"
          message={
            <>
              <p>
                新規 <strong>{s.newOrders}</strong> 件を作成し、更新候補 <strong>{apply.size}</strong> 件を更新します。
              </p>
              <p className="muted small">失敗した場合はすべて取り消され、既存データは変更されません。</p>
            </>
          }
          confirmLabel="確定する"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            const r = await post(`/imports/${id}/commit`, { applyUpdateIds: [...apply] });
            toast.success(`取込を確定しました（新規 ${r.created} 件）${r.allocationJobId ? '。引当を開始しました' : ''}`);
            await qc.invalidateQueries({ queryKey: ['import', id] });
            await qc.invalidateQueries({ queryKey: ['import-orders', id] });
            await qc.invalidateQueries({ queryKey: ['imports'] });
          }}
        />
      )}
    </>
  );
}

const RESULT_LABEL: Record<string, string> = {
  created: '作成',
  updated: '更新',
  identical_skipped: '重複スキップ',
  update_not_applied: '更新見送り',
  conflict_exception: '競合（例外登録）',
  cancel_candidate_exception: '取消候補（例外登録）',
  invalid_skipped: 'エラーのため未取込',
  cancelled_in_source_skipped: '取消済みのため未取込',
};
