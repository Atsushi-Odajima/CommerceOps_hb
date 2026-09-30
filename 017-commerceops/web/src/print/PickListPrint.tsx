import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api/client';
import { Barcode } from '../components/Barcode';
import { ErrorBox, Loading } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { PrintShell } from './PrintShell';

/** 紙のピッキングリスト（タスク別・ロケーション順）。個人情報は載せない */
export default function PickListPrint() {
  const { waveId } = useParams();
  const q = useQuery({ queryKey: ['pick-list', waveId], queryFn: () => get(`/waves/${waveId}/pick-list`) });
  if (q.isLoading) return <Loading />;
  const d = q.data;
  const tasks = new Map<string, any[]>();
  for (const l of d?.lines ?? []) {
    const arr = tasks.get(l.taskNumber) ?? [];
    arr.push(l);
    tasks.set(l.taskNumber, arr);
  }
  return (
    <PrintShell title="ピッキングリスト">
      <ErrorBox error={q.error} />
      {d && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4mm' }}>
            <div>
              <h1 style={{ fontSize: '16pt', margin: 0 }}>ピッキングリスト {d.waveNumber}</h1>
              <div>
                {d.label} / 倉庫 {d.warehouseCode} {d.warehouseName} / 作成 {fmtDateTime(d.createdAt)}
              </div>
            </div>
            <div style={{ width: '48mm', flexShrink: 0 }}>
              <Barcode value={d.waveNumber} kind="code128" height={8} scale={2} />
            </div>
          </div>
          {[...tasks.entries()].map(([taskNumber, lines], idx) => (
            <section key={taskNumber} className={idx < tasks.size - 1 ? 'page-break' : ''} style={{ marginBottom: '6mm' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '13pt', margin: '2mm 0' }}>タスク {taskNumber}</h2>
                <div style={{ width: '44mm', flexShrink: 0 }}>
                  <Barcode value={taskNumber} kind="code128" height={7} scale={2} />
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '4%' }}>✓</th>
                    <th style={{ width: '24%' }}>ロケーション</th>
                    <th>SKU / 商品</th>
                    <th style={{ width: '8%', textAlign: 'right' }}>数量</th>
                    <th style={{ width: '22%' }}>出荷番号</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} style={{ breakInside: 'avoid' }}>
                      <td>□</td>
                      <td>
                        <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '13pt' }}>{l.locationCode}</div>
                        {l.zone && <div style={{ fontSize: '8pt' }}>ゾーン {l.zone}</div>}
                      </td>
                      <td>
                        <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.sku}</div>
                        <div style={{ fontSize: '9pt' }}>
                          {l.name}
                          {l.variant ? ` / ${l.variant}` : ''}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '14pt' }}>{l.qty}</td>
                      <td style={{ fontSize: '8pt' }}>{l.fulfillments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: '9pt', marginTop: '2mm' }}>
                合計 {lines.reduce((s, l) => s + l.qty, 0)} 個 / {lines.length} 行 ・ 作業者: ____________ ・ 開始 ____:____ 終了 ____:____
              </div>
            </section>
          ))}
          <p style={{ fontSize: '8pt', color: '#555' }}>
            紙リストで作業した場合も、実績はスマホ Pick またはハンディスキャナで記録してください（紙のチェックだけでは在庫・進捗に反映されません）。
          </p>
        </>
      )}
    </PrintShell>
  );
}
