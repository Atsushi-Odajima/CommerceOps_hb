import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../../api/client';
import { useMe } from '../../auth/AuthContext';
import { Badge, ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { ROLE_OPTIONS } from '../../lib/labels';
import { useWarehouses } from './WarehousesPage';

export default function UsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<{ items: any[] }>('/users') });
  const invites = useQuery({ queryKey: ['invitations'], queryFn: () => get<{ items: any[] }>('/users/invitations') });
  const whs = useWarehouses();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [link, setLink] = useState<{ title: string; url: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const whName = (id: string) => whs.data?.items.find((w) => w.id === id)?.code ?? '?';

  const update = async (userId: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      await patch(`/users/${userId}`, body);
      await qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('更新しました');
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <ErrorBox error={err ?? users.error} />
      <div className="card">
        <div className="card-header">
          <h2>メンバー</h2>
          <div className="actions">
            <button className="btn btn-primary btn-sm" onClick={() => setInviteOpen(true)}>
              メンバーを招待
            </button>
          </div>
        </div>
        <p className="muted small">
          ロールの権限は「ユーザーと権限.txt」を参照してください。画面の表示だけでなく、サーバー側でも権限を検証します。倉庫を指定すると、その倉庫の作業・在庫のみ扱えます。
        </p>
        {users.isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>氏名 / メール</th>
                  <th>ロール</th>
                  <th>倉庫範囲</th>
                  <th>状態</th>
                  <th>最終ログイン</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((u) => (
                  <tr key={u.userId}>
                    <td>
                      {u.name}
                      {u.userId === me.user.id && <Badge tone="info">自分</Badge>}
                      <div className="muted small">{u.email}</div>
                    </td>
                    <td>
                      <select aria-label={`${u.name} のロール`} value={u.role} onChange={(e) => void update(u.userId, { role: e.target.value })} style={{ minWidth: 200 }}>
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <WarehouseScopeEditor
                        value={u.warehouseIds}
                        warehouses={whs.data?.items ?? []}
                        label={u.warehouseIds ? u.warehouseIds.map(whName).join(', ') : '全倉庫'}
                        onChange={(ids) => void update(u.userId, { warehouseIds: ids })}
                      />
                    </td>
                    <td>{u.status === 'active' ? <Badge tone="success">有効</Badge> : <Badge tone="danger">無効</Badge>}</td>
                    <td className="small">{fmtDateTime(u.lastLoginAt)}</td>
                    <td className="right nowrap">
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          try {
                            const r = await post(`/users/${u.userId}/password-reset`);
                            setLink({ title: `${u.name} さんのパスワード再設定リンク（24時間有効）`, url: r.url });
                          } catch (e) {
                            setErr(e);
                          }
                        }}
                      >
                        PWリセット
                      </button>{' '}
                      {u.status === 'active' ? (
                        <button className="btn btn-sm btn-danger" onClick={() => void update(u.userId, { status: 'disabled' })}>
                          無効化
                        </button>
                      ) : (
                        <button className="btn btn-sm" onClick={() => void update(u.userId, { status: 'active' })}>
                          有効化
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>招待</h2>
        {invites.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>メール</th>
                  <th>ロール</th>
                  <th>状態</th>
                  <th>有効期限</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.data.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{i.roleLabel}</td>
                    <td>
                      <Badge tone={i.status === 'pending' ? 'warning' : i.status === 'accepted' ? 'success' : ''}>
                        {{ pending: '未承諾', accepted: '参加済', revoked: '取消', expired: '期限切れ' }[i.status as string]}
                      </Badge>
                    </td>
                    <td className="small">{fmtDateTime(i.expiresAt)}</td>
                    <td>
                      {i.status === 'pending' && (
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            await del(`/users/invitations/${i.id}`).catch(setErr);
                            await qc.invalidateQueries({ queryKey: ['invitations'] });
                          }}
                        >
                          取消
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">招待はありません。</p>
        )}
      </div>
      {inviteOpen && (
        <InviteModal
          warehouses={whs.data?.items ?? []}
          onClose={() => setInviteOpen(false)}
          onCreated={(url) => {
            setInviteOpen(false);
            setLink({ title: '招待リンク（7日間有効・1回限り）', url });
            void qc.invalidateQueries({ queryKey: ['invitations'] });
          }}
        />
      )}
      {link && (
        <Modal title={link.title} onClose={() => setLink(null)} footer={<button className="btn btn-primary" onClick={() => setLink(null)}>閉じる</button>}>
          <p>このリンクは今だけ表示されます。本人に安全な方法で渡してください（メールは自動送信されません）。</p>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="text" readOnly value={link.url} aria-label="リンク" onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => toast.success('コピーしました'))}>
              コピー
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function WarehouseScopeEditor({
  value,
  warehouses,
  label,
  onChange,
}: {
  value: string[] | null;
  warehouses: { id: string; code: string; name: string }[];
  label: string;
  onChange: (ids: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(value ?? []);
  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Modal
          title="倉庫範囲"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => { onChange(null); setOpen(false); }}>
                全倉庫にする
              </button>
              <button className="btn btn-primary" disabled={!sel.length} onClick={() => { onChange(sel); setOpen(false); }}>
                選択した倉庫に限定
              </button>
            </>
          }
        >
          {warehouses.map((w) => (
            <label key={w.id} className="check">
              <input type="checkbox" checked={sel.includes(w.id)} onChange={(e) => setSel(e.target.checked ? [...sel, w.id] : sel.filter((x) => x !== w.id))} />
              {w.code} {w.name}
            </label>
          ))}
        </Modal>
      )}
    </>
  );
}

function InviteModal({ warehouses, onClose, onCreated }: { warehouses: { id: string; code: string; name: string }[]; onClose: () => void; onCreated: (url: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('picker');
  const [scope, setScope] = useState<string[]>([]);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title="メンバーを招待"
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
                const r = await post('/users/invitations', { email, name: name || undefined, role, warehouseIds: scope.length ? scope : null });
                onCreated(r.url);
              } catch (e) {
                setErr(e);
              }
            }}
          >
            招待リンクを作成
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      <Field label="メールアドレス（ログインID）" htmlFor="inv-email">
        <input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="氏名（任意）" htmlFor="inv-name">
        <input id="inv-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="ロール" htmlFor="inv-role">
        <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="field">
        <label>倉庫範囲（未選択 = 全倉庫）</label>
        {warehouses.map((w) => (
          <label key={w.id} className="check">
            <input type="checkbox" checked={scope.includes(w.id)} onChange={(e) => setScope(e.target.checked ? [...scope, w.id] : scope.filter((x) => x !== w.id))} />
            {w.code} {w.name}
          </label>
        ))}
      </div>
    </Modal>
  );
}
