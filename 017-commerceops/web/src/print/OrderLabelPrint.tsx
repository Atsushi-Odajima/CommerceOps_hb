import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api/client';
import { Barcode } from '../components/Barcode';
import { ErrorBox, Loading } from '../components/ui';
import { PrintShell } from './PrintShell';

/**
 * 注文・出荷作業の識別ラベル（社内作業用）。Packing Station で読み取って梱包を開始するためのコード。
 * 配送会社の送り状ではない（公式送り状は各社のシステムで発行する）。住所・電話などの個人情報は載せない。
 */
export default function OrderLabelPrint() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => get(`/orders/${id}`) });
  if (q.isLoading) return <Loading />;
  const o = q.data;
  const ffs = (o?.fulfillments ?? []).filter((f: any) => f.status !== 'cancelled');
  return (
    <PrintShell title="注文識別コード">
      <ErrorBox error={q.error} />
      {o && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '5mm' }}>
          <div style={{ border: '1px solid #333', padding: '4mm', breakInside: 'avoid' }}>
            <div style={{ fontSize: '9pt' }}>注文番号</div>
            <div style={{ fontFamily: 'monospace', fontSize: '15pt', fontWeight: 800 }}>{o.orderNumber}</div>
            <div style={{ fontSize: '9pt' }}>
              {o.channelName} {o.externalOrderId ? `/ ${o.externalOrderId}` : ''}
            </div>
            <div style={{ display: 'flex', gap: '4mm', alignItems: 'center', marginTop: '2mm' }}>
              <div style={{ width: '50mm' }}>
                <Barcode value={o.orderNumber} kind="code128" height={10} scale={2} />
              </div>
              <div style={{ width: '22mm' }}>
                <Barcode value={o.orderNumber} kind="qrcode" scale={2} />
              </div>
            </div>
          </div>
          {ffs.map((f: any) => (
            <div key={f.id} style={{ border: '1px solid #333', padding: '4mm', breakInside: 'avoid' }}>
              <div style={{ fontSize: '9pt' }}>出荷作業番号（倉庫 {f.warehouseCode}）</div>
              <div style={{ fontFamily: 'monospace', fontSize: '15pt', fontWeight: 800 }}>{f.fulfillmentNumber}</div>
              <div style={{ fontSize: '9pt' }}>
                注文 {o.orderNumber} ・ {f.items.reduce((s: number, x: any) => s + x.requiredQty, 0)} 個 / {f.items.length} 行
                {f.waveNumber ? ` ・ ${f.waveNumber}` : ''}
              </div>
              <div style={{ display: 'flex', gap: '4mm', alignItems: 'center', marginTop: '2mm' }}>
                <div style={{ width: '50mm' }}>
                  <Barcode value={f.fulfillmentNumber} kind="code128" height={10} scale={2} />
                </div>
                <div style={{ width: '22mm' }}>
                  <Barcode value={f.fulfillmentNumber} kind="qrcode" scale={2} />
                </div>
              </div>
            </div>
          ))}
          <p style={{ gridColumn: '1 / -1', fontSize: '8pt', color: '#555' }}>
            社内作業用の識別ラベルです（配送会社の送り状ではありません）。トート・カゴ・作業指示書に貼り、Packing Station で読み取ってください。
          </p>
        </div>
      )}
    </PrintShell>
  );
}
