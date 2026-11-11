import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // the specs share one database and one Redis, so they run one file at a time
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
