import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api/client';
import { Barcode } from '../components/Barcode';
import { ErrorBox, Loading } from '../components/ui';
import { PrintShell } from './PrintShell';

export default function LocationLabelsPrint() {
  const { warehouseId } = useParams();
  const locs = useQuery({ queryKey: ['locations', warehouseId], queryFn: () => get<{ items: any[] }>(`/warehouses/${warehouseId}/locations`) });
  if (locs.isLoading) return <Loading />;
  return (
    <PrintShell title="ロケーションラベル">
      <ErrorBox error={locs.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4mm' }}>
        {locs.data?.items.map((l) => (
          <div key={l.id} style={{ border: '1px dashed #999', padding: '3mm', textAlign: 'center', breakInside: 'avoid' }}>
            <div style={{ fontFamily: 'monospace', fontSize: '16pt', fontWeight: 800 }}>{l.code}</div>
            <Barcode value={l.barcode} kind="code128" height={10} scale={2} showText={false} />
            <div style={{ fontSize: '8pt' }}>{l.zone ? `ゾーン ${l.zone}` : ''}</div>
          </div>
        ))}
      </div>
    </PrintShell>
  );
}
