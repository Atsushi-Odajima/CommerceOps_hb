import { useState } from 'react';
import { ApiError, get } from '../api/client';
import { ErrorBox } from '../components/ui';
import { feedbackError, feedbackOk } from '../scanner/feedback';
import { ScanInput } from '../scanner/ScanInput';
import { MobileShell } from './MobileShell';

/** 商品確認（バーコード / SKU から商品と置き場所を表示）。在庫数は在庫閲覧権限がある場合のみ */
export default function ProductLookup() {
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lookup = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await get(`/products/lookup?code=${encodeURIComponent(code)}`);
      setResult({ ...r, scanned: code });
      feedbackOk();
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError && e.status === 404 ? new Error(`「${code}」に該当する商品はありません`) : e);
      feedbackError();
    } finally {
      setBusy(false);
    }
  };
  const p = result?.product;
  return (
    <MobileShell title="商品を確認" back="/m">
      <div className="big-card">
        <ScanInput id="lookup-scan" label="商品バーコード / SKU" onScan={(c) => void lookup(c)} disabled={busy} />
      </div>
      <ErrorBox error={error} />
      {p && (
        <div className="big-card" aria-live="polite">
          <div className="small muted">読取: {result.scanned}</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 800, fontFamily: 'monospace' }}>{p.sku}</div>
          <div style={{ fontWeight: 600 }}>
            {p.name}
            {p.variant ? ` / ${p.variant}` : ''}
          </div>
          {!p.active && <div className="alert warning">この商品は無効化されています</div>}
          {p.imageUrl && <img src={p.imageUrl} alt="" style={{ maxWidth: 160, maxHeight: 160, marginTop: 8 }} referrerPolicy="no-referrer" />}
          <div className="small muted" style={{ marginTop: 6 }}>
            登録コード: {p.barcodes?.map((b: any) => b.code).join(', ') || 'なし'}
          </div>
          <h3 style={{ fontSize: '1rem', margin: '12px 0 6px' }}>置き場所</h3>
          {result.locations.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>倉庫</th>
                  <th>ロケーション</th>
                  {result.locations[0].onHand !== undefined && <th className="num">在庫 / 引当可能</th>}
                </tr>
              </thead>
              <tbody>
                {result.locations.map((l: any, i: number) => (
                  <tr key={i}>
                    <td>{l.warehouseCode}</td>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                      {l.locationCode}
                      {l.kind !== 'pick' && <span className="badge warning" style={{ marginLeft: 4 }}>{l.kind === 'damaged' ? '破損' : '隔離'}</span>}
                    </td>
                    {l.onHand !== undefined && (
                      <td className="num">
                        {l.onHand} / {l.available}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">在庫のあるロケーションはありません。</p>
          )}
        </div>
      )}
    </MobileShell>
  );
}
