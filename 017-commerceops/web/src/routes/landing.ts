import type { Me } from '../auth/AuthContext';

/** ログイン直後の遷移先（ロールに応じた作業画面） */
export function landingPath(me: Me): string {
  if (!me.organization) return '/no-organization';
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
  if (me.role === 'picker') return '/m';
  if (me.role === 'packer') return narrow ? '/m' : '/pack';
  return '/';
}
