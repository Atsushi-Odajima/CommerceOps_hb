import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field } from '../../components/ui';
import { landingPath } from '../../routes/landing';

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const me = await login(email.trim(), password);
            const from = (loc.state as { from?: string } | null)?.from;
            nav(from && from !== '/login' ? from : landingPath(me), { replace: true });
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
        <h1 style={{ fontSize: '1.1rem' }}>ログイン</h1>
        <ErrorBox error={err} />
        <Field label="メールアドレス" htmlFor="email">
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="パスワード" htmlFor="password" hint="5回続けて失敗すると15分間ログインできなくなります。">
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
        <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>
          パスワードを忘れた場合は、組織のオーナーにリセットリンクの発行を依頼してください。
        </p>
      </form>
    </div>
  );
}
