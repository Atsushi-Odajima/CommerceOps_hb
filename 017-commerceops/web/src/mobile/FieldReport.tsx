import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { get, newRequestId, post } from '../api/client';
import { ErrorBox, Field, useOnline } from '../components/ui';
import { ScanInput } from '../scanner/ScanInput';
import { MobileShell } from './MobileShell';

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'damaged', label: '破損品を見つけた' },
  { value: 'missing_item', label: '商品が見当たらない' },
  { value: 'location_issue', label: 'ロケーションの問題（ラベル・棚）' },
  { value: 'barcode_unreadable', label: 'バーコードが読めない' },
  { value: 'safety', label: '安全上の問題' },
  { value: 'other', label: 'その他' },
];

/** 現場からの例外報告。オフラインでは送信しない（確定操作のため） */
export default function FieldReport() {
  const [sp] = useSearchParams();
  const pickTaskId = sp.get('taskId') ?? undefined;
  const online = useOnline();
  const whs = useQuery({ queryKey: ['warehouses', 'mine'], queryFn: () => get('/warehouses'), enabled: !pickTaskId });
  const [category, setCategory] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/exceptions/report', {
        category,
        note,
        code: code || undefined,
        pickTaskId,
        warehouseId: pickTaskId ? undefined : warehouseId || undefined,
        requestId,
      });
      setDone('報告を送信しました。管理者が例外キューで確認します。');
      window.scrollTo({ top: 0 });
      setCategory('');
      setCode('');
      setNote('');
      setRequestId(newRequestId());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MobileShell title="例外を報告" back={pickTaskId ? `/m/pick/${pickTaskId}` : '/m'}>
      {done && (
        <div className="alert success" role="status">
          {done}
        </div>
      )}
      {!online && <div className="alert warning">オフラインのため送信できません。再接続してから送信してください。</div>}
      <ErrorBox error={error} />
      <div className="big-card">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>内容</legend>
          <div className="grid" style={{ gap: 8 }}>
            {CATEGORIES.map((c) => (
              <label key={c.value} className={`choice ${category === c.value ? 'selected' : ''}`}>
                <input type="radio" name="category" value={c.value} checked={category === c.value} onChange={() => setCategory(c.value)} />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
        {!pickTaskId && (
          <Field label="倉庫（任意）" htmlFor="fr-wh">
            <select id="fr-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">指定しない</option>
              {whs.data?.items?.map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.code} {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div style={{ marginTop: 10 }}>
          <ScanInput id="fr-code" label="商品またはロケーションのコード（任意）" autoFocus={false} onScan={(c) => setCode(c)} />
          {code && (
            <div className="small" style={{ marginTop: 4 }}>
              対象コード: <strong>{code}</strong>{' '}
              <button className="btn btn-sm btn-ghost" onClick={() => setCode('')}>
                取消
              </button>
            </div>
          )}
        </div>
        <Field label="メモ（任意・500文字まで）" htmlFor="fr-note" hint="お客様の氏名・住所・電話番号などの個人情報は書かないでください">
          <textarea id="fr-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={!category || busy || !online} onClick={() => void submit()}>
          報告を送信
        </button>
      </div>
    </MobileShell>
  );
}
