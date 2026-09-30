import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';

export default function OrgSettingsPage() {
  const q = useQuery({ queryKey: ['org'], queryFn: () => get('/org') });
  const carriers = useQuery({ queryKey: ['shipments-meta'], queryFn: () => get('/shipments/meta') });
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setForm(structuredClone(q.data));
  }, [q.data]);
  if (q.isLoading || !form) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = form.settings;
  const set = (path: string[], value: unknown) => {
    const next = structuredClone(form);
    let o = next;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]!] = value;
    setForm(next);
  };
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await patch('/org', { name: form.name, timezone: form.timezone, settings: form.settings });
          await qc.invalidateQueries({ queryKey: ['org'] });
          await refresh();
          toast.success('設定を保存しました');
        } catch (e2) {
          setErr(e2);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={err} />
      <div className="grid grid-2">
        <div className="card">
          <h2>組織</h2>
          <Field label="組織名" htmlFor="org-name">
            <input id="org-name" type="text" value={form.name} onChange={(e) => set(['name'], e.target.value)} maxLength={200} required />
          </Field>
          <Field label="タイムゾーン" htmlFor="org-tz" hint="「今日」や KPI の日付境界に使います（例: Asia/Tokyo）">
            <input id="org-tz" type="text" value={form.timezone} onChange={(e) => set(['timezone'], e.target.value)} />
          </Field>
          {form.isSample && <div className="alert warning">この組織はサンプル組織です。本番運用には別の組織を作成してください。</div>}
        </div>
        <div className="card">
          <h2>引当</h2>
          <label className="check">
            <input type="checkbox" checked={s.allocation.allowPartialAllocation} onChange={(e) => set(['settings', 'allocation', 'allowPartialAllocation'], e.target.checked)} />
            一部引当を許可する（全量が揃わない場合、揃う分だけ確保する）
          </label>
          <label className="check">
            <input type="checkbox" checked={s.allocation.autoReleaseFullyAllocated} onChange={(e) => set(['settings', 'allocation', 'autoReleaseFullyAllocated'], e.target.checked)} />
            全量引当になった注文を自動で Fulfillment（出荷作業）にする
          </label>
          <label className="check">
            <input type="checkbox" checked={s.allocation.autoAllocateOnImport} onChange={(e) => set(['settings', 'allocation', 'autoAllocateOnImport'], e.target.checked)} />
            CSV 取込の確定後に引当を自動実行する
          </label>
          <p className="muted small" style={{ marginTop: 8 }}>
            複数倉庫への分割引当は自動確定しません（候補を表示し、担当者が確定します）。
          </p>
        </div>
        <div className="card">
          <h2>作業割当・Wave</h2>
          <Field label="作業の担当タイムアウト（分）" htmlFor="claim-timeout" hint="操作がないまま経過すると、他の作業者が引き継げるようになります">
            <input
              id="claim-timeout"
              type="number"
              min={5}
              max={480}
              value={s.assignment.claimTimeoutMinutes}
              onChange={(e) => set(['settings', 'assignment', 'claimTimeoutMinutes'], Number(e.target.value))}
            />
          </Field>
          <Field label="1 Wave の最大 Fulfillment 数" htmlFor="wave-max">
            <input id="wave-max" type="number" min={1} max={500} value={s.wave.maxFulfillments} onChange={(e) => set(['settings', 'wave', 'maxFulfillments'], Number(e.target.value))} />
          </Field>
        </div>
        <div className="card">
          <h2>出荷</h2>
          <label className="check">
            <input type="checkbox" checked={s.shipping.requireTracking} onChange={(e) => set(['settings', 'shipping', 'requireTracking'], e.target.checked)} />
            出荷確定時に追跡番号を必須にする（追跡なしの配送は個別に「追跡番号なし」を選択）
          </label>
          <Field label="既定の配送会社" htmlFor="default-carrier" hint="追跡番号 CSV の取込で「配送会社」が空欄の行に使います">
            <select id="default-carrier" value={s.shipping.defaultCarrier ?? ''} onChange={(e) => set(['settings', 'shipping', 'defaultCarrier'], e.target.value || undefined)}>
              <option value="">指定しない</option>
              {(carriers.data?.carriers ?? []).map((c: { value: string; label: string }) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy}>
        保存
      </button>
    </form>
  );
}
