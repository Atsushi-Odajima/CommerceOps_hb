import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api/client';
import { Barcode } from '../components/Barcode';
import { ErrorBox, Loading } from '../components/ui';
import { fmtDate } from '../lib/format';
import { RETURN_REASON } from '../lib/labels';
import { PrintShell } from './PrintShell';

/** 返品受領票（RMA）。お客様への案内・返品物への同封用。倉庫では RMA コードを scan して到着登録する */
export default function ReturnSlipPrint() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['return', id], queryFn: () => get(`/returns/${id}`) });
  if (q.isLoading) return <Loading />;
  const r = q.data;
  return (
    <PrintShell title="返品受領票">
      <ErrorBox error={q.error} />
      {r && (
        <div style={{ border: '1px solid #333', padding: '6mm' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6mm' }}>
            <div>
              <h1 style={{ fontSize: '18pt', margin: 0 }}>返品受領票</h1>
              <div style={{ fontFamily: 'monospace', fontSize: '20pt', fontWeight: 800 }}>{r.returnNumber}</div>
              <div>ご注文番号: {r.orderNumber}</div>
              <div>返品理由: {RETURN_REASON[r.reasonCode]}</div>
              <div>受付日: {fmtDate(r.timeline[0]?.at)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: '56mm' }}>
                <Barcode value={r.returnNumber} kind="code128" height={12} scale={2} />
              </div>
              <div style={{ width: '24mm', margin: '2mm auto 0' }}>
                <Barcode value={r.returnNumber} kind="qrcode" scale={2} />
              </div>
            </div>
          </div>
          <h2 style={{ fontSize: '12pt', margin: '5mm 0 2mm' }}>返品いただく商品</h2>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>商品名</th>
                <th style={{ textAlign: 'right' }}>数量</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((i: any) => (
                <tr key={i.id}>
                  <td style={{ fontFamily: 'monospace' }}>{i.sku}</td>
                  <td>
                    {i.name}
                    {i.variant ? ` / ${i.variant}` : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>{i.requestedQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ol style={{ fontSize: '10pt', marginTop: '5mm' }}>
            <li>この受領票を返品する商品と一緒に箱へ入れてください。</li>
            <li>箱の外側に返品番号（{r.returnNumber}）を記入してください。</li>
            {r.warehouseName && (
              <li>
                返送先: {r.warehouseName}
                {r.warehouseAddress ? `（${r.warehouseAddress}）` : ''}
              </li>
            )}
          </ol>
          <p style={{ fontSize: '8pt', color: '#555' }}>到着後に検品し、結果に応じて対応します（返金・交換の条件はショップの規約に従います）。</p>
        </div>
      )}
    </PrintShell>
  );
}
