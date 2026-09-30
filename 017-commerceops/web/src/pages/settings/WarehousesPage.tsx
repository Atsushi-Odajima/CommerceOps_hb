import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, patch, post } from '../../api/client';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { LOCATION_KIND } from '../../lib/labels';

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  postalCode: string | null;
  address: string | null;
  timezone: string;
  cutoffTime: string;
  priority: number;
  active: boolean;
}

export function useWarehouses(includeInactive = false) {
  return useQuery({
    queryKey: ['warehouses', includeInactive],
    queryFn: () => get<{ items: Warehouse[] }>(`/warehouses?includeInactive=${includeInactive}`),
  });
}

export default function WarehousesPage() {
  const whs = useWarehouses(true);
  const [edit, setEdit] = useState<Partial<Warehouse> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const current = whs.data?.items.find((w) => w.id === selected) ?? whs.data?.items[0];

  if (whs.isLoading) return <Loading />;
  return (
    <>
      <ErrorBox error={whs.error} />
      <div className="card">
        <div className="card-header">
          <h2>倉庫</h2>
          <div className="actions">
            <button className="btn btn-primary btn-sm" onClick={() => setEdit({ timezone: 'Asia/Tokyo', cutoffTime: '15:00', priority: 100, active: true })}>
              倉庫を追加
            </button>
          </div>
        </div>
        {whs.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>コード</th>
                  <th>名称</th>
                  <th>締切</th>
                  <th className="num">優先度</th>
                  <th>状態</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {whs.data.items.map((w) => (
                  <tr key={w.id} className={current?.id === w.id ? 'selected' : ''}>
                    <td className="mono">{w.code}</td>
                    <td>
                      {w.name}
                      <div className="muted small">{w.address}</div>
                    </td>
                    <td>{w.cutoffTime}</td>
                    <td className="num">{w.priority}</td>
                    <td>{w.active ? <Badge tone="success">有効</Badge> : <Badge>無効</Badge>}</td>
                    <td className="right nowrap">
                      <button className="btn btn-sm" onClick={() => setSelected(w.id)}>
                        ロケーション
                      </button>{' '}
                      <button className="btn btn-sm" onClick={() => setEdit(w)}>
                        編集
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="倉庫がありません">最初の倉庫を追加してください。返品保留・破損・DEFAULT ロケーションが自動で作成されます。</EmptyState>
        )}
      </div>
      {current && <LocationsCard warehouse={current} />}
      {edit && <WarehouseModal initial={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function WarehouseModal({ initial, onClose }: { initial: Partial<Warehouse>; onClose: () => void }) {
  const [f, setF] = useState<Partial<Warehouse>>(initial);
  const [err, setErr] = useState<unknown>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const save = async () => {
    setErr(null);
    try {
      const body = {
        code: f.code,
        name: f.name,
        postalCode: f.postalCode || null,
        address: f.address || null,
        timezone: f.timezone,
        cutoffTime: f.cutoffTime,
        priority: Number(f.priority),
        active: f.active,
      };
      if (initial.id) await patch(`/warehouses/${initial.id}`, body);
      else await post('/warehouses', body);
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
      toast.success('倉庫を保存しました');
      onClose();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal
      title={initial.id ? '倉庫を編集' : '倉庫を追加'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="コード" htmlFor="wh-code" hint="英数字（例: TKY）">
          <input id="wh-code" type="text" value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={20} />
        </Field>
        <Field label="名称" htmlFor="wh-name">
          <input id="wh-name" type="text" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} />
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="郵便番号" htmlFor="wh-zip">
          <input id="wh-zip" type="text" value={f.postalCode ?? ''} onChange={(e) => setF({ ...f, postalCode: e.target.value })} />
        </Field>
        <Field label="住所" htmlFor="wh-addr">
          <input id="wh-addr" type="text" value={f.address ?? ''} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="出荷締切時刻" htmlFor="wh-cutoff" hint="当日出荷の締切（期限の算出に使用）">
          <input id="wh-cutoff" type="time" value={f.cutoffTime ?? '15:00'} onChange={(e) => setF({ ...f, cutoffTime: e.target.value })} />
        </Field>
        <Field label="優先度" htmlFor="wh-prio" hint="小さいほど優先して引当候補になります">
          <input id="wh-prio" type="number" min={1} max={9999} value={f.priority ?? 100} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} />
        </Field>
        <Field label="タイムゾーン" htmlFor="wh-tz">
          <input id="wh-tz" type="text" value={f.timezone ?? 'Asia/Tokyo'} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active ?? true} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 有効
      </label>
    </Modal>
  );
}

function LocationsCard({ warehouse }: { warehouse: Warehouse }) {
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useQuery({
    queryKey: ['locations', warehouse.id],
    queryFn: () => get<{ items: any[] }>(`/warehouses/${warehouse.id}/locations?includeInactive=true`),
  });
  const [bulk, setBulk] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [edit, setEdit] = useState<any>(null);

  return (
    <div className="card">
      <div className="card-header">
        <h2>
          ロケーション — {warehouse.name}（{warehouse.code}）
        </h2>
        <div className="actions">
          <Link className="btn btn-sm" to={`/print/location-labels/${warehouse.id}`} target="_blank">
            ラベル印刷
          </Link>
        </div>
      </div>
      <ErrorBox error={err ?? locs.error} />
      <div className="grid grid-2">
        <div>
          {locs.isLoading ? (
            <Loading />
          ) : (
            <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>コード</th>
                    <th>バーコード</th>
                    <th>ゾーン</th>
                    <th>種別</th>
                    <th className="num">並び順</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {locs.data?.items.map((l) => (
                    <tr key={l.id}>
                      <td className="mono">
                        {l.code} {!l.active && <Badge>無効</Badge>}
                      </td>
                      <td className="mono small">{l.barcode}</td>
                      <td>{l.zone ?? '—'}</td>
                      <td>
                        <Badge tone={l.kind === 'pick' ? 'success' : l.kind === 'damaged' ? 'danger' : 'warning'}>{LOCATION_KIND[l.kind]}</Badge>
                      </td>
                      <td className="num">{l.pickSequence}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => setEdit(l)}>
                          編集
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <Field label="ロケーションを一括追加" htmlFor="loc-bulk" hint="1行に「コード,ゾーン,並び順」（ゾーン・並び順は省略可）。並び順はピッキングの巡回順です。">
            <textarea id="loc-bulk" rows={8} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'A-01-01,A\nA-01-02,A\nB-01-01,B'} />
          </Field>
          <button
            className="btn btn-primary btn-sm"
            disabled={!bulk.trim()}
            onClick={async () => {
              setErr(null);
              try {
                const r = await post(`/warehouses/${warehouse.id}/locations/bulk`, { lines: bulk.split(/\r?\n/).filter((l) => l.trim()) });
                toast.success(`${r.created}件追加しました${r.skipped ? `（既存 ${r.skipped}件はスキップ）` : ''}`);
                setBulk('');
                await qc.invalidateQueries({ queryKey: ['locations', warehouse.id] });
              } catch (e) {
                setErr(e);
              }
            }}
          >
            追加
          </button>
        </div>
      </div>
      {edit && (
        <LocationModal
          loc={edit}
          onClose={() => setEdit(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['locations', warehouse.id] })}
        />
      )}
    </div>
  );
}

function LocationModal({ loc, onClose, onSaved }: { loc: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ ...loc });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title={`ロケーション ${loc.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                await patch(`/locations/${loc.id}`, {
                  code: f.code,
                  barcode: f.barcode,
                  zone: f.zone || null,
                  kind: f.kind,
                  pickSequence: Number(f.pickSequence),
                  active: f.active,
                });
                onSaved();
                onClose();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            保存
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="コード" htmlFor="l-code">
          <input id="l-code" type="text" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </Field>
        <Field label="バーコード値" htmlFor="l-bc">
          <input id="l-bc" type="text" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="ゾーン" htmlFor="l-zone">
          <input id="l-zone" type="text" value={f.zone ?? ''} onChange={(e) => setF({ ...f, zone: e.target.value })} />
        </Field>
        <Field label="種別" htmlFor="l-kind">
          <select id="l-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(LOCATION_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="並び順" htmlFor="l-seq">
          <input id="l-seq" type="number" value={f.pickSequence} onChange={(e) => setF({ ...f, pickSequence: e.target.value })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 有効
      </label>
    </Modal>
  );
}
