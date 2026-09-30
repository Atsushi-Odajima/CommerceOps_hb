import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader, Pagination, StatusBadge } from '../../components/ui';
import { ExportButton } from '../../components/ExportButton';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { ORDER_STATUS } from '../../lib/labels';
import { useChannels } from '../settings/ChannelsPage';

const TABS = [
  { key: '', label: 'すべて' },
  { key: 'validation_required', label: '要確認' },
  { key: 'ready_for_allocation', label: '引当待ち' },
  { key: 'partially_allocated', label: '一部引当' },
  { key: 'allocated', label: '引当済' },
  { key: 'on_hold', label: '保留' },
  { key: 'picking', label: 'ピッキング中' },
  { key: 'picked', label: 'ピック済' },
  { key: 'packing', label: '梱包中' },
  { key: 'packed', label: '梱包済' },
  { key: 'partially_shipped', label: '一部出荷' },
  { key: 'shipped', label: '出荷済' },
  { key: 'return_in_progress', label: '返品対応中' },
  { key: 'cancelled', label: 'キャンセル' },
  { key: 'closed', label: '完了' },
];

export default function OrdersPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [offset, setOffset] = useState(0);
  const [channelId, setChannelId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const limit = 50;
  const counts = useQuery({ queryKey: ['order-counts'], queryFn: () => get<Record<string, number>>('/orders/status-counts'), refetchInterval: 30_000 });
  const channels = useChannels();
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) query.set('status', status);
  if (sp.get('q')) query.set('q', sp.get('q')!);
  if (channelId) query.set('channelId', channelId);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const list = useQuery({
    queryKey: ['orders', query.toString()],
    queryFn: () => get<{ items: any[]; total: number }>(`/orders?${query}`),
    placeholderData: keepPreviousData,
  });
  const total = Object.values(counts.data ?? {}).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHeader
        title="注文"
        actions={
          <>
            <ExportButton path="/orders/export" filename="orders.csv" params={{ status: status || undefined }} pii label="CSV 出力" />
            {can('orders.import') && (
              <Link className="btn" to="/imports/new">
                CSV 取込
              </Link>
            )}
            {can('orders.import') && (
              <Link className="btn btn-primary" to="/orders/new">
                手動で注文作成
              </Link>
            )}
          </>
        }
      />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            className={`tab ${status === t.key ? 'active' : ''}`}
            onClick={() => {
              const next = new URLSearchParams(sp);
              if (t.key) next.set('status', t.key);
              else next.delete('status');
              setSp(next);
              setOffset(0);
            }}
          >
            {t.label} <span className="muted small">{t.key ? counts.data?.[t.key] ?? 0 : total}</span>
          </button>
        ))}
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams(sp);
          if (q.trim()) next.set('q', q.trim());
          else next.delete('q');
          setSp(next);
          setOffset(0);
        }}
      >
        <div className="field" style={{ minWidth: 260 }}>
          <label htmlFor="o-q">注文番号・外部注文番号・SKU{can('orders.read_pii') ? '・顧客名・郵便番号' : ''}</label>
          <input id="o-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="o-ch">チャネル</label>
          <select id="o-ch" value={channelId} onChange={(e) => { setChannelId(e.target.value); setOffset(0); }}>
            <option value="">すべて</option>
            {channels.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="o-from">注文日（から）</label>
          <input id="o-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </div>
        <div className="field">
          <label htmlFor="o-to">注文日（まで）</label>
          <input id="o-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
        </div>
        <button className="btn">検索</button>
      </form>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.items.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>注文番号</th>
                  <th>外部注文番号 / チャネル</th>
                  <th>注文日時</th>
                  <th>状態</th>
                  {can('orders.read_pii') && <th>送付先</th>}
                  <th className="num">数量</th>
                  <th>配送方法</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/orders/${o.id}`}>{o.orderNumber}</Link>
                      {o.orderType === 'replacement' && <Badge tone="info">交換品</Badge>}
                      {o.priority > 0 && <Badge tone="danger">優先{o.priority}</Badge>}
                    </td>
                    <td>
                      <span className="mono">{o.externalOrderId}</span>
                      <div className="muted small">{o.channelName}</div>
                    </td>
                    <td className="small">{fmtDateTime(o.orderDate)}</td>
                    <td>
                      <StatusBadge map={ORDER_STATUS} value={o.status} />
                    </td>
                    {can('orders.read_pii') && (
                      <td className="small">
                        {o.recipientName} <span className="muted">{o.prefecture}</span>
                      </td>
                    )}
                    <td className="num">
                      {fmtNum(o.totalQty)}
                      <div className="muted small">{o.itemCount}明細</div>
                    </td>
                    <td className="small">{o.shippingMethod ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={limit} total={list.data.total} capped={(list.data as any).totalCapped} onChange={setOffset} />
        </>
      ) : (
        <EmptyState title="該当する注文はありません" />
      )}
    </>
  );
}
