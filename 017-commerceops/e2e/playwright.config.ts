import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const PORT = 3100;
export const RESTORE_PORT = 3101;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_e2e';
const RESTORE_DB = process.env.E2E_RESTORE_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_e2e_restore';

const serverEnv = (db: string, port: number, dataDir: string) => ({
  NODE_ENV: 'test', // レート制限を外す（E2E は同じ IP から大量に操作するため）
  DATABASE_URL: db,
  PORT: String(port),
  WEB_DIST_DIR: join(here, '../web/dist'),
  APP_BASE_URL: `http://localhost:${port}`,
  DATA_DIR: dataDir,
  RUN_WORKER: 'true',
  ALLOW_SIGNUP: 'true', // テストごとに独立した組織を作る
  LOG_LEVEL: 'warn',
});

/**
 * E2E（PC / iPhone / Android / iPad）。事前に `npm run build -w web`。
 * 本番と同じ構成（ビルド済み画面 + API + Job worker）を E2E 専用 DB で起動する。E2E-9 用に「空の環境」をもう 1 つ起動する。
 * WebKit はこの環境に無いため、iPhone / iPad は Chromium でビューポート・タッチ・モバイル UA を再現（TEST_REPORT.md に明記）。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  webServer: [
    {
      command: `node ${join(here, 'reset-db.mjs')} ${DB} && npx tsx src/index.ts`,
      cwd: join(here, '../server'),
      url: `http://localhost:${PORT}/readyz`,
      env: serverEnv(DB, PORT, join(here, 'test-results/data-main')),
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node ${join(here, 'reset-db.mjs')} ${RESTORE_DB} && npx tsx src/index.ts`,
      cwd: join(here, '../server'),
      url: `http://localhost:${RESTORE_PORT}/readyz`,
      env: serverEnv(RESTORE_DB, RESTORE_PORT, join(here, 'test-results/data-restore')),
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [
    { name: 'e2e', testIgnore: /camera\.spec\.ts/ },
    {
      // 擬似カメラにバーコード映像を流して、カメラ読取（ZXing）を実際に動かす
      name: 'camera',
      testMatch: /camera\.spec\.ts/,
      use: {
        permissions: ['camera'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${join(here, 'test-results/fake-camera.y4m')}`],
        },
      },
    },
  ],
});
