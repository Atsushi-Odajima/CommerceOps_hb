import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { ExportButton } from '../../components/ExportButton';
import { ErrorBox, Loading, PageHeader } from '../../components/ui';
import { addDaysISO, todayISO } from '../../lib/format';
import { DISPOSITION, EXCEPTION_TYPE, RETURN_REASON } from '../../lib/labels';
import { useWarehouses } from '../settings/WarehousesPage';

const GROUPS: { title: string; keys: string[] }[] = [
  { title: '受注・出荷', keys: ['ordersReceived', 'ordersCancelled', 'ordersShipped', 'shipments', 'unitsShipped', 'sameDayShipRate', 'onTimeShipRate', 'orderToShipHoursMedian', 'orderToShipHoursAvg', 'splitShipmentRate'] },
  { title: '倉庫作業', keys: ['waves', 'pickTasks', 'pickedUnits', 'packSessions', 'packedUnits'] },
  { title: '品質（誤出荷防止）', keys: ['pickMisScanRate', 'packMisScanRate', 'forcedPacks', 'shortPickRate', 'shortPickEvents', 'holdsPlaced', 'shortages'] },
  { title: '返品・例外', keys: ['returnRate', 'returnUnits', 'resaleRate', 'exchanges', 'exceptionResolutionHours'] },
];

export default function KpiPage() {
  const whs = useWarehouses();
  const today = todayISO();
  const [from, setFrom] = useState(addDaysISO(today, -6));
  const [to, setTo] = useState(today);
  const [warehouseId, setWarehouseId] = useState('');
  const params = new URLSearchParams({ from, to });
  if (warehouseId) params.set('warehouseId', warehouseId);
  const q = useQuery({ queryKey: ['kpi', params.toString()], queryFn: () => get(`/kpi?${params}`), placeholderData: keepPreviousData });
  const preset = (days: number) => {
    setTo(today);
    setFrom(addDaysISO(today, -(days - 1)));
  };
  const k = q.data;
  const byKey = new Map<string, any>((k?.metrics ?? []).map((m: any) => [m.key, m]));
  const maxDaily = Math.max(1, ...(k?.daily ?? []).map((d: any) => Math.max(d.orders, d.shipments)));
  return (
    <>
      <PageHeader
        title="KPI（物流オペレーション）"
        sub="率はすべて分子・分母と定義を表示します。作業者個人の評価・ランキングは行いません。"
        actions={<ExportButton path="/kpi/export" filename="kpi.csv" params={{ from, to, warehouseId: warehouseId || undefined }} requirePerm="kpi.read" />}
      />
      <div className="filters">
        <div className="field">
          <label htmlFor="kpi-from">期間（から）</label>
          <input id="kpi-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="kpi-to">期間（まで）</label>
          <input id="kpi-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="row" style={{ alignSelf: 'flex-end', gap: 6 }}>
          <button className="chip" onClick={() => preset(1)}>
            今日
          </button>
          <button className="chip" onClick={() => preset(7)}>
            7 日
          </button>
          <button className="chip" onClick={() => preset(30)}>
            30 日
          </button>
        </div>
        <div className="field">
          <label htmlFor="kpi-wh">倉庫</label>
          <select id="kpi-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">すべて</option>
            {whs.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ErrorBox error={q.error} />
      {!k ? (
        <Loading />
      ) : (
        <>
          <p className="small muted">
            期間: {k.period.from} 〜 {k.period.to}（{k.period.timezone}）{warehouseId && ' / 倉庫で絞り込み中: 注文単位の指標はその倉庫の出荷作業がある注文のみ'}
          </p>
          {GROUPS.map((g) => (
            <section key={g.title} style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>{g.title}</h2>
              <div className="kpi-grid">
                {g.keys.map((key) => {
                  const m = byKey.get(key);
                  if (!m) return null;
                  return (
                    <div key={key} className="kpi">
                      <div className="kpi-label">{m.label}</div>
                      <div className="kpi-value">
                        {m.value === null ? '—' : m.value.toLocaleString()}
                        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}> {m.value === null ? '' : m.unit}</span>
                      </div>
                      {m.denominator !== undefined && (
                        <div className="kpi-sub">
                          {m.numerator} / {m.denominator}
                        </div>
                      )}
                      {m.denominator === undefined && m.numerator !== undefined && <div className="kpi-sub">対象 {m.numerator} 件</div>}
                      <details>
                        <summary>定義</summary>
                        <div className="kpi-sub">{m.definition}</div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          <div className="grid grid-2">
            <div className="card">
              <div className="card-header">
                <h2>日別推移</h2>
                <span className="small">
                  <span style={{ color: 'var(--c-primary)' }}>■</span> 受注 <span style={{ color: 'var(--c-success)' }}>■</span> 出荷（荷物）
                </span>
              </div>
              <div className="bars" role="img" aria-label="日別の受注件数と出荷件数のグラフ">
                {k.daily.map((d: any) => (
                  <div key={d.date} style={{ flex: 1, display: 'flex', gap: 1, alignItems: 'flex-end', height: '100%' }} title={`${d.date} 受注 ${d.orders} / 出荷 ${d.shipments} / 返品 ${d.returns}`}>
                    <div className="bar" style={{ height: `${(100 * d.orders) / maxDaily}%` }} />
                    <div className="bar alt" style={{ height: `${(100 * d.shipments) / maxDaily}%` }} />
                  </div>
                ))}
              </div>
              <div className="row small muted" style={{ justifyContent: 'space-between' }}>
                <span>{k.daily[0]?.date}</span>
                <span>{k.daily[k.daily.length - 1]?.date}</span>
              </div>
              <details style={{ marginTop: 6 }}>
                <summary className="small">数値で見る</summary>
                <table className="table">
                  <thead>
                    <tr>
                      <th>日付</th>
                      <th className="num">受注</th>
                      <th className="num">出荷</th>
                      <th className="num">返品受付</th>
                    </tr>
                  </thead>
                  <tbody>
                    {k.daily.map((d: any) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td className="num">{d.orders}</td>
                        <td className="num">{d.shipments}</td>
                        <td className="num">{d.returns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
            <div>
              <div className="card">
                <div className="card-header">
                  <h2>返品理由</h2>
                </div>
                {k.returnReasons.length ? (
                  <table className="table">
                    <tbody>
                      {k.returnReasons.map((r: any) => (
                        <tr key={r.reason}>
                          <td>{RETURN_REASON[r.reason] ?? r.reason}</td>
                          <td className="num">{r.count} 件</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted small">期間内の返品はありません。</p>
                )}
                <div className="small" style={{ marginTop: 6 }}>
                  検品結果: {Object.entries(k.dispositions).map(([key, v]) => `${DISPOSITION[key]?.label ?? key} ${v}`).join(' / ')}
                </div>
              </div>
              <div className="card">
                <div className="card-header">
                  <h2>例外（種類別）</h2>
                </div>
                {k.exceptionsByType.length ? (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>種類</th>
                        <th className="num">発生</th>
                        <th className="num">解決・対応不要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {k.exceptionsByType.map((e: any) => (
                        <tr key={e.type}>
                          <td>{EXCEPTION_TYPE[e.type] ?? e.type}</td>
                          <td className="num">{e.created}</td>
                          <td className="num">{e.closed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted small">期間内の例外はありません。</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
