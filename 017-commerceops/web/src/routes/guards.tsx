import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Loading } from '../components/ui';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (!me.organization) return <Navigate to="/no-organization" replace />;
  return <>{children}</>;
}

/** 権限がない場合の表示（API 側でも必ず拒否される） */
export function RequirePerm({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const ok = Array.isArray(perm) ? perm.some(can) : can(perm);
  if (!ok) {
    return (
      <div className="card">
        <h2>アクセスできません</h2>
        <p className="muted">この画面を表示する権限がありません。必要な場合は組織のオーナーに依頼してください。</p>
      </div>
    );
  }
  return <>{children}</>;
}
