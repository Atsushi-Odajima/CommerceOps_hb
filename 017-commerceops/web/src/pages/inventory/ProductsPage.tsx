import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get, patch, post, del } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, Pagination, useToast } from '../../components/ui';
import { fmtNum } from '../../lib/format';

export default function ProductsPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState('true');
  const [edit, setEdit] = useState<any>(null);
  const [importOpen, setImportOpen] = useState(false);
  const limit = 50;
  const list = useQuery({
    queryKey: ['products', query, active, offset],
    queryFn: () => get<{ items: any[]; total: number }>(`/products?limit=${limit}&offset=${offset}&active=${active}${query ? `&q=${encodeURIComponent(query)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const canEdit = can('products.manage');
  const withStock = can('inventory.read');

  return (
    <div className="card">
      <div className="card-header">
        <h2>商品（SKU）</h2>
        <div className="actions">
          <Link className="btn btn-sm" to="/inventory/products/image-check">
            商品画像チェック
          </Link>
          {canEdit && (
            <>
              <button className="btn btn-sm" onClick={() => setImportOpen(true)}>
                CSV 取込
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setEdit({ active: true, barcodes: [] })}>
                商品を追加
              </button>
            </>
          )}
        </div>
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(q.trim());
        }}
      >
        <div className="field">
          <label htmlFor="p-q">検索（SKU・商品名・バーコード）</label>
          <input id="p-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-active">状態</label>
          <select id="p-active" value={active} onChange={(e) => { setActive(e.target.value); setOffset(0); }}>
            <option value="true">有効</option>
            <option value="false">無効</option>
            <option value="all">すべて</option>
          </select>
        </div>
        <button className="btn">検索</button>
      </form>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.items.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>商品名</th>
                  <th>バーコード</th>
                  {withStock && <th className="num">在庫（販売可能ロケ）</th>}
                  {withStock && <th className="num">引当可能</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">
                      {p.sku} {!p.active && <Badge>無効</Badge>}
                    </td>
                    <td>
                      {p.name}
                      {p.variant && <div className="muted small">{p.variant}</div>}
                    </td>
                    <td className="mono small">{(p.barcodes ?? []).map((b: any) => b.code).join(', ') || '—'}</td>
                    {withStock && <td className="num">{fmtNum(p.onHand)}</td>}
                    {withStock && <td className="num">{fmtNum(p.available)}</td>}
                    <td className="right">
                      <button className="btn btn-sm" onClick={() => setEdit(p)}>
                        {canEdit ? '編集' : '詳細'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination offset={offset} limit={limit} total={list.data.total} onChange={setOffset} />
        </>
      ) : (
        <EmptyState title="商品がありません">{canEdit ? '商品を追加するか、商品CSVテンプレートで一括登録してください。' : ''}</EmptyState>
      )}
      {edit && <ProductModal initial={edit} readOnly={!canEdit} onClose={() => setEdit(null)} />}
      {importOpen && <ProductImportModal onClose={() => setImportOpen(false)} />}
    </div>
  );
}

function ProductModal({ initial, readOnly, onClose }: { initial: any; readOnly: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['product', initial.id], queryFn: () => get(`/products/${initial.id}`), enabled: !!initial.id });
  const [f, setF] = useState<any>({ ...initial });
  const [newCode, setNewCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const barcodes = detail.data?.barcodes ?? [];
  const save = async () => {
    setErr(null);
    try {
      const body = {
        sku: f.sku,
        name: f.name,
        variant: f.variant || null,
        groupCode: f.groupCode || null,
        imageUrl: f.imageUrl || null,
        weightG: f.weightG === '' || f.weightG === null || f.weightG === undefined ? null : Number(f.weightG),
        active: f.active,
      };
      if (initial.id) await patch(`/products/${initial.id}`, body);
      else await post('/products', { ...body, barcodes: newCode ? [{ code: newCode }] : [] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      toast.success('保存しました');
      onClose();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal
      title={initial.id ? `商品 ${initial.sku}` : '商品を追加'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            閉じる
          </button>
          {!readOnly && (
            <button className="btn btn-primary" onClick={() => void save()}>
              保存
            </button>
          )}
        </>
      }
    >
      <ErrorBox error={err} />
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="inline-fields">
          <Field label="SKU" htmlFor="pm-sku">
            <input id="pm-sku" type="text" value={f.sku ?? ''} onChange={(e) => setF({ ...f, sku: e.target.value })} maxLength={64} />
          </Field>
          <Field label="商品名" htmlFor="pm-name">
            <input id="pm-name" type="text" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} />
          </Field>
        </div>
        <div className="inline-fields">
          <Field label="バリエーション" htmlFor="pm-var" hint="例: Red / M">
            <input id="pm-var" type="text" value={f.variant ?? ''} onChange={(e) => setF({ ...f, variant: e.target.value })} />
          </Field>
          <Field label="商品グループ" htmlFor="pm-group" hint="同じ商品の別バリエーションに同じ値を設定すると、梱包時に「別variant」と警告できます">
            <input id="pm-group" type="text" value={f.groupCode ?? ''} onChange={(e) => setF({ ...f, groupCode: e.target.value })} />
          </Field>
          <Field label="重量(g)" htmlFor="pm-w">
            <input id="pm-w" type="number" min={0} value={f.weightG ?? ''} onChange={(e) => setF({ ...f, weightG: e.target.value })} />
          </Field>
        </div>
        <Field label="画像URL（任意・https）" htmlFor="pm-img">
          <input id="pm-img" type="url" value={f.imageUrl ?? ''} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 有効
        </label>
      </fieldset>
      <hr className="divider" />
      <h3>バーコード（JAN/EAN・社内コード等）</h3>
      {initial.id ? (
        <>
          {barcodes.length === 0 && <p className="muted small">登録なし（SKU そのものでもスキャンできます）</p>}
          {barcodes.map((b: any) => (
            <div key={b.id} className="row">
              <code>{b.code}</code> <Badge>{b.symbology}</Badge>
              {!readOnly && (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    await del(`/products/${initial.id}/barcodes/${b.id}`).catch(setErr);
                    await qc.invalidateQueries({ queryKey: ['product', initial.id] });
                  }}
                >
                  削除
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="row" style={{ marginTop: 8 }}>
              <input type="text" aria-label="追加するバーコード" value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="4901234567894" style={{ maxWidth: 260 }} />
              <button
                className="btn btn-sm"
                disabled={!newCode.trim()}
                onClick={async () => {
                  try {
                    await post(`/products/${initial.id}/barcodes`, { code: newCode.trim() });
                    setNewCode('');
                    await qc.invalidateQueries({ queryKey: ['product', initial.id] });
                  } catch (e) {
                    setErr(e);
                  }
                }}
              >
                追加
              </button>
            </div>
          )}
          {detail.data?.balances?.length > 0 && (
            <>
              <hr className="divider" />
              <h3>在庫（ロケーション別）</h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>倉庫</th>
                      <th>ロケーション</th>
                      <th className="num">OnHand</th>
                      <th className="num">Allocated</th>
                      <th className="num">調査中</th>
                      <th className="num">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.balances.map((b: any) => (
                      <tr key={b.id}>
                        <td>{b.warehouseCode}</td>
                        <td className="mono">
                          {b.locationCode} {b.kind !== 'pick' && <Badge tone="warning">{b.kind === 'damaged' ? '破損' : '返品保留'}</Badge>}
                        </td>
                        <td className="num">{b.onHand}</td>
                        <td className="num">{b.allocated}</td>
                        <td className="num">{b.held}</td>
                        <td className="num">{b.available}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <Field label="バーコード（任意）" htmlFor="pm-bc">
          <input id="pm-bc" type="text" value={newCode} onChange={(e) => setNewCode(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

function ProductImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState('utf-8');
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setErr(null);
    const fd = new FormData();
    fd.append('encoding', encoding);
    fd.append('dryRun', String(dryRun));
    fd.append('file', file);
    try {
      const r = await api('/products/import', { method: 'POST', body: fd });
      setResult(r);
      if (!dryRun && r.ok) {
        toast.success(`新規 ${r.created}件 / 更新 ${r.updated}件`);
        await qc.invalidateQueries({ queryKey: ['products'] });
      }
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title="商品 CSV 取込" onClose={onClose} footer={<button className="btn" onClick={onClose}>閉じる</button>}>
      <p className="small">
        列: <code>sku,name,variant,group_code,barcodes,weight_g,image_url,active</code>（barcodes は <code>|</code> 区切り）。
        全行が正しい場合のみ登録します（SKU が既存なら更新）。テンプレートは購入者資料「CSVテンプレート/商品CSVテンプレート.csv」。
      </p>
      <div className="alert info small">
        取り込む前に、CSV の画像（image_url）と手元の画像ファイルの名前が合っているかを確認できます（ファイルは送信しません）:{' '}
        <Link to="/inventory/products/image-check">CommerceOps 商品画像チェック</Link>
      </div>
      <ErrorBox error={err} />
      <div className="inline-fields">
        <Field label="ファイル" htmlFor="pi-file">
          <input id="pi-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
        </Field>
        <Field label="文字コード" htmlFor="pi-enc">
          <select id="pi-enc" value={encoding} onChange={(e) => setEncoding(e.target.value)}>
            <option value="utf-8">UTF-8</option>
            <option value="shift_jis">Shift_JIS</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <button className="btn" disabled={!file} onClick={() => void run(true)}>
          検証のみ
        </button>
        <button className="btn btn-primary" disabled={!file} onClick={() => void run(false)}>
          取り込む
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 12 }}>
          {result.ok ? (
            <div className="alert success">{result.dryRun ? `問題ありません（${result.validRows}行）` : `取込完了: 新規 ${result.created} / 更新 ${result.updated}`}</div>
          ) : (
            <div className="alert danger">
              {result.errorCount}件のエラーがあります（何も登録していません）
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {result.errors.slice(0, 20).map((e: any, i: number) => (
                  <li key={i}>
                    {e.line}行目: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
