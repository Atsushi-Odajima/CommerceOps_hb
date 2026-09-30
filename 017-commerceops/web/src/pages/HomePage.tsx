import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get } from '../api/client';
import { useAuth, useMe } from '../auth/AuthContext';
import { Badge, ErrorBox, Loading, PageHeader } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { EXCEPTION_TYPE, SEVERITY } from '../lib/labels';

interface Tile {
  key: string;
  label: string;
  to: string;
  tone?: 'danger' | 'warning' | 'info';
  hint?: string;
}

const GROUPS: { title: string; tiles: Tile[] }[] = [
  {
    title: '注文',
    tiles: [
      { key: 'todayOrders', label: '今日の注文', to: '/orders' },
      { key: 'todayImports', label: '今日の取込', to: '/imports' },
      { key: 'validationRequired', label: '要確認（未検証）', to: '/orders?status=validation_required', tone: 'warning' },
      { key: 'readyForAllocation', label: '引当待ち', to: '/orders?status=ready_for_allocation', tone: 'info' },
      { key: 'partiallyAllocated', label: '一部引当', to: '/orders?status=partially_allocated', tone: 'warning' },
      { key: 'shortage', label: '欠品', to: '/exceptions?type=shortage&status=active', tone: 'danger' },
      { key: 'onHold', label: '保留', to: '/orders?status=on_hold', tone: 'warning' },
    ],
  },
  {
    title: '倉庫作業',
    tiles: [
      { key: 'waveWaiting', label: 'Wave 待ち', to: '/waves/new', tone: 'info' },
      { key: 'picking', label: 'ピッキング中', to: '/fulfillments?status=picking' },
      { key: 'packing', label: '梱包待ち・梱包中', to: '/pack' },
      { key: 'awaitingShipment', label: '出荷待ち', to: '/shipments?status=draft', tone: 'info' },
      { key: 'shippedToday', label: '今日の出荷', to: '/shipments?status=shipped' },
      { key: 'overdue', label: '出荷期限超過', to: '/fulfillments', tone: 'danger', hint: '倉庫の締切時刻から算出した期限を過ぎた未出荷の出荷作業' },
      { key: 'myPickTasks', label: '自分の Pick タスク', to: '/m/tasks' },
      { key: 'availablePickTasks', label: '未担当の Pick タスク', to: '/m/tasks' },
    ],
  },
  {
    title: '返品・例外',
    tiles: [
      { key: 'returnsToAuthorize', label: '返品 承認待ち', to: '/returns?status=to_authorize' },
      { key: 'returnsToReceive', label: '返品 到着待ち', to: '/returns?status=to_receive' },
      { key: 'returnsToInspect', label: '返品 検品待ち', to: '/returns?status=to_inspect', tone: 'warning' },
      { key: 'exceptionsOpen', label: '例外（未解決）', to: '/exceptions?status=active', tone: 'danger' },
      { key: 'exceptionsHigh', label: '例外（重要度 高）', to: '/exceptions?status=active&severity=high', tone: 'danger' },
    ],
  },
];

export default function HomePage() {
  const me = useMe();
  const { can } = useAuth();
  const home = useQuery({ queryKey: ['home'], queryFn: () => get('/dashboard/home'), refetchInterval: 60_000 });
  const recent = useQuery({
    queryKey: ['home-exceptions'],
    queryFn: () => get('/exceptions?status=active&limit=8'),
    enabled: can('exceptions.read'),
    refetchInterval: 60_000,
  });
  const counts: Record<string, number> = home.data?.counts ?? {};
  return (
    <>
      <PageHeader title="ホーム" sub={`${me.organization.name} のオペレーション状況${home.data ? `（${fmtDateTime(home.data.generatedAt)} 時点）` : ''}`} />
      <ErrorBox error={home.error} />
      {home.isLoading ? (
        <Loading />
      ) : (
        GROUPS.map((g) => {
          const tiles = g.tiles.filter((t) => counts[t.key] !== undefined);
          if (!tiles.length) return null;
          return (
            <section key={g.title} style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>{g.title}</h2>
              <div className="tiles">
                {tiles.map((t) => {
                  const n = counts[t.key] ?? 0;
                  return (
                    <Link key={t.key} to={t.to} className={`tile ${n > 0 && t.tone ? `tone-${t.tone}` : ''}`} title={t.hint}>
                      <span className="tile-label">{t.label}</span>
                      <span className="tile-value">{n.toLocaleString()}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
      {can('exceptions.read') && (recent.data?.items?.length ?? 0) > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>未解決の例外</h2>
            <Link to="/exceptions?status=active" className="small">
              すべて見る
            </Link>
          </div>
          <table className="table">
            <tbody>
              {recent.data.items.map((e: any) => (
                <tr key={e.id}>
                  <td style={{ width: 60 }}>
                    <Badge tone={SEVERITY[e.severity]!.tone}>{SEVERITY[e.severity]!.label}</Badge>
                  </td>
                  <td>
                    <Link to={`/exceptions/${e.id}`}>{e.title}</Link>
                    <div className="small muted">
                      {EXCEPTION_TYPE[e.type]} / {e.number}
                    </div>
                  </td>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmtDateTime(e.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
