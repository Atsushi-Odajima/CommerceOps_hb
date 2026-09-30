/**
 * オフライン下書き（Pick scan のみ）。
 * - IndexedDB に保存し「未同期」を明示。個人情報は保存しない（タスク ID・ロケーション ID・コード・数量のみ）
 * - 再接続時に順番に送信し、サーバーが担当・残数・引当状態を再検証する（拒否された場合は結果を表示）
 * - Pack 完了・出荷確定・在庫調整・返品 Restock・Short はオフラインで確定しない
 */
import { ApiError, api } from '../api/client';

export interface QueuedScan {
  clientEventId: string;
  kind: 'pick' | 'location';
  taskId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
}

export interface SyncResult {
  clientEventId: string;
  ok: boolean;
  message?: string;
}

const DB = 'commerceops-offline';
const STORE = 'scans';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'clientEventId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(scan: Omit<QueuedScan, 'attempts'>) {
  await withStore('readwrite', (s) => s.put({ ...scan, attempts: 0 }));
  window.dispatchEvent(new Event('offline-queue-changed'));
}

export async function listQueued(taskId?: string): Promise<QueuedScan[]> {
  const all = (await withStore('readonly', (s) => s.getAll())) as QueuedScan[];
  return all.filter((q) => !taskId || q.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function remove(id: string) {
  await withStore('readwrite', (s) => s.delete(id));
}

let syncing = false;

/** 未同期の scan を送信。ネットワーク不通なら中断して残す。サーバーが拒否したものは結果として返し削除する */
export async function flushQueue(): Promise<SyncResult[]> {
  if (syncing || !navigator.onLine) return [];
  syncing = true;
  const results: SyncResult[] = [];
  try {
    for (const q of await listQueued()) {
      const path = q.kind === 'pick' ? `/pick-tasks/${q.taskId}/pick` : `/pick-tasks/${q.taskId}/scan-location`;
      try {
        const r = await api(path, { method: 'POST', body: { ...q.payload, clientEventId: q.clientEventId, offline: true, clientCreatedAt: q.createdAt } });
        results.push({ clientEventId: q.clientEventId, ok: r.ok !== false, message: r.message });
        await remove(q.clientEventId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) break; // まだオフライン
        const err = e as ApiError;
        // 422（誤 scan）/ 409（担当変更・完了済み）などはサーバー判断として確定 → キューから除去
        results.push({ clientEventId: q.clientEventId, ok: false, message: err.message });
        await remove(q.clientEventId);
      }
    }
  } finally {
    syncing = false;
    window.dispatchEvent(new Event('offline-queue-changed'));
  }
  return results;
}
