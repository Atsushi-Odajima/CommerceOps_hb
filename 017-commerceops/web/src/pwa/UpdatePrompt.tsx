import { createContext, useContext, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

interface PwaState {
  needRefresh: boolean;
  dismiss: () => void;
  update: () => void;
}
const PwaContext = createContext<PwaState | null>(null);

/**
 * Service Worker はアプリ起動時に 1 回だけ登録する（ログイン画面からでもホーム画面への追加・アプリの殻のキャッシュができる）。
 * 更新の案内は各画面の枠（Layout / MobileShell）の UpdatePrompt が表示する。
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  return (
    <PwaContext.Provider value={{ needRefresh, dismiss: () => setNeedRefresh(false), update: () => void updateServiceWorker(true) }}>
      {children}
    </PwaContext.Provider>
  );
}

/** 新しいバージョンのアプリがあるときに再読み込みを促す（作業中の画面を勝手にリロードしない） */
export function UpdatePrompt() {
  const pwa = useContext(PwaContext);
  if (!pwa?.needRefresh) return null;
  return (
    <div className="alert info no-print" role="status" style={{ margin: 0, borderRadius: 0, display: 'flex', gap: 12, alignItems: 'center' }}>
      <span>新しいバージョンがあります。作業の区切りで更新してください。</span>
      <button className="btn btn-sm btn-primary" onClick={pwa.update}>
        更新する
      </button>
      <button className="btn btn-sm" onClick={pwa.dismiss}>
        後で
      </button>
    </div>
  );
}
