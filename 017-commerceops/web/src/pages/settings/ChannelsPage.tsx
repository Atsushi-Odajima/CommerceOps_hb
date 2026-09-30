import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, patch, post } from '../../api/client';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { CHANNEL_TYPE } from '../../lib/labels';

export function useChannels() {
  return useQuery({ queryKey: ['channels'], queryFn: () => get<{ items: any[] }>('/channels') });
}

export default function ChannelsPage() {
  const channels = useChannels();
  const [edit, setEdit] = useState<any>(null);
  if (channels.isLoading) return <Loading />;
  return (
    <div className="card">
      <div className="card-header">
        <h2>販売チャネル</h2>
        <div className="actions">
          <button className="btn btn-primary btn-sm" onClick={() => setEdit({ type: 'own_site', connectorType: 'csv', active: true })}>
            チャネルを追加
          </button>
        </div>
      </div>
      <p className="muted small">
        チャネルの種類はラベルです。各社の CSV 仕様を自動判定することはありません。取込は「Import Profile」で列を対応付けて行います。
      </p>
      <ErrorBox error={channels.error} />
      {channels.data?.items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>コード</th>
                <th>種類</th>
                <th>取込方法</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {channels.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">{c.code}</td>
                  <td>{CHANNEL_TYPE[c.type]}</td>
                  <td>{c.connectorType === 'csv' ? 'CSV' : '手動'}</td>
                  <td>{c.active ? <Badge tone="success">有効</Badge> : <Badge>無効</Badge>}</td>
                  <td className="right nowrap">
                    <Link className="btn btn-sm" to={`/settings/import-profiles?channelId=${c.id}`}>
                      Import Profile
                    </Link>{' '}
                    <button className="btn btn-sm" onClick={() => setEdit(c)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="販売チャネルがありません">自社EC・モール・卸・手動などの受注経路を登録してください。</EmptyState>
      )}
      {edit && <ChannelModal initial={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ChannelModal({ initial, onClose }: { initial: any; onClose: () => void }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<unknown>(null);
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <Modal
      title={initial.id ? 'チャネルを編集' : 'チャネルを追加'}
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
                const body = { name: f.name, type: f.type, code: f.code, connectorType: f.connectorType, active: f.active };
                if (initial.id) await patch(`/channels/${initial.id}`, body);
                else await post('/channels', body);
                await qc.invalidateQueries({ queryKey: ['channels'] });
                toast.success('保存しました');
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
      <Field label="名称" htmlFor="ch-name">
        <input id="ch-name" type="text" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="inline-fields">
        <Field label="コード（英数字）" htmlFor="ch-code">
          <input id="ch-code" type="text" value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={16} />
        </Field>
        <Field label="種類" htmlFor="ch-type">
          <select id="ch-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {Object.entries(CHANNEL_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="取込方法" htmlFor="ch-conn">
          <select id="ch-conn" value={f.connectorType} onChange={(e) => setF({ ...f, connectorType: e.target.value })}>
            <option value="csv">CSV</option>
            <option value="manual">手動</option>
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 有効
      </label>
    </Modal>
  );
}
