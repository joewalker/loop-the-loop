// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag agent
// @module-tag openai-sdk

import { OpenAISDKAgent } from 'loop-the-loop/agents/openai-sdk';
import type { CheckResult } from 'loop-the-loop/doctor';
import { describe, expect, it } from 'vitest';

import {
  CHEAP_TEST_ANSWER,
  CHEAP_TEST_PROMPT,
  invokeLiveTestPrompt,
  normalizeScalarAnswer,
} from './live-agent-harness.js';

describe('OpenAI SDK live check()', () => {
  it(
    'does not fail any probe when the key is present',
    { timeout: 60_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const agent = await OpenAISDKAgent.create({});
      const check = agent.check;
      if (check === undefined) {
        throw new Error('agent.check is not defined');
      }
      const results: Array<CheckResult> = [];
      for await (const result of check.call(agent)) {
        results.push(result);
      }

      expect(results.find(r => r.name === 'credentials present')?.status).toBe(
        'ok',
      );
      expect(results.find(r => r.name === 'models reachable')?.status).toBe(
        'ok',
      );
      expect(results.some(r => r.status === 'fail')).toBe(false);
    },
  );
});

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
