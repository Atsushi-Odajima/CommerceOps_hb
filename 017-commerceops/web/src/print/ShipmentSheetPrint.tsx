import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api/client';
import { Barcode } from '../components/Barcode';
import { ErrorBox, Loading } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { PrintShell } from './PrintShell';

/** Shipment 作業票（社内用: 荷物コード・箱番号・内容・追跡番号）。配送会社の送り状ではない */
export default function ShipmentSheetPrint() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['shipment', id], queryFn: () => get(`/shipments/${id}`) });
  if (q.isLoading) return <Loading />;
  const s = q.data;
  return (
    <PrintShell title="出荷作業票">
      <ErrorBox error={q.error} />
      {s && (
        <div style={{ border: '1px solid #333', padding: '6mm' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6mm' }}>
            <div>
              <h1 style={{ fontSize: '16pt', margin: 0 }}>出荷作業票</h1>
              <div style={{ fontFamily: 'monospace', fontSize: '18pt', fontWeight: 800 }}>{s.shipmentNumber}</div>
              <div>
                注文 {s.orderNumber} / 箱 {s.boxNo}
                {(() => {
                  // 同じ出荷作業（梱包）の取消していない箱だけを数える（同じ注文の別倉庫・取消した荷物は含めない）
                  const boxes = s.siblings.filter((x: any) => x.fulfillmentId === s.fulfillmentId && x.status !== 'cancelled').length + 1;
                  return boxes > 1 ? `（全 ${boxes} 箱）` : '';
                })()}
              </div>
              <div>
                倉庫 {s.warehouseCode} / 出荷作業 {s.fulfillmentNumber}
              </div>
            </div>
            <div style={{ width: '60mm' }}>
              <Barcode value={s.shipmentNumber} kind="code128" height={12} scale={2} />
            </div>
          </div>
          <table style={{ marginTop: '4mm' }}>
            <tbody>
              <tr>
                <th style={{ width: '25%' }}>配送会社</th>
                <td>{s.carrierLabel || '（未入力）'}</td>
              </tr>
              <tr>
                <th>配送方法</th>
                <td>{s.service ?? ''}</td>
              </tr>
              <tr>
                <th>追跡番号</th>
                <td style={{ fontFamily: 'monospace', fontSize: '13pt' }}>{s.noTracking ? '追跡番号なし' : (s.trackingNumber ?? '（送り状貼付後に記入）')}</td>
              </tr>
              {s.shipTo && (
                <tr>
                  <th>送付先</th>
                  <td>
                    {s.shipTo.name} 様 / 〒{s.shipTo.postalCode} {s.shipTo.prefecture}
                    {s.shipTo.city}
                    {s.shipTo.address1} {s.shipTo.address2}
                  </td>
                </tr>
              )}
              <tr>
                <th>状態</th>
                <td>{s.status === 'shipped' ? `出荷済み ${fmtDateTime(s.shippedAt)}` : '出荷待ち'}</td>
              </tr>
            </tbody>
          </table>
          <h2 style={{ fontSize: '12pt', margin: '4mm 0 2mm' }}>内容</h2>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>商品名</th>
                <th style={{ textAlign: 'right' }}>数量</th>
              </tr>
            </thead>
            <tbody>
              {s.items.map((i: any) => (
                <tr key={i.id}>
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
          <p style={{ fontSize: '8pt', color: '#555', marginTop: '4mm' }}>社内作業用です（配送会社の送り状ではありません）。出荷確定は荷物コードと追跡番号の scan、または出荷画面で行います。</p>
        </div>
      )}
    </PrintShell>
  );
}
