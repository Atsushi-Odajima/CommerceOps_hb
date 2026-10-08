import { defineConfig } from 'vitest/config';

/** 画面側の純粋な処理（DOM を使わない lib）の単体テスト。DB・ブラウザは使わない。 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
