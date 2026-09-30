import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { landingPath } from '../../routes/landing';

/** トークンは URL フラグメント（#t=...）で受け取り、サーバーのアクセスログや Referer に残さない */
function tokenFromHash(): string {
  const m = /[#&]t=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]!) : '';
}

export function AcceptInvitePage() {
  const token = tokenFromHash();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/invitations/preview', { method: 'POST', body: { token }, noAuthRedirect: true })
      .then((r) => {
        setInfo(r);
        setName(r.name ?? '');
      })
      .catch(setErr);
  }, [token]);

  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api('/auth/invitations/accept', { method: 'POST', body: { token, name: name || undefined, password }, noAuthRedirect: true });
            const me = await refresh();
            window.history.replaceState(null, '', '/');
            nav(me ? landingPath(me) : '/', { replace: true });
          } catch (e2) {
            setErr(e2);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          CommerceOps
        </div>
        <h1 style={{ fontSize: '1.1rem' }}>招待を受け入れる</h1>
        <ErrorBox error={err} />
        {!info && !err && <Loading />}
        {info && (
          <>
            <p>
              <strong>{info.organizationName}</strong> に <strong>{info.roleLabel}</strong> として招待されています。
              <br />
              <span className="muted small">{info.email}</span>
            </p>
            {!info.existingUser && (
              <Field label="お名前" htmlFor="inv-name">
                <input id="inv-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
              </Field>
            )}
            <Field
              label={info.existingUser ? '既存アカウントのパスワード' : 'パスワードを設定（10文字以上）'}
              htmlFor="inv-pw"
            >
              <input
                id="inv-pw"
                type="password"
                autoComplete={info.existingUser ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={info.existingUser ? 1 : 10}
              />
            </Field>
            <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
              参加する
            </button>
          </>
        )}
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const token = tokenFromHash();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api('/auth/password-reset', { method: 'POST', body: { token, newPassword: password }, noAuthRedirect: true });
            window.history.replaceState(null, '', '/reset-password');
            setDone(true);
          } catch (e2) {
            setErr(e2);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          CommerceOps
        </div>
        <h1 style={{ fontSize: '1.1rem' }}>パスワードの再設定</h1>
        <ErrorBox error={err} />
        {done ? (
          <>
            <div className="alert success">パスワードを変更しました。新しいパスワードでログインしてください。</div>
            <button type="button" className="btn btn-primary btn-block" onClick={() => nav('/login')}>
              ログイン画面へ
            </button>
          </>
        ) : (
          <>
            <Field label="新しいパスワード（10文字以上）" htmlFor="new-pw">
              <input id="new-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
            </Field>
            <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
              変更する
            </button>
          </>
        )}
      </form>
    </div>
  );
}
