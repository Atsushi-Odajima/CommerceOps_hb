import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post } from '../../api/client';
import { ErrorBox, Field, PageHeader, useToast } from '../../components/ui';
import { useChannels } from '../settings/ChannelsPage';

interface Line {
  sku: string;
  quantity: number;
}

export default function NewOrderPage() {
  const channels = useChannels();
  const nav = useNavigate();
  const toast = useToast();
  const [channelId, setChannelId] = useState('');
  const [ext, setExt] = useState('');
  const [customer, setCustomer] = useState({ name: '', email: '', phone: '' });
  const [shipTo, setShipTo] = useState({ name: '', postalCode: '', prefecture: '', city: '', address1: '', address2: '', phone: '' });
  const [method, setMethod] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState(0);
  const [lines, setLines] = useState<Line[]>([{ sku: '', quantity: 1 }]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const opt = (v: string) => (v.trim() ? v.trim() : null);

  return (
    <>
      <PageHeader title="手動で注文を作成" sub="電話・卸・手動チャネルの注文。CSV 取込と同じ検証（未登録 SKU・住所不備は「要確認」）を行います。" />
      <ErrorBox error={err} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await post('/orders', {
              channelId,
              order: {
                externalOrderId: ext,
                customer: { name: opt(customer.name), email: opt(customer.email), phone: opt(customer.phone), channelCustomerId: null },
                shipTo: Object.fromEntries(Object.entries(shipTo).map(([k, v]) => [k, opt(v)])),
                shippingMethod: opt(method),
                notes: opt(notes),
                priority,
                lines: lines.filter((l) => l.sku.trim()).map((l) => ({ sku: l.sku.trim(), quantity: Number(l.quantity) })),
              },
            });
            toast.success(`${r.orderNumber} を作成しました`);
            nav(`/orders/${r.id}`);
          } catch (e2) {
            setErr(e2);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-2">
          <div className="card">
            <h2>注文</h2>
            <Field label="販売チャネル" htmlFor="no-ch">
              <select id="no-ch" value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                <option value="">選択してください</option>
                {channels.data?.items
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="外部注文番号（チャネル内で一意）" htmlFor="no-ext">
              <input id="no-ext" type="text" value={ext} onChange={(e) => setExt(e.target.value)} required maxLength={100} />
            </Field>
            <div className="inline-fields">
              <Field label="配送方法" htmlFor="no-method">
                <input id="no-method" type="text" value={method} onChange={(e) => setMethod(e.target.value)} />
              </Field>
              <Field label="優先度 (0-9)" htmlFor="no-prio">
                <input id="no-prio" type="number" min={0} max={9} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
              </Field>
            </div>
            <Field label="備考" htmlFor="no-notes">
              <textarea id="no-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
            </Field>
            <h3>購入者</h3>
            <div className="inline-fields">
              <Field label="氏名" htmlFor="no-cname">
                <input id="no-cname" type="text" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
              </Field>
              <Field label="メール" htmlFor="no-cemail">
                <input id="no-cemail" type="email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} />
              </Field>
              <Field label="電話" htmlFor="no-cphone">
                <input id="no-cphone" type="tel" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
              </Field>
            </div>
          </div>
          <div className="card">
            <h2>送付先</h2>
            <AddressFields value={shipTo} onChange={setShipTo} idPrefix="no" />
          </div>
        </div>
        <div className="card">
          <h2>明細</h2>
          {lines.map((l, i) => (
            <div key={i} className="row" style={{ marginBottom: 8 }}>
              <input type="text" aria-label={`明細${i + 1} SKU`} placeholder="SKU" value={l.sku} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))} style={{ maxWidth: 260 }} />
              <input type="number" aria-label={`明細${i + 1} 数量`} min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} style={{ maxWidth: 110 }} />
              {lines.length > 1 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  削除
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, { sku: '', quantity: 1 }])}>
            ＋ 明細を追加
          </button>
        </div>
        <button className="btn btn-primary" disabled={busy}>
          作成
        </button>
      </form>
    </>
  );
}

export function AddressFields({
  value,
  onChange,
  idPrefix,
}: {
  value: { name: string; postalCode: string; prefecture: string; city: string; address1: string; address2: string; phone: string };
  onChange: (v: any) => void;
  idPrefix: string;
}) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="氏名" htmlFor={`${idPrefix}-name`}>
        <input id={`${idPrefix}-name`} type="text" value={value.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
      </Field>
      <div className="inline-fields">
        <Field label="郵便番号" htmlFor={`${idPrefix}-zip`}>
          <input id={`${idPrefix}-zip`} type="text" inputMode="numeric" value={value.postalCode} onChange={(e) => set('postalCode', e.target.value)} placeholder="150-0001" />
        </Field>
        <Field label="都道府県" htmlFor={`${idPrefix}-pref`} hint="住所1 の先頭に含めても自動で分離します">
          <input id={`${idPrefix}-pref`} type="text" value={value.prefecture} onChange={(e) => set('prefecture', e.target.value)} />
        </Field>
      </div>
      <Field label="市区町村" htmlFor={`${idPrefix}-city`}>
        <input id={`${idPrefix}-city`} type="text" value={value.city} onChange={(e) => set('city', e.target.value)} />
      </Field>
      <Field label="住所1（番地まで）" htmlFor={`${idPrefix}-a1`}>
        <input id={`${idPrefix}-a1`} type="text" value={value.address1} onChange={(e) => set('address1', e.target.value)} />
      </Field>
      <Field label="住所2（建物名・部屋番号）" htmlFor={`${idPrefix}-a2`}>
        <input id={`${idPrefix}-a2`} type="text" value={value.address2} onChange={(e) => set('address2', e.target.value)} />
      </Field>
      <Field label="電話" htmlFor={`${idPrefix}-phone`}>
        <input id={`${idPrefix}-phone`} type="tel" value={value.phone} onChange={(e) => set('phone', e.target.value)} />
      </Field>
    </>
  );
}
