import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'agentic-loop': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    globals: true,
    include: ['**/__test__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['html', 'json', 'json-summary'],
      reportsDirectory: 'cache/test-coverage',
      exclude: ['node_modules', '__test__/**'],
    },
  },
});
