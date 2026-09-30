import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ConfirmDialog, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, useToast } from '../../components/ui';
import { fmtDateTime, relativeTime } from '../../lib/format';
import { EXCEPTION_TYPE, SEVERITY } from '../../lib/labels';
import { useWarehouses } from '../settings/WarehousesPage';

/** 作業割当: 進行中の作業と担当者（1 Task = 1 active assignee）。担当数は現在の状況の見える化で、評価には使わない */
export default function AssignmentsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const whs = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [assignTask, setAssignTask] = useState<any>(null);
  const [cancelSession, setCancelSession] = useState<any>(null);
  const q = useQuery({ queryKey: ['assignments', warehouseId], queryFn: () => get(`/assignments${warehouseId ? `?warehouseId=${warehouseId}` : ''}`), refetchInterval: 20_000 });
  const excUsers = useQuery({ queryKey: ['assignable', 'exceptions.manage'], queryFn: () => get('/users/assignable?perm=exceptions.manage'), enabled: can('exceptions.manage') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['assignments'] });
  const d = q.data;
  return (
    <>
      <PageHeader title="作業割当" sub="進行中の Pick タスク・梱包・例外対応の担当者を確認し、割当・付け替え・解除を行います。作業の期限（claim）切れは自動で解除されます。" />
      <div className="filters">
        <div className="field">
          <label htmlFor="as-wh">倉庫</label>
          <select id="as-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
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
      {q.isLoading || !d ? (
        <Loading />
      ) : (
        <>
          {d.workload.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>担当者ごとの現在の作業</h2>
                <span className="small muted">進行中の件数です（作業者の評価・ランキングには使いません）</span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>作業者</th>
                    <th className="num">Pick タスク</th>
                    <th className="num">梱包</th>
                    <th className="num">例外対応</th>
                  </tr>
                </thead>
                <tbody>
                  {d.workload.map((w: any) => (
                    <tr key={w.userId}>
                      <td>{w.name}</td>
                      <td className="num">{w.pickTasks}</td>
                      <td className="num">{w.packSessions}</td>
                      <td className="num">{w.exceptions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {can('waves.manage') && (
            <div className="card">
              <div className="card-header">
                <h2>Pick タスク（{d.pickTasks.length}）</h2>
              </div>
              {d.pickTasks.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>タスク</th>
                        <th>Wave</th>
                        <th>倉庫 / ゾーン</th>
                        <th className="num">進捗</th>
                        <th>担当</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {d.pickTasks.map((t: any) => (
                        <tr key={t.id}>
                          <td className="mono">{t.taskNumber}</td>
                          <td>
                            <Link to={`/waves/${t.waveId}`}>{t.waveNumber}</Link> <span className="small muted">{t.waveLabel}</span>
                          </td>
                          <td className="small">
                            {t.warehouseCode} {t.zone ?? ''}
                          </td>
                          <td className="num">
                            {t.done} / {t.units}
                          </td>
                          <td>
                            {t.assigneeName ?? <span className="muted">未担当</span>}
                            {t.expired && <Badge tone="warning">期限切れ</Badge>}
                          </td>
                          <td className="row" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn btn-sm" onClick={() => setAssignTask(t)}>
                              {t.assigneeUserId ? '付け替え' : '割当'}
                            </button>
                            {t.assigneeUserId && (
                              <button
                                className="btn btn-sm btn-ghost"
                                onClick={async () => {
                                  try {
                                    await post(`/pick-tasks/${t.id}/unassign`, {});
                                    toast.success('担当を解除しました（進捗は保持）');
                                    refresh();
                                  } catch (e) {
                                    toast.error(e);
                                  }
                                }}
                              >
                                解除
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small">進行中の Pick タスクはありません。</p>
              )}
            </div>
          )}
          {can('fulfillment.manage') && (
            <div className="card">
              <div className="card-header">
                <h2>梱包中（{d.packSessions.length}）</h2>
              </div>
              {d.packSessions.length ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>出荷作業</th>
                      <th>注文</th>
                      <th>担当</th>
                      <th className="num">検品</th>
                      <th>開始</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.packSessions.map((s: any) => (
                      <tr key={s.id}>
                        <td className="mono">
                          <Link to={`/pack/${s.id}`}>{s.fulfillmentNumber}</Link>
                        </td>
                        <td>{s.orderNumber}</td>
                        <td>
                          {s.packerName} {s.expired && <Badge tone="warning">期限切れ</Badge>}
                        </td>
                        <td className="num">
                          {s.packed} / {s.required} {s.misScanCount > 0 && <Badge tone="warning">誤 scan {s.misScanCount}</Badge>}
                        </td>
                        <td className="small" title={fmtDateTime(s.startedAt)}>
                          {relativeTime(s.startedAt)}
                        </td>
                        <td>
                          <button className="btn btn-sm btn-ghost" onClick={() => setCancelSession(s)}>
                            中止
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">梱包中の作業はありません。</p>
              )}
            </div>
          )}
          {can('exceptions.manage') && (
            <div className="card">
              <div className="card-header">
                <h2>例外対応（未解決 {d.exceptions.length}）</h2>
              </div>
              {d.exceptions.length ? (
                <table className="table">
                  <tbody>
                    {d.exceptions.map((e: any) => (
                      <tr key={e.id}>
                        <td style={{ width: 50 }}>
                          <Badge tone={SEVERITY[e.severity]!.tone}>{SEVERITY[e.severity]!.label}</Badge>
                        </td>
                        <td>
                          <Link to={`/exceptions/${e.id}`}>{e.title}</Link>
                          <div className="small muted">
                            {EXCEPTION_TYPE[e.type]} / {e.number}
                          </div>
                        </td>
                        <td style={{ width: 200 }}>
                          <select
                            aria-label={`${e.number} の担当者`}
                            value={e.assigneeUserId ?? ''}
                            onChange={async (ev) => {
                              try {
                                await post(`/exceptions/${e.id}/assign`, { userId: ev.target.value || null });
                                refresh();
                              } catch (err) {
                                toast.error(err);
                              }
                            }}
                          >
                            <option value="">未割当</option>
                            {excUsers.data?.items.map((u: any) => (
                              <option key={u.userId} value={u.userId}>
                                {u.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="未解決の例外はありません" />
              )}
            </div>
          )}
        </>
      )}
      {assignTask && <AssignTaskModal task={assignTask} onClose={() => setAssignTask(null)} onDone={refresh} />}
      {cancelSession && (
        <ConfirmDialog
          title={`${cancelSession.fulfillmentNumber} の梱包を中止`}
          message="scan 済みの数量は 0 に戻ります（記録は履歴として残ります）。担当者に箱から商品を出してもらってください。"
          danger
          requireReason
          confirmLabel="中止する"
          onClose={() => setCancelSession(null)}
          onConfirm={async (reason) => {
            await post(`/pack/sessions/${cancelSession.id}/cancel`, { reason });
            toast.success('梱包を中止しました');
            refresh();
          }}
        />
      )}
    </>
  );
}

function AssignTaskModal({ task, onClose, onDone }: { task: any; onClose: () => void; onDone: () => void }) {
  const users = useQuery({ queryKey: ['assignable', 'pick.execute', task.warehouseId], queryFn: () => get(`/users/assignable?perm=pick.execute&warehouseId=${task.warehouseId}`) });
  const [userId, setUserId] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title={`${task.taskNumber} を割り当て`}
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
                await post(`/pick-tasks/${task.id}/assign`, { userId });
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
      <Field label="作業者（この倉庫の担当者のみ）" htmlFor="at-user">
        <select id="at-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
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
