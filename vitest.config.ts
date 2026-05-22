import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.ts'],
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
        name: 'openai-sdk',
        description: 'Tests that call live OpenAI Agents SDK services.',
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
    // @ts-expect-error Not sure why this is triggering tsc
    tagsFilter: ['local'],
    coverage: {
      provider: 'v8',
      reporter: ['html', 'json', 'json-summary'],
      reportsDirectory: 'cache/test-coverage',
      exclude: [
        '**/node_modules/**',
        '**/__test__/**',
        '**/.claude/worktrees/**',
        // Thin wrappers around external SDK / CLI processes - exercising them
        // would require live network or a real `codex` binary.
        'src/agents/claude-sdk.ts',
        'src/agents/codex-cli.ts',
        'src/agents/openai-sdk.ts',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
