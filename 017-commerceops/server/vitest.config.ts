import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/setup/global.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    maxWorkers: 4,
    reporters: ['default'],
  },
});
