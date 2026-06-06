/**
 * Per-million-token prices for a single model. Cache and reasoning rates
 * are optional and fall back to sensible multiples of the input/output
 * rates when omitted.
 */
export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  /** Defaults to `inputPerMtok / 10`. */
  readonly cacheReadPerMtok?: number;
  /** Defaults to `inputPerMtok * 1.25`. */
  readonly cacheCreationPerMtok?: number;
  /** Defaults to `outputPerMtok`. */
  readonly reasoningPerMtok?: number;
}

/**
 * Token counts for a single agent invocation. Every field is optional; a
 * missing field is treated as zero by `estimateCost`.
 */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Estimate the USD cost of an invocation from token counts and configured
 * per-model prices.
 *
 * Returns `undefined` when `prices[model]` is missing so callers can record
 * `costSource: 'unavailable'` with the raw token counts. There is
 * deliberately no built-in price table: stale defaults would silently
 * undercount.
 */
export function estimateCost(
  model: string,
  usage: TokenUsage,
  prices: Readonly<Record<string, ModelPrice>>,
): { usd: number; price: ModelPrice } | undefined {
  const price = prices[model];
  if (price === undefined) {
    return undefined;
  }

  const cacheReadRate = price.cacheReadPerMtok ?? price.inputPerMtok / 10;
  const cacheCreationRate =
    price.cacheCreationPerMtok ?? price.inputPerMtok * 1.25;
  const reasoningRate = price.reasoningPerMtok ?? price.outputPerMtok;

  const usd =
    ((usage.inputTokens ?? 0) * price.inputPerMtok +
      (usage.outputTokens ?? 0) * price.outputPerMtok +
      (usage.cacheReadTokens ?? 0) * cacheReadRate +
      (usage.cacheCreationTokens ?? 0) * cacheCreationRate +
      (usage.reasoningTokens ?? 0) * reasoningRate) /
    TOKENS_PER_MILLION;

  return { usd, price };
}
