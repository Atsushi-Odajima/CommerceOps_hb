import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get } from '../api/client';
import { EmptyState, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { EXCEPTION_STATUS, EXCEPTION_TYPE, ORDER_STATUS, RETURN_STATUS, SHIPMENT_STATUS, carrierLabel } from '../lib/labels';

/** 横断検索（権限のあるデータのみ表示） */
export default function SearchPage() {
  const [sp] = useSearchParams();
  const q = sp.get('q')?.trim() ?? '';
  const r = useQuery({ queryKey: ['search', q], queryFn: () => get(`/search?q=${encodeURIComponent(q)}`), enabled: q.length > 0 });
  const res = r.data?.results ?? {};
  return (
    <>
      <PageHeader
        title={`検索: ${q}`}
        sub="注文番号・外部注文番号・SKU・商品名・顧客名・郵便番号・追跡番号・返品/Wave/荷物/出荷作業/例外番号で検索できます（権限のある情報だけ表示）。氏名は姓から入力すると全期間、名前の一部だけの場合は直近 1 万件の注文から探します。"
      />
      <ErrorBox error={r.error} />
      {!q ? (
        <EmptyState title="上の検索欄にキーワードを入力してください" />
      ) : r.isLoading ? (
        <Loading />
      ) : r.data?.total === 0 ? (
        <EmptyState title="見つかりませんでした">番号は完全一致、名前・商品名は 2 文字以上の部分一致で検索します。</EmptyState>
      ) : (
        <>
          {res.orders?.length > 0 && (
            <Section title={`注文（${res.orders.length}）`}>
              <table className="table">
                <tbody>
                  {res.orders.map((o: any) => (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/orders/${o.id}`}>{o.orderNumber}</Link> <span className="small muted">{o.externalOrderId}</span>
                      </td>
                      <td>{o.channelName}</td>
                      <td>{o.recipientName ?? ''}</td>
                      <td>
                        <StatusBadge map={ORDER_STATUS} value={o.status} />
                      </td>
                      <td className="small muted">{o.matched}で一致</td>
                      <td className="small">{fmtDateTime(o.orderDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          {res.shipments?.length > 0 && (
            <Section title={`荷物（${res.shipments.length}）`}>
              <table className="table">
                <tbody>
                  {res.shipments.map((s: any) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/shipments/${s.id}`} className="mono">
                          {s.shipmentNumber}
                        </Link>
                      </td>
                      <td>{s.orderNumber}</td>
                      <td>
                        {carrierLabel(s.carrier)} <span className="mono">{s.trackingNumber}</span>
                      </td>
                      <td>
                        <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          {res.products?.length > 0 && (
            <Section title={`商品（${res.products.length}）`}>
              <table className="table">
                <tbody>
                  {res.products.map((p: any) => (
                    <tr key={p.id}>
                      <td className="mono">{p.sku}</td>
                      <td>
                        {p.name}
                        {p.variant ? ` / ${p.variant}` : ''}
                      </td>
                      <td className="small muted">{p.active ? '' : '無効'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Link className="small" to="/inventory/products">
                商品一覧へ
              </Link>
            </Section>
          )}
          {res.returns?.length > 0 && (
            <Section title={`返品（${res.returns.length}）`}>
              {res.returns.map((x: any) => (
                <div key={x.id} className="row">
                  <Link to={`/returns/${x.id}`} className="mono">
                    {x.returnNumber}
                  </Link>{' '}
                  {x.orderNumber} <StatusBadge map={RETURN_STATUS} value={x.status} />
                </div>
              ))}
            </Section>
          )}
          {res.waves?.length > 0 && (
            <Section title={`Wave（${res.waves.length}）`}>
              {res.waves.map((w: any) => (
                <div key={w.id}>
                  <Link to={`/waves/${w.id}`}>{w.waveNumber}</Link> {w.label}
                </div>
              ))}
            </Section>
          )}
          {res.fulfillments?.length > 0 && (
            <Section title={`出荷作業（${res.fulfillments.length}）`}>
              {res.fulfillments.map((f: any) => (
                <div key={f.id}>
                  <span className="mono">{f.fulfillmentNumber}</span> {f.orderId ? <Link to={`/orders/${f.orderId}`}>{f.orderNumber}</Link> : f.orderNumber} {f.status}
                </div>
              ))}
            </Section>
          )}
          {res.exceptions?.length > 0 && (
            <Section title={`例外（${res.exceptions.length}）`}>
              {res.exceptions.map((e: any) => (
                <div key={e.id} className="row">
                  <Link to={`/exceptions/${e.id}`}>{e.title}</Link> {EXCEPTION_TYPE[e.type]} <StatusBadge map={EXCEPTION_STATUS} value={e.status} />
                </div>
              ))}
            </Section>
          )}
          {res.imports?.length > 0 && (
            <Section title={`取込（${res.imports.length}）`}>
              {res.imports.map((i: any) => (
                <div key={i.id}>
                  <Link to={`/imports/${i.id}`}>{i.batchNumber}</Link> {i.filename}
                </div>
              ))}
            </Section>
          )}
        </>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}
