// @module-tag local

import { estimateCost, type ModelPrice } from 'loop-the-loop/util/pricing';
import { describe, expect, it } from 'vitest';

const PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5-mini': { inputPerMtok: 0.25, outputPerMtok: 2 },
  full: {
    inputPerMtok: 1,
    outputPerMtok: 4,
    cacheReadPerMtok: 0.1,
    cacheCreationPerMtok: 1.25,
    reasoningPerMtok: 8,
  },
};

describe('estimateCost', () => {
  it('returns undefined when the model is not priced', () => {
    expect(
      estimateCost('unknown', { inputTokens: 100 }, PRICES),
    ).toBeUndefined();
  });

  it('prices input and output tokens', () => {
    const result = estimateCost(
      'gpt-5-mini',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      PRICES,
    );
    expect(result?.usd).toBeCloseTo(2.25, 10);
    expect(result?.price).toBe(PRICES['gpt-5-mini']);
  });

  it('applies default cache and reasoning rates when omitted', () => {
    // gpt-5-mini omits cache/reasoning rates: cacheRead defaults to
    // inputPerMtok/10 (0.025), cacheCreation to inputPerMtok*1.25 (0.3125),
    // reasoning to outputPerMtok (2).
    const result = estimateCost(
      'gpt-5-mini',
      {
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      },
      PRICES,
    );
    expect(result?.usd).toBeCloseTo(0.025 + 0.3125 + 2, 10);
  });

  it('uses explicit cache and reasoning rates when provided', () => {
    const result = estimateCost(
      'full',
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      },
      PRICES,
    );
    expect(result?.usd).toBeCloseTo(1 + 4 + 0.1 + 1.25 + 8, 10);
  });

  it('treats missing token classes as zero', () => {
    const result = estimateCost('gpt-5-mini', {}, PRICES);
    expect(result?.usd).toBe(0);
  });
});
