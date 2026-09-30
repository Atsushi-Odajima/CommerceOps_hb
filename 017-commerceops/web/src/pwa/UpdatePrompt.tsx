import { useRegisterSW } from 'virtual:pwa-register/react';

/** 新しいバージョンのアプリがあるときに再読み込みを促す（作業中の画面を勝手にリロードしない） */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  if (!needRefresh) return null;
  return (
    <div className="alert info no-print" role="status" style={{ margin: 0, borderRadius: 0, display: 'flex', gap: 12, alignItems: 'center' }}>
      <span>新しいバージョンがあります。作業の区切りで更新してください。</span>
      <button className="btn btn-sm btn-primary" onClick={() => void updateServiceWorker(true)}>
        更新する
      </button>
      <button className="btn btn-sm" onClick={() => setNeedRefresh(false)}>
        後で
      </button>
    </div>
  );
}
