import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader, useToast } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';

export function useJob(jobId: number | null, onDone?: (job: any) => void) {
  const q = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => get(`/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => (query.state.data && ['succeeded', 'dead', 'failed'].includes(query.state.data.status) ? false : 1000),
  });
  useEffect(() => {
    if (q.data && ['succeeded', 'dead'].includes(q.data.status)) onDone?.(q.data);
  }, [q.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  return q;
}

export default function AllocationPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const summary = useQuery({ queryKey: ['allocation-summary'], queryFn: () => get('/allocation/summary'), refetchInterval: 20_000 });
  const [jobId, setJobId] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const job = useJob(jobId, (j) => {
    if (j.status === 'succeeded') {
      const r = j.result;
      toast.success(`引当完了: 全量 ${r.full} / 一部 ${r.partial} / 在庫なし ${r.none}（対象 ${r.considered} 件）`);
    } else toast.error(`引当に失敗しました: ${j.lastError}`);
    void qc.invalidateQueries({ queryKey: ['allocation-summary'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['order-counts'] });
  });
  const running = !!jobId && job.data && !['succeeded', 'dead'].includes(job.data.status);
  const c = summary.data?.counts;
  return (
    <>
      <PageHeader
        title="在庫引当"
        sub="全量が揃う倉庫を優先し、揃わない場合は最も多く揃う倉庫で一部引当します（設定で変更可）。複数倉庫への分割は注文画面で担当者が確定します。"
        actions={
          <button
            className="btn btn-primary"
            disabled={running}
            onClick={async () => {
              setErr(null);
              try {
                const r = await post('/allocation/run', {});
                setJobId(r.jobId);
                if (r.deduped) toast.info('実行中の引当があります。完了までお待ちください');
              } catch (e) {
                setErr(e);
              }
            }}
          >
            {running ? '引当中…' : '引当を実行'}
          </button>
        }
      />
      <ErrorBox error={err ?? summary.error} />
      {summary.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="tiles">
            <Link className="tile warn" to="/orders?status=ready_for_allocation">
              <div className="label">引当待ち</div>
              <div className="value">{fmtNum(c?.ready)}</div>
              <div className="note">在庫なしの欠品を含む</div>
            </Link>
            <Link className="tile warn" to="/orders?status=partially_allocated">
              <div className="label">一部引当</div>
              <div className="value">{fmtNum(c?.partial)}</div>
              <div className="note">全商品待ち or 先行出荷を判断</div>
            </Link>
            <Link className="tile danger" to="/orders?status=validation_required">
              <div className="label">要確認（引当対象外）</div>
              <div className="value">{fmtNum(c?.validation)}</div>
            </Link>
            <Link className="tile danger" to="/orders?status=on_hold">
              <div className="label">保留（引当対象外）</div>
              <div className="value">{fmtNum(c?.on_hold)}</div>
            </Link>
          </div>
          <div className="grid grid-2">
            <div className="card">
              <h2>不足している SKU</h2>
              {summary.data.shortages.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th className="num">未引当の需要</th>
                        <th className="num">引当可能在庫</th>
                        <th className="num">注文数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.data.shortages.map((s: any) => (
                        <tr key={s.productId}>
                          <td>
                            <code>{s.sku}</code>
                            <div className="small muted">{s.name}</div>
                          </td>
                          <td className="num">{fmtNum(s.need)}</td>
                          <td className="num">{s.available > 0 ? <Badge tone="success">{s.available}</Badge> : <Badge tone="danger">0</Badge>}</td>
                          <td className="num">{s.orders}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="不足はありません" />
              )}
              <p className="small muted">「引当可能在庫」がある SKU は、引当を実行すると確保されます。</p>
            </div>
            <div className="card">
              <h2>引当の実行履歴</h2>
              {summary.data.runs.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>開始</th>
                        <th>契機</th>
                        <th>結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.data.runs.map((r: any) => (
                        <tr key={r.id}>
                          <td className="small">
                            {fmtDateTime(r.startedAt)}
                            <div className="muted">{r.startedBy ?? 'システム'}</div>
                          </td>
                          <td>{{ manual: '手動', job: '自動', import: '取込後', order: '注文' }[r.trigger as string] ?? r.trigger}</td>
                          <td className="small">
                            {r.status === 'running' ? (
                              <Badge tone="info">実行中</Badge>
                            ) : r.status === 'failed' ? (
                              <Badge tone="danger">失敗</Badge>
                            ) : (
                              `対象 ${r.considered} / 全量 ${r.allocated} / 一部 ${r.partial} / なし ${r.unallocated}`
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="まだ実行されていません" />
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
