import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader } from '../../components/ui';

const TABS = [
  { to: '/settings/organization', label: '組織・運用設定', perm: 'org.manage' },
  { to: '/settings/warehouses', label: '倉庫・ロケーション', perm: 'warehouses.manage' },
  { to: '/settings/users', label: 'ユーザー・権限', perm: 'users.manage' },
  { to: '/settings/channels', label: '販売チャネル', perm: 'channels.manage' },
  { to: '/settings/import-profiles', label: 'Import Profile', perm: 'channels.manage' },
  { to: '/settings/backup', label: 'バックアップ・復元', perm: 'backup.manage' },
];

export default function SettingsLayout() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="設定" />
      <div className="tabs" role="tablist">
        {TABS.filter((t) => can(t.perm)).map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            {t.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </>
  );
}

export function SettingsIndex() {
  const { can } = useAuth();
  const first = TABS.find((t) => can(t.perm));
  return first ? <NavigateTo to={first.to} /> : <div className="card">設定を変更する権限がありません。</div>;
}

import { Navigate } from 'react-router';
function NavigateTo({ to }: { to: string }) {
  return <Navigate to={to} replace />;
}
