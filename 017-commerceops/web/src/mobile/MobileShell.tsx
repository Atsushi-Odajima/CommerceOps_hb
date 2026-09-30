import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useOnline } from '../components/ui';
import { IconAlert, IconHome, IconList, IconReturn, IconScan } from '../components/icons';
import { flushQueue, listQueued } from '../offline/queue';
import { UpdatePrompt } from '../pwa/UpdatePrompt';

export function useUnsyncedCount(taskId?: string) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => void listQueued(taskId).then((q) => setN(q.length)).catch(() => setN(0));
    load();
    window.addEventListener('offline-queue-changed', load);
    return () => window.removeEventListener('offline-queue-changed', load);
  }, [taskId]);
  return n;
}

/** スマホ現場モードの枠（上部バー + 下部ナビ）。大きなタップ領域・片手操作前提 */
export function MobileShell({ title, back, children, right }: { title: string; back?: string; children: ReactNode; right?: ReactNode }) {
  const { can, me } = useAuth();
  const online = useOnline();
  const nav = useNavigate();
  const unsynced = useUnsyncedCount();
  useEffect(() => {
    if (online) void flushQueue();
  }, [online]);
  return (
    <div className="mobile">
      <UpdatePrompt />
      {!online && <div className="offline-banner">オフライン — Pick の読取は「未同期」として保存し、再接続時に送信します</div>}
      <header className="mobile-top">
        {back && (
          <button className="btn btn-ghost btn-sm" onClick={() => nav(back)} aria-label="戻る" style={{ color: '#fff' }}>
            ←
          </button>
        )}
        <div className="title">{title}</div>
        {unsynced > 0 && (
          <span className="badge warning" title="未同期の読取">
            未同期 {unsynced}
          </span>
        )}
        {right}
      </header>
      <main className="mobile-body" id="main">
        {children}
      </main>
      <nav className="mobile-nav" aria-label="作業メニュー">
        <NavLink to="/m" end className={({ isActive }) => (isActive ? 'active' : '')}>
          <IconHome />
          ホーム
        </NavLink>
        {can('pick.execute') && (
          <NavLink to="/m/tasks" className={({ isActive }) => (isActive ? 'active' : '')}>
            <IconList />
            Pick
          </NavLink>
        )}
        <NavLink to="/m/lookup" className={({ isActive }) => (isActive ? 'active' : '')}>
          <IconScan />
          商品確認
        </NavLink>
        {(can('returns.receive') || can('returns.inspect')) && (
          <NavLink to="/m/returns" className={({ isActive }) => (isActive ? 'active' : '')}>
            <IconReturn />
            返品
          </NavLink>
        )}
        <NavLink to="/m/report" className={({ isActive }) => (isActive ? 'active' : '')}>
          <IconAlert />
          報告
        </NavLink>
      </nav>
      <span className="sr-only">{me?.user.name}</span>
    </div>
  );
}
