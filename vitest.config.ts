import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'loop-the-loop': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    globals: true,
    include: ['**/__test__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
    tags: [
      {
        name: 'local',
        description: 'Tests that run without live services or secrets.',
      },
      {
        name: 'live',
        description: 'Opt-in tests that call live services.',
      },
      {
        name: 'extra',
        description: 'Compatibility alias for live opt-in tests.',
      },
      {
        name: 'network',
        description: 'Tests that call live network services.',
      },
      {
        name: 'agent',
        description: 'Tests that call live LLM agent backends.',
      },
      {
        name: 'claude-sdk',
        description: 'Tests that call live Claude Agent SDK services.',
      },
      {
        name: 'codex-cli',
        description: 'Tests that call live Codex CLI services.',
      },
      {
        name: 'github',
        description: 'Tests that call live GitHub services.',
      },
      {
        name: 'gitlab',
        description: 'Tests that call live GitLab services.',
      },
      {
        name: 'bugzilla',
        description: 'Tests that call live Bugzilla services.',
      },
    ],
    tagsFilter: ['local'],
    coverage: {
      provider: 'v8',
      reporter: ['html', 'json', 'json-summary'],
      reportsDirectory: 'cache/test-coverage',
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.claude/worktrees/**',
        '**/__test__/**',
        // Thin wrappers around external SDK / CLI processes - exercising them
        // would require live network or a real `codex` binary.
        'src/agents/claude-sdk.ts',
        'src/agents/codex-cli.ts',
      ],
      thresholds: {
        statements: 97,
        branches: 92,
        functions: 97,
        lines: 97,
      },
    },
  },
});
