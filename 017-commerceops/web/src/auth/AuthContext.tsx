import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, setCsrfToken } from '../api/client';

export interface Membership {
  organizationId: string;
  name: string;
  role: string;
  roleLabel: string;
  isSample: boolean;
}

export interface Me {
  user: { id: string; name: string; email: string };
  organization: {
    id: string;
    name: string;
    timezone: string;
    isSample: boolean;
    settings: Record<string, any>;
  } | null;
  role: 'owner' | 'ops_manager' | 'picker' | 'packer' | 'support' | null;
  roleLabel: string | null;
  permissions: string[];
  warehouseIds: string[] | null;
  csrfToken: string;
  memberships: Membership[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refresh: () => Promise<Me | null>;
  switchOrg: (organizationId: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const apply = useCallback((m: Me | null) => {
    setMe(m);
    setCsrfToken(m?.csrfToken ?? '');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me', { noAuthRedirect: true });
      apply(m);
      return m;
    } catch {
      apply(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
    return onUnauthorized(() => {
      apply(null);
      qc.clear();
    });
  }, [refresh, apply, qc]);

  const login = useCallback(
    async (email: string, password: string) => {
      const m = await api<Me>('/auth/login', { method: 'POST', body: { email, password }, noAuthRedirect: true });
      apply(m);
      qc.clear();
      return m;
    },
    [apply, qc],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', noAuthRedirect: true });
    } finally {
      apply(null);
      qc.clear();
    }
  }, [apply, qc]);

  const switchOrg = useCallback(
    async (organizationId: string) => {
      await api('/auth/switch-org', { method: 'POST', body: { organizationId } });
      qc.clear();
      await refresh();
    },
    [qc, refresh],
  );

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      can: (perm: string) => !!me?.permissions.includes(perm),
      login,
      logout,
      refresh,
      switchOrg,
    }),
    [me, loading, login, logout, refresh, switchOrg],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** ログイン済み + 組織選択済みの Me を返す（ガード配下で使用） */
export function useMe(): Me & { organization: NonNullable<Me['organization']> } {
  const { me } = useAuth();
  if (!me?.organization) throw new Error('not authenticated');
  return me as Me & { organization: NonNullable<Me['organization']> };
}
