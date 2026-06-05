// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag agent
// @module-tag codex-cli

import { CodexCLIAgent } from 'loop-the-loop/agents/codex-cli';
import type { CheckResult } from 'loop-the-loop/doctor';
import { describe, expect, it } from 'vitest';

import {
  CHEAP_TEST_ANSWER,
  CHEAP_TEST_PROMPT,
  invokeLiveTestPrompt,
  normalizeScalarAnswer,
} from './live-agent-harness.js';

describe('Codex CLI live check()', () => {
  it('does not fail when the codex binary is installed', async () => {
    const agent = new CodexCLIAgent();
    const results: Array<CheckResult> = [];
    for await (const result of agent.check()) {
      results.push(result);
    }

    const onPath = results.find(r => r.name === 'codex on PATH');
    expect(onPath?.status).toBe('ok');
    expect(results.some(r => r.status === 'fail')).toBe(false);
  });
});

describe('Codex CLI live agent', () => {
  it(
    'answers a cheap generated test prompt',
    { timeout: 60_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const invocation = await invokeLiveTestPrompt(
        new CodexCLIAgent(),
        CHEAP_TEST_PROMPT,
      );

      expect(invocation.prompt).toStrictEqual({
        id: '0',
        prompt: CHEAP_TEST_PROMPT,
      });

      if (invocation.result.status !== 'success') {
        throw new Error(
          `Expected success, got ${invocation.result.status}: ${invocation.result.reason}`,
        );
      }

      expect(normalizeScalarAnswer(invocation.result.output)).toBe(
        CHEAP_TEST_ANSWER,
      );
    },
  );
});
