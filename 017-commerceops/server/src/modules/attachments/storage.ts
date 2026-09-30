import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** 添付ファイル（返品検品写真など）の保存先。キーはサーバー生成の "{orgId}/{attachmentId}" のみ */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

export function assertStorageKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error('invalid storage key');
}

/** ローカルディスク（自前サーバー / 永続ディスク付き PaaS 向け） */
export class LocalDiskStorage implements Storage {
  private readonly base: string;

  constructor(baseDir: string) {
    this.base = resolve(baseDir, 'attachments');
  }

  private pathFor(key: string): string {
    assertStorageKey(key);
    const p = resolve(this.base, key);
    // パストラバーサル対策: 解決後のパスが base 配下であることを確認
    if (!p.startsWith(this.base + sep)) throw new Error('invalid storage path');
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/** テスト用 */
export class MemoryStorage implements Storage {
  private readonly m = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    assertStorageKey(key);
    this.m.set(key, data);
  }
  async get(key: string): Promise<Buffer | null> {
    assertStorageKey(key);
    return this.m.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
}
