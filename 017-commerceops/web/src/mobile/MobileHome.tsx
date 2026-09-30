import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { get, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Badge, ErrorBox, Loading, useToast } from '../components/ui';
import { MobileShell } from './MobileShell';

export default function MobileHome() {
  const { me, can, logout } = useAuth();
  const nav = useNavigate();
  return (
    <MobileShell title="現場作業">
      <div className="big-card">
        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{me?.user.name}</div>
        <div className="muted small">
          {me?.organization?.name} / {me?.roleLabel}
        </div>
      </div>
      {can('pick.execute') && <TaskList compact />}
      <div className="grid grid-2" style={{ gap: 10 }}>
        <Link className="btn btn-lg btn-block" to="/m/lookup">
          商品を確認
        </Link>
        {(can('returns.receive') || can('returns.inspect')) && (
          <Link className="btn btn-lg btn-block" to="/m/returns">
            返品の到着・検品
          </Link>
        )}
        <Link className="btn btn-lg btn-block" to="/m/report">
          例外を報告
        </Link>
        {can('pack.execute') && (
          <Link className="btn btn-lg btn-block" to="/pack">
            Packing Station
          </Link>
        )}
        {(can('orders.read') || can('waves.manage')) && (
          <Link className="btn btn-lg btn-block" to="/">
            管理画面（PC 表示）
          </Link>
        )}
        <button className="btn btn-lg btn-block" onClick={() => void logout().then(() => nav('/login'))}>
          ログアウト
        </button>
      </div>
    </MobileShell>
  );
}

export function TaskListPage() {
  return (
    <MobileShell title="Pick タスク" back="/m">
      <TaskList />
    </MobileShell>
  );
}

function TaskList({ compact }: { compact?: boolean }) {
  const mine = useQuery({ queryKey: ['pick-tasks', 'mine'], queryFn: () => get('/pick-tasks?scope=mine'), refetchInterval: 15_000 });
  const available = useQuery({ queryKey: ['pick-tasks', 'available'], queryFn: () => get('/pick-tasks?scope=available'), refetchInterval: 15_000 });
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  if (!can('pick.execute')) return null;
  return (
    <>
      <h2 style={{ fontSize: '1rem', margin: '14px 0 8px' }}>自分のタスク</h2>
      <ErrorBox error={mine.error} />
      {mine.isLoading ? (
        <Loading />
      ) : mine.data?.items.length ? (
        mine.data.items.map((t: any) => (
          <Link key={t.id} to={`/m/pick/${t.id}`} className="big-card" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{t.taskNumber}</strong>
              <Badge tone="primary">作業中</Badge>
            </div>
            <div className="small muted">
              {t.waveNumber} {t.waveLabel} / {t.warehouseCode} {t.zone ? `ゾーン ${t.zone}` : ''}
            </div>
            <div className="progress" style={{ marginTop: 8 }}>
              <span style={{ width: `${t.unitCount ? (100 * t.doneUnits) / t.unitCount : 0}%` }} />
            </div>
            <div className="small">
              {t.doneUnits} / {t.unitCount} 個（{t.lineCount} 行）
            </div>
          </Link>
        ))
      ) : (
        <p className="muted small">担当中のタスクはありません。</p>
      )}
      {!compact || !mine.data?.items.length ? (
        <>
          <h2 style={{ fontSize: '1rem', margin: '14px 0 8px' }}>未担当のタスク</h2>
          {available.data?.items.length ? (
            available.data.items.map((t: any) => (
              <div key={t.id} className="big-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{t.taskNumber}</strong>
                  <span className="small muted">{t.warehouseCode}</span>
                </div>
                <div className="small muted">
                  {t.waveNumber} {t.waveLabel} / {t.lineCount} 行・{t.unitCount} 個 {t.zone ? `/ ゾーン ${t.zone}` : ''}
                </div>
                <button
                  className="btn btn-primary btn-lg btn-block"
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    try {
                      await post(`/pick-tasks/${t.id}/claim`);
                      await qc.invalidateQueries({ queryKey: ['pick-tasks'] });
                      nav(`/m/pick/${t.id}`);
                    } catch (e) {
                      toast.error(e);
                      void qc.invalidateQueries({ queryKey: ['pick-tasks'] });
                    }
                  }}
                >
                  このタスクを開始
                </button>
              </div>
            ))
          ) : (
            <p className="muted small">未担当のタスクはありません。</p>
          )}
        </>
      ) : null}
    </>
  );
}
