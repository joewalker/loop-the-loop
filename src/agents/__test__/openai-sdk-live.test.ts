// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag agent
// @module-tag openai-sdk

import { OpenAISDKAgent } from 'loop-the-loop/agents/openai-sdk';
import { describe, expect, it } from 'vitest';

import {
  CHEAP_TEST_ANSWER,
  CHEAP_TEST_PROMPT,
  invokeLiveTestPrompt,
  normalizeScalarAnswer,
} from './live-agent-harness.js';

describe('OpenAI SDK live agent', () => {
  it(
    'answers a cheap generated test prompt',
    { timeout: 60_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const agent = await OpenAISDKAgent.create({ maxTurns: 2 });
      const invocation = await invokeLiveTestPrompt(agent, CHEAP_TEST_PROMPT);

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
