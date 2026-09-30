import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useMe } from '../auth/AuthContext';
import { get } from '../api/client';
import { useOnline } from './ui';
import {
  IconAlert,
  IconAlloc,
  IconAudit,
  IconBox,
  IconChart,
  IconHome,
  IconImport,
  IconInventory,
  IconLogout,
  IconMenu,
  IconOrders,
  IconPack,
  IconReturn,
  IconScan,
  IconSearch,
  IconSettings,
  IconTruck,
  IconUser,
  IconWave,
} from './icons';
import { UpdatePrompt } from '../pwa/UpdatePrompt';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm?: string | string[];
  badgeKey?: string;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: '業務',
    items: [
      { to: '/', label: 'ホーム', icon: <IconHome /> },
      { to: '/orders', label: '注文', icon: <IconOrders />, perm: 'orders.read' },
      { to: '/imports', label: '注文取込', icon: <IconImport />, perm: 'orders.import' },
      { to: '/allocation', label: '引当', icon: <IconAlloc />, perm: 'allocation.manage' },
      { to: '/fulfillments', label: 'Fulfillment', icon: <IconBox />, perm: 'fulfillment.manage' },
      { to: '/waves', label: 'Wave・ピッキング', icon: <IconWave />, perm: ['waves.manage', 'waves.read'] },
      { to: '/pack', label: 'Packing Station', icon: <IconPack />, perm: 'pack.execute' },
      { to: '/shipments', label: '出荷', icon: <IconTruck />, perm: ['shipments.read', 'shipments.manage'] },
      { to: '/returns', label: '返品・交換', icon: <IconReturn />, perm: ['returns.read', 'returns.receive'] },
      { to: '/exceptions', label: '例外キュー', icon: <IconAlert />, perm: 'exceptions.read', badgeKey: 'exceptionsOpen' },
      { to: '/assignments', label: '作業割当', icon: <IconUser />, perm: ['waves.manage', 'fulfillment.manage', 'exceptions.manage'] },
    ],
  },
  {
    section: '在庫・分析',
    items: [
      { to: '/inventory', label: '在庫・商品', icon: <IconInventory />, perm: ['inventory.read', 'products.manage'] },
      { to: '/kpi', label: 'KPI', icon: <IconChart />, perm: 'kpi.read' },
      { to: '/m', label: 'スマホ作業モード', icon: <IconScan />, perm: ['pick.execute', 'returns.receive', 'returns.inspect'] },
    ],
  },
  {
    section: '管理',
    items: [
      { to: '/settings', label: '設定', icon: <IconSettings />, perm: ['org.manage', 'users.manage', 'warehouses.manage', 'channels.manage', 'backup.manage'] },
      { to: '/audit', label: '監査ログ', icon: <IconAudit />, perm: 'audit.read' },
    ],
  },
];

export function Layout() {
  const me = useMe();
  const { can, logout, switchOrg } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const loc = useLocation();
  const online = useOnline();
  const badges = useQuery({
    queryKey: ['nav-badges'],
    queryFn: () => get<{ exceptionsOpen: number }>('/dashboard/badges'),
    enabled: can('exceptions.read'),
    refetchInterval: 60_000,
  });

  const allowed = (p?: string | string[]) => !p || (Array.isArray(p) ? p.some(can) : can(p));

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        本文へスキップ
      </a>
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="メインメニュー">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          CommerceOps
        </div>
        <nav>
          {NAV.map((sec) => {
            const items = sec.items.filter((i) => allowed(i.perm));
            if (!items.length) return null;
            return (
              <div key={sec.section}>
                <div className="nav-section">{sec.section}</div>
                {items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    end={i.to === '/'}
                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                    onClick={() => setOpen(false)}
                  >
                    {i.icon}
                    <span>{i.label}</span>
                    {i.badgeKey && badges.data && (badges.data as Record<string, number>)[i.badgeKey]! > 0 && (
                      <span className="nav-badge">{(badges.data as Record<string, number>)[i.badgeKey]}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="small" style={{ color: '#fff' }}>{me.user.name}</div>
          <div className="small" style={{ color: '#8797ad' }}>
            {me.organization.name} / {me.roleLabel}
          </div>
          {me.memberships.length > 1 && (
            <select
              aria-label="組織を切り替え（メニュー）"
              value={me.organization.id}
              onChange={(e) => void switchOrg(e.target.value).then(() => nav('/'))}
              style={{ marginTop: 6 }}
            >
              {me.memberships.map((m) => (
                <option key={m.organizationId} value={m.organizationId}>
                  {m.name}
                  {m.isSample ? '（サンプル）' : ''}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => void logout().then(() => nav('/login'))}>
            <IconLogout /> ログアウト
          </button>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        {me.organization.isSample && (
          <div className="sample-banner">サンプル組織（Sample Commerce）です。本番データとは分離されています。</div>
        )}
        {!online && <div className="offline-banner">オフラインです。確定操作は再接続後に行ってください。</div>}
        <UpdatePrompt />
        <header className="topbar">
          <button className="btn btn-ghost menu-toggle" onClick={() => setOpen(true)} aria-label="メニューを開く">
            <IconMenu />
          </button>
          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <label htmlFor="global-search" className="sr-only">
              検索
            </label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                id="global-search"
                type="search"
                placeholder="注文番号・外部注文番号・SKU・顧客名・郵便番号・追跡番号…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button className="btn" type="submit" aria-label="検索">
                <IconSearch />
              </button>
            </div>
          </form>
          <div className="spacer" />
          {me.memberships.length > 1 ? (
            <select
              className="topbar-extra"
              aria-label="組織を切り替え"
              value={me.organization.id}
              onChange={(e) => void switchOrg(e.target.value).then(() => nav('/'))}
              style={{ width: 'auto', maxWidth: 220 }}
            >
              {me.memberships.map((m) => (
                <option key={m.organizationId} value={m.organizationId}>
                  {m.name}
                  {m.isSample ? '（サンプル）' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted small nowrap topbar-extra">{me.organization.name}</span>
          )}
          <span className="small nowrap topbar-extra" title={me.user.email}>
            {me.user.name}
            <span className="muted">（{me.roleLabel}）</span>
          </span>
          <button className="btn btn-ghost btn-sm topbar-extra" onClick={() => void logout().then(() => nav('/login'))} aria-label="ログアウト">
            <IconLogout />
          </button>
        </header>
        <main id="main" className="content" key={loc.pathname.split('/')[1]}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
