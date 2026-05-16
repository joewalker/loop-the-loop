// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag agent
// @module-tag claude-sdk

import {
  CHEAP_TEST_ANSWER,
  CHEAP_TEST_PROMPT,
  invokeLiveTestPrompt,
  normalizeScalarAnswer,
} from 'loop-the-loop/agents/__test__/live-agent-harness';
import { ClaudeSDKAgent } from 'loop-the-loop/agents/claude-sdk';
import { describe, expect, it } from 'vitest';

describe('Claude SDK live agent', () => {
  it(
    'answers a cheap generated test prompt',
    { timeout: 60_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const invocation = await invokeLiveTestPrompt(
        new ClaudeSDKAgent({ maxTurns: 2 }),
        CHEAP_TEST_PROMPT,
        { allowedTools: [] },
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
