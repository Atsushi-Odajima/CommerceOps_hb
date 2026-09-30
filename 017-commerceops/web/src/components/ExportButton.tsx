import { useState } from 'react';
import { download } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Field, Modal, useToast } from './ui';

/**
 * CSV 出力ボタン（export.csv 権限がある場合のみ表示）。文字コード（UTF-8 BOM / Shift_JIS）と、
 * 注文の場合は個人情報の範囲（本人の権限の範囲内）を選べる。
 */
export function ExportButton({
  path,
  params,
  label = 'CSV 出力',
  filename,
  pii,
  requirePerm,
}: {
  path: string;
  params?: Record<string, string | undefined>;
  label?: string;
  filename: string;
  pii?: boolean;
  requirePerm?: string;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [encoding, setEncoding] = useState('utf-8');
  const [piiLevel, setPiiLevel] = useState('none');
  const [busy, setBusy] = useState(false);
  if (!can('export.csv') || (requirePerm && !can(requirePerm))) return null;
  const run = async () => {
    setBusy(true);
    try {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params ?? {})) if (v) p.set(k, v);
      p.set('encoding', encoding);
      if (pii) p.set('pii', piiLevel);
      await download(`${path}?${p}`, filename);
      setOpen(false);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Modal
          title={label}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                キャンセル
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void run()}>
                {busy ? '出力中…' : 'ダウンロード'}
              </button>
            </>
          }
        >
          <p className="small muted">現在の絞り込み条件で出力します（最大 10 万行）。出力したことは監査ログに記録されます。</p>
          <Field label="文字コード" htmlFor="exp-enc" hint="Excel で開く場合は UTF-8（BOM 付き）で文字化けしません。古い業務ソフト向けは Shift_JIS">
            <select id="exp-enc" value={encoding} onChange={(e) => setEncoding(e.target.value)}>
              <option value="utf-8">UTF-8（BOM 付き）</option>
              <option value="shift_jis">Shift_JIS</option>
            </select>
          </Field>
          {pii && (
            <Field label="個人情報" htmlFor="exp-pii" hint="必要な範囲だけ出力してください。権限を超える範囲は出力できません">
              <select id="exp-pii" value={piiLevel} onChange={(e) => setPiiLevel(e.target.value)}>
                <option value="none">含めない（注文番号・商品・数量のみ）</option>
                {can('orders.read_ship_to') && <option value="ship_to">送付先（氏名・住所）を含める</option>}
                {can('orders.read_pii') && <option value="full">電話・メール・購入者情報も含める</option>}
              </select>
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}
