import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api/client';
import { Barcode } from '../components/Barcode';
import { ErrorBox, Loading } from '../components/ui';
import { fmtDate } from '../lib/format';
import { PrintShell } from './PrintShell';

/** 納品書（Packing Slip）。価格は載せない（同梱用）。配送会社の送り状ではない */
export default function PackingSlipPrint() {
  const { fulfillmentId } = useParams();
  const q = useQuery({ queryKey: ['packing-slip', fulfillmentId], queryFn: () => get(`/fulfillments/${fulfillmentId}/packing-slip`) });
  if (q.isLoading) return <Loading />;
  const d = q.data;
  return (
    <PrintShell title="納品書">
      <ErrorBox error={q.error} />
      {d && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8mm' }}>
            <div>
              <h1 style={{ fontSize: '20pt', margin: '0 0 4mm' }}>納品書</h1>
              {d.shipTo && (
                <div style={{ fontSize: '11pt' }}>
                  <div>
                    〒{d.shipTo.postalCode} {d.shipTo.prefecture}
                    {d.shipTo.city}
                    {d.shipTo.address1}
                  </div>
                  {d.shipTo.address2 && <div>{d.shipTo.address2}</div>}
                  <div style={{ fontSize: '14pt', fontWeight: 700, marginTop: '2mm' }}>{d.shipTo.name} 様</div>
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', fontSize: '10pt' }}>
              <div style={{ fontWeight: 700, fontSize: '12pt' }}>{d.organizationName}</div>
              <div>注文番号: {d.orderNumber}</div>
              {d.externalOrderId && (
                <div>
                  {d.channelName} 注文番号: {d.externalOrderId}
                </div>
              )}
              <div>注文日: {fmtDate(d.orderDate)}</div>
              {d.shippingMethod && <div>配送方法: {d.shippingMethod}</div>}
              <div style={{ width: '48mm', marginLeft: 'auto', marginTop: '2mm' }}>
                <Barcode value={d.fulfillmentNumber} kind="code128" height={8} scale={2} />
              </div>
            </div>
          </div>
          <p style={{ margin: '6mm 0 3mm' }}>このたびはご注文いただきありがとうございます。下記の商品をお届けします。</p>
          <table>
            <thead>
              <tr>
                <th style={{ width: '6%' }}>No.</th>
                <th style={{ width: '24%' }}>SKU</th>
                <th>商品名</th>
                <th style={{ width: '10%', textAlign: 'right' }}>数量</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i: any, idx: number) => (
                <tr key={idx}>
                  <td>{idx + 1}</td>
                  <td style={{ fontFamily: 'monospace' }}>{i.sku}</td>
                  <td>
                    {i.name}
                    {i.variant ? ` / ${i.variant}` : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>{i.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: '3mm', fontSize: '10pt', textAlign: 'right' }}>合計 {d.items.reduce((s: number, i: any) => s + i.quantity, 0)} 点</div>
          {d.shipments.length > 1 && (
            <p style={{ fontSize: '9pt' }}>
              このご注文は {d.shipments.length} 個口でお届けします（{d.shipments.map((s: any) => `${s.shipmentNumber}: ${s.boxNo} 箱目`).join(' / ')}）。
            </p>
          )}
          <p style={{ fontSize: '8pt', color: '#555', marginTop: '8mm' }}>出荷作業番号 {d.fulfillmentNumber}</p>
        </>
      )}
    </PrintShell>
  );
}
