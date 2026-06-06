# Step 03 Cost Accounting and Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record cost and token metadata on every agent result when available, surface it in reports, and optionally stop a run once a configured USD budget is crossed.

**Architecture:** A pure pricing helper (`estimateCost`) converts token counts plus per-model prices into a USD figure. Each agent extracts what it can: claude-sdk reads the provider USD figure directly; openai-sdk and codex-cli extract token counts and estimate USD only when the user has configured prices, otherwise emitting `costSource: 'unavailable'`. The loop-state persistence and the `CostInfo` / `LoopRunResult` types already shipped in Step 01, so this step only feeds them real data and adds the budget-stop branch in `loop.ts`, the YAML cost block, the `--max-budget-usd` flag, schema, an example config, and README prose.

**Tech Stack:** TypeScript (strict, ESM), vitest, ajv (schema test), pnpm. Coverage gate is 100% on non-ignored files. The three real agent files carry `// istanbul ignore file`, so the pure helpers added to them are unit-tested for correctness but do not affect the coverage gate; `src/util/pricing.ts`, `src/loop.ts`, `src/reporters/yaml.ts`, and `src/util/load-cli-config.ts` are coverage-measured and every new branch must be tested.

## Carry-over contract from Steps 01 and 02

Read `docs/future-plans/next.md` before starting. The load-bearing facts:

- `CostInfo` already exists on the result variants in `src/types.ts` (do not redefine it). The tri-state `costSource` (`'provider' | 'estimated' | 'unavailable'`) is what consumers branch on.
- `FileLoopState.complete()` already stores `cost` on the outcome and `#addCost` already accumulates `totalUsd` with the agreed rules (`provider`/`estimated` advance the total including glitches; `unavailable` records tokens only; negative/non-finite is clamped to a no-op). Do not touch `src/loop-states/file.ts`.
- `LoopRunResult` already declares the reason `'maxBudgetUsd'`; this step adds the branch that emits it.
- `src/util/load-cli-config.ts` already carries Step 02's `--doctor` flag and the `effectiveDryRun = dryRun && !doctor` logic. Add `--max-budget-usd` without disturbing those.
- `src/cli.ts` is untested by design; keep it a thin pass-through (usage string only).

## File structure

Created:

- `src/util/pricing.ts` - `ModelPrice`, `TokenUsage`, and the pure `estimateCost` helper. No I/O, no env reads, no built-in price table.
- `src/util/__test__/pricing.test.ts` - unit tests for `estimateCost`.
- `src/examples/cost-budget/cost-budget.json` - example config exercising `prices` and `maxBudgetUsd` (validated by `src/__test__/schema.test.ts`).
- `src/examples/cost-budget/README.md` - short note describing the example.

Modified:

- `src/types.ts` - add optional `maxBudgetUsd` to `LoopCliConfig`.
- `src/agents/claude-sdk.ts` - export `extractClaudeCost`; attach cost on success/glitch/error return paths.
- `src/agents/openai-sdk.ts` - add `prices?` to config; export `extractOpenAIUsage` and `resolveOpenAIModel`; attach cost.
- `src/agents/codex-cli.ts` - add `model?` and `prices?` to config; add a `TokenAccumulator`; attach cost.
- `src/reporters/yaml.ts` - emit a `cost` block.
- `src/loop.ts` - thread `maxBudgetUsd`; startup stop; post-completion budget stop; verbose cost log.
- `src/util/load-cli-config.ts` - `--max-budget-usd` parsing and merge; usage string.
- `src/cli.ts` - mention `--max-budget-usd` in help text.
- `schema/loop-the-loop.schema.json` - top-level `maxBudgetUsd`; shared `modelPrice`/`prices`; `model` on codex config.
- `src/__test__/schema.test.ts` - positive case (prices + maxBudgetUsd) and negative case (prices missing `inputPerMtok`).
- Agent test files (`src/agents/__test__/{claude-sdk,openai-sdk,codex-cli}.test.ts`) - helper tests.
- `src/reporters/__test__/{yaml,jsonl}.test.ts` - cost serialization tests.
- `src/__test__/loop.test.ts` - budget and cost-log tests.
- `src/util/__test__/load-cli-config.test.ts` - `--max-budget-usd` tests.
- `README.md` - "Cost accounting and budgets" section.

## Execution and commit protocol

Each section below is self-contained and ends with a commit. Sections are ordered so the build stays green (`pnpm tsc && pnpm test --coverage` clean, 100% coverage) after every commit. Dispatch one fresh sub-agent per section. Between sections the orchestrator runs the completion gate and reviews the diff before starting the next section.

Per AGENTS.md: stay on the `main` branch, do not open PRs, never run `git add`/`git mv`/`git rm` outside the commit step, use the default `~/.gitconfig` author, and do NOT add a `Co-Authored-By` trailer. Commit message tags follow recent history (`Feature:`, `Fix:`, `Docs:`). Before each commit run `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`.

---

## Section 1: Pricing helper

A pure function with no dependencies, built and committed first so later agents can import it.

**Files:**

- Create: `src/util/pricing.ts`
- Test: `src/util/__test__/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/util/__test__/pricing.test.ts`:

```ts
// @module-tag local

import { describe, expect, it } from 'vitest';

import { estimateCost, type ModelPrice } from 'loop-the-loop/util/pricing';

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
    expect(estimateCost('unknown', { inputTokens: 100 }, PRICES)).toBeUndefined();
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/util/__test__/pricing.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/util/pricing`.

- [ ] **Step 3: Implement `src/util/pricing.ts`**

```ts
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/util/__test__/pricing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, no format diff, coverage 100%.

- [ ] **Step 6: Commit**

```bash
git add src/util/pricing.ts src/util/__test__/pricing.test.ts
git commit -m "Feature: Add pure estimateCost pricing helper"
```

---

## Section 2: Claude SDK provider cost

claude-sdk reports a real USD figure, so its cost is always `'provider'`. The agent file keeps `// istanbul ignore file`; `extractClaudeCost` is exported and unit-tested for correctness.

**Files:**

- Modify: `src/agents/claude-sdk.ts`
- Test: `src/agents/__test__/claude-sdk.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/agents/__test__/claude-sdk.test.ts` (import `extractClaudeCost` alongside the existing imports from `loop-the-loop/agents/claude-sdk`):

```ts
describe('extractClaudeCost', () => {
  it('reads the provider cost and usage from a result message', () => {
    const cost = extractClaudeCost({
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 1200,
        output_tokens: 380,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
      modelUsage: { 'claude-opus-4-7': { inputTokens: 1200 } },
    });
    expect(cost).toEqual({
      usd: 0.0421,
      costSource: 'provider',
      inputTokens: 1200,
      outputTokens: 380,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      model: 'claude-opus-4-7',
    });
  });

  it('omits the model when modelUsage has zero or multiple keys', () => {
    expect(extractClaudeCost({ total_cost_usd: 1, modelUsage: {} }).model).toBeUndefined();
    expect(
      extractClaudeCost({
        total_cost_usd: 1,
        modelUsage: { a: {}, b: {} },
      }).model,
    ).toBeUndefined();
  });

  it('defaults usd to 0 and omits absent token fields', () => {
    expect(extractClaudeCost({})).toEqual({ usd: 0, costSource: 'provider' });
  });

  it('ignores non-numeric usage and cost fields', () => {
    const cost = extractClaudeCost({
      total_cost_usd: 'free',
      usage: { input_tokens: 'lots' },
    });
    expect(cost).toEqual({ usd: 0, costSource: 'provider' });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/agents/__test__/claude-sdk.test.ts`
Expected: FAIL - `extractClaudeCost` is not exported.

- [ ] **Step 3: Implement `extractClaudeCost` and wire it into the return paths**

In `src/agents/claude-sdk.ts`, add `CostInfo` to the type import from `../types.js`, and add these helpers near the other exported functions:

```ts
/**
 * Build a `CostInfo` from a claude-sdk result message. The SDK reports a
 * real USD figure (`total_cost_usd`) so `costSource` is always `'provider'`.
 * The model is taken from `modelUsage` only when it has exactly one key.
 */
export function extractClaudeCost(
  resultMsg: Record<string, unknown>,
): CostInfo {
  const usage = asRecord(resultMsg['usage']);
  const modelUsage = asRecord(resultMsg['modelUsage']);
  const models = Object.keys(modelUsage);
  const model = models.length === 1 ? models[0] : undefined;

  return {
    usd:
      typeof resultMsg['total_cost_usd'] === 'number'
        ? resultMsg['total_cost_usd']
        : 0,
    costSource: 'provider',
    ...numericField('inputTokens', usage['input_tokens']),
    ...numericField('outputTokens', usage['output_tokens']),
    ...numericField('cacheReadTokens', usage['cache_read_input_tokens']),
    ...numericField('cacheCreationTokens', usage['cache_creation_input_tokens']),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Narrow an unknown value to a record, defaulting to an empty object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/**
 * Return `{ [key]: value }` when `value` is a finite number, otherwise an
 * empty object so the field is omitted from the spread.
 */
function numericField(
  key: string,
  value: unknown,
): Record<string, number> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { [key]: value }
    : {};
}
```

Then attach the cost to each return path that has a result message. In `invoke`, compute the cost once when a `result` message arrives and pass it through:

- In the `subtype === 'success'` branch, change the success return to include cost:

```ts
return ClaudeSDKAgent.#successResult(
  finalText,
  structuredOutput,
  extractClaudeCost(resultMsg),
);
```

- In the `error_max_turns` branch, change the return to:

```ts
return { status: 'error', reason, cost: extractClaudeCost(resultMsg) };
```

- In the final classified branch, change to:

```ts
return { status, reason, cost: extractClaudeCost(resultMsg) };
```

Leave the post-loop "collected text" fallback and the `catch` path without cost (no usage is available there).

Update `#successResult` to accept and attach the cost:

```ts
static #successResult(
  output: string,
  structuredOutput: unknown,
  cost?: CostInfo,
): SuccessfulInvocationResult {
  return {
    status: 'success',
    output,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}
```

The existing call site in the post-loop fallback (`ClaudeSDKAgent.#successResult(textParts.join('\n'), structuredOutput)`) keeps working since `cost` is optional.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/agents/__test__/claude-sdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: green (claude-sdk.ts is istanbul-ignored so the new wiring does not affect coverage).

- [ ] **Step 6: Commit**

```bash
git add src/agents/claude-sdk.ts src/agents/__test__/claude-sdk.test.ts
git commit -m "Feature: Extract provider cost from claude-sdk results"
```

---

## Section 3: OpenAI SDK estimated cost

openai-sdk has no provider USD figure, so it sums token counts and estimates USD only when prices are configured for the resolved model.

**Files:**

- Modify: `src/agents/openai-sdk.ts`
- Test: `src/agents/__test__/openai-sdk.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/agents/__test__/openai-sdk.test.ts` (import `extractOpenAIUsage` and `resolveOpenAIModel` from `loop-the-loop/agents/openai-sdk`):

```ts
describe('resolveOpenAIModel', () => {
  it('prefers the last agent model, then config, then unknown', () => {
    expect(resolveOpenAIModel({ model: 'gpt-5' }, { model: 'gpt-4' })).toBe('gpt-5');
    expect(resolveOpenAIModel(undefined, { model: 'gpt-4' })).toBe('gpt-4');
    expect(resolveOpenAIModel(undefined, {})).toBe('unknown');
    expect(resolveOpenAIModel({}, {})).toBe('unknown');
  });
});

describe('extractOpenAIUsage', () => {
  it('sums input/output across responses and reads detail keys', () => {
    const usage = extractOpenAIUsage([
      {
        usage: {
          inputTokens: 100,
          outputTokens: 30,
          inputTokensDetails: [{ cached_tokens: 10 }],
          outputTokensDetails: [{ reasoning_tokens: 5 }],
        },
      },
      {
        usage: {
          inputTokens: 200,
          outputTokens: 40,
          inputTokensDetails: { cached_tokens: 20 },
          outputTokensDetails: { reasoning_tokens: 6 },
        },
      },
    ]);
    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 70,
      cacheReadTokens: 30,
      reasoningTokens: 11,
    });
  });

  it('returns zeroed usage for empty or malformed responses', () => {
    expect(extractOpenAIUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
    expect(extractOpenAIUsage([{}, { usage: null }])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/agents/__test__/openai-sdk.test.ts`
Expected: FAIL - helpers not exported.

- [ ] **Step 3: Implement the helpers, config field, and wiring**

In `src/agents/openai-sdk.ts`:

Add `prices?` to `OpenAISDKAgentConfig`, and import the pricing helper and `CostInfo`:

```ts
import { estimateCost, type ModelPrice, type TokenUsage } from '../util/pricing.js';
```

(add `CostInfo` to the existing `../types.js` import) and inside the config interface:

```ts
  /**
   * Per-model prices keyed by model id. When the resolved model is priced,
   * the agent estimates USD cost; otherwise it records tokens only.
   */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
```

Add the exported helpers near the other exported functions:

```ts
/**
 * Resolve the model name used for cost estimation: the SDK's last agent
 * model wins, then the configured model, then `'unknown'`.
 */
export function resolveOpenAIModel(
  lastAgent: unknown,
  config: OpenAISDKAgentConfig,
): string {
  const fromAgent =
    isRecord(lastAgent) && typeof lastAgent['model'] === 'string'
      ? lastAgent['model']
      : undefined;
  return fromAgent ?? config.model ?? 'unknown';
}

/**
 * Sum token usage across a run's raw model responses. Cache-read tokens are
 * read from `inputTokensDetails.cached_tokens` and reasoning tokens from
 * `outputTokensDetails.reasoning_tokens`; both detail fields may be a single
 * record or an array of records.
 */
export function extractOpenAIUsage(
  rawResponses: ReadonlyArray<unknown>,
): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;

  for (const response of rawResponses) {
    const usage = isRecord(response) ? response['usage'] : undefined;
    if (!isRecord(usage)) {
      continue;
    }
    inputTokens += asNumber(usage['inputTokens']);
    outputTokens += asNumber(usage['outputTokens']);
    cacheReadTokens += sumDetailKey(usage['inputTokensDetails'], 'cached_tokens');
    reasoningTokens += sumDetailKey(
      usage['outputTokensDetails'],
      'reasoning_tokens',
    );
  }

  return { inputTokens, outputTokens, cacheReadTokens, reasoningTokens };
}

/**
 * Sum a numeric key across a detail value that may be a single record or an
 * array of records.
 */
function sumDetailKey(detail: unknown, key: string): number {
  if (Array.isArray(detail)) {
    return detail.reduce<number>(
      (sum, entry) => sum + (isRecord(entry) ? asNumber(entry[key]) : 0),
      0,
    );
  }
  return isRecord(detail) ? asNumber(detail[key]) : 0;
}

/**
 * Coerce an unknown value to a finite number, defaulting to 0.
 */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Build a `CostInfo` for an OpenAI run: estimated when the resolved model is
 * priced, otherwise `'unavailable'` with the raw token counts (and a single
 * warning logged so the missing pricing is visible).
 */
export function buildOpenAICost(
  rawResponses: ReadonlyArray<unknown>,
  lastAgent: unknown,
  config: OpenAISDKAgentConfig,
  logger: Logger,
): CostInfo {
  const usage = extractOpenAIUsage(rawResponses);
  const model = resolveOpenAIModel(lastAgent, config);
  const tokenFields = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    model,
  };

  const estimate =
    config.prices !== undefined
      ? estimateCost(model, usage, config.prices)
      : undefined;
  if (estimate === undefined) {
    logger.system(
      `No pricing configured for openai-sdk model '${model}'; recording tokens only`,
    );
    return { usd: 0, costSource: 'unavailable', ...tokenFields };
  }
  return { usd: estimate.usd, costSource: 'estimated', ...tokenFields };
}
```

Wire `buildOpenAICost` into `invoke`'s success path. After `const invokeResult = normalizeFinalOutput(result.finalOutput);`, attach cost when the result is a success:

```ts
const cost = buildOpenAICost(result.rawResponses, result.lastAgent, this.#config, logger);
const withCost: InvokeResult =
  invokeResult.status === 'success'
    ? { ...invokeResult, cost }
    : { ...invokeResult, cost };
```

(Both branches attach cost; the explicit `status` check is only to keep the discriminated-union types narrow. A single `{ ...invokeResult, cost }` also type-checks, so prefer that simpler form and return `withCost`.) Use `withCost` in place of `invokeResult` in the subsequent `if (invokeResult.status === 'success')` logging block and the final `return`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/agents/__test__/openai-sdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: green (openai-sdk.ts is istanbul-ignored).

- [ ] **Step 6: Commit**

```bash
git add src/agents/openai-sdk.ts src/agents/__test__/openai-sdk.test.ts
git commit -m "Feature: Estimate openai-sdk cost from token usage"
```

---

## Section 4: Codex CLI estimated cost

codex-cli streams JSONL events; a `TokenAccumulator` keeps the latest cumulative `token_count` totals across both event shapes Codex has shipped.

**Files:**

- Modify: `src/agents/codex-cli.ts`
- Test: `src/agents/__test__/codex-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/agents/__test__/codex-cli.test.ts` (import `TokenAccumulator` from `loop-the-loop/agents/codex-cli`):

```ts
describe('TokenAccumulator', () => {
  it('reads cumulative totals from the top-level token_count shape', () => {
    const acc = new TokenAccumulator();
    acc.observe({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          output_tokens: 30,
          cached_input_tokens: 10,
          reasoning_output_tokens: 5,
        },
      },
    });
    expect(acc.snapshot()).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 10,
      reasoningTokens: 5,
    });
  });

  it('reads the msg-wrapped token_count shape', () => {
    const acc = new TokenAccumulator();
    acc.observe({
      msg: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 7, output_tokens: 2 } },
      },
    });
    expect(acc.snapshot()).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('keeps the latest cumulative snapshot, not a sum of deltas', () => {
    const acc = new TokenAccumulator();
    acc.observe({ type: 'token_count', info: { total_token_usage: { input_tokens: 100 } } });
    acc.observe({ type: 'token_count', info: { total_token_usage: { input_tokens: 250 } } });
    expect(acc.snapshot()?.inputTokens).toBe(250);
  });

  it('ignores non token_count events and returns undefined when none seen', () => {
    const acc = new TokenAccumulator();
    acc.observe({ type: 'agent_message', message: 'hi' });
    acc.observe({ msg: { type: 'task_started' } });
    expect(acc.snapshot()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/agents/__test__/codex-cli.test.ts`
Expected: FAIL - `TokenAccumulator` not exported.

- [ ] **Step 3: Implement `TokenAccumulator` and config fields**

In `src/agents/codex-cli.ts`:

Add `model?` and `prices?` to `CodexCLIAgentConfig` and import the pricing types:

```ts
import { estimateCost, type ModelPrice, type TokenUsage } from '../util/pricing.js';
```

(add `CostInfo` to the existing `../types.js` import) and in the config interface:

```ts
  /**
   * Codex model to run. Forwarded to `codex exec --model` and used for cost
   * estimation. Falls back to the `CODEX_MODEL` env var when omitted.
   */
  readonly model?: string;

  /**
   * Per-model prices keyed by model id. When the resolved model is priced
   * the agent estimates USD cost; otherwise it records tokens only.
   */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
```

Add the accumulator class, co-located with `LineBuffer`:

```ts
/**
 * Accumulates token usage from Codex `token_count` JSONL events. Codex
 * reports cumulative totals (not per-turn deltas) so the accumulator keeps
 * the latest snapshot seen. Both the top-level (`event.type`) and the
 * msg-wrapped (`event.msg.type`) shapes Codex has shipped are recognised.
 */
export class TokenAccumulator {
  #latest: TokenUsage | undefined;

  observe(event: JsonObject): void {
    const usage = tokenCountUsage(event);
    if (usage !== undefined) {
      this.#latest = usage;
    }
  }

  snapshot(): TokenUsage | undefined {
    return this.#latest;
  }
}

/**
 * Return normalised token usage if `event` is a `token_count` event in
 * either shape, otherwise undefined. Totals are read from
 * `info.total_token_usage`, falling back to `info`, then the carrier itself.
 */
function tokenCountUsage(event: JsonObject): TokenUsage | undefined {
  const carrier =
    event['type'] === 'token_count'
      ? event
      : getObject(event['msg'])?.['type'] === 'token_count'
        ? getObject(event['msg'])
        : undefined;
  if (carrier === undefined) {
    return undefined;
  }

  const info = getObject(carrier['info']);
  const totals =
    getObject(info?.['total_token_usage']) ?? info ?? carrier;

  return {
    inputTokens: numberAt(totals, 'input_tokens'),
    outputTokens: numberAt(totals, 'output_tokens'),
    cacheReadTokens: numberAt(totals, 'cached_input_tokens'),
    reasoningTokens: numberAt(totals, 'reasoning_output_tokens'),
  };
}

/**
 * Read a finite numeric property from a record, defaulting to 0.
 */
function numberAt(obj: JsonObject, key: string): number {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Build a `CostInfo` from accumulated Codex usage: estimated when the
 * resolved model is priced, otherwise `'unavailable'` with tokens only.
 */
export function buildCodexCost(
  usage: TokenUsage | undefined,
  config: CodexCLIAgentConfig,
  logger: Logger | undefined,
): CostInfo | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const model = config.model ?? CODEX_MODEL ?? 'unknown';
  const tokenFields = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    model,
  };
  const estimate =
    config.prices !== undefined ? estimateCost(model, usage, config.prices) : undefined;
  if (estimate === undefined) {
    logger?.system(
      `No pricing configured for codex-cli model '${model}'; recording tokens only`,
    );
    return { usd: 0, costSource: 'unavailable', ...tokenFields };
  }
  return { usd: estimate.usd, costSource: 'estimated', ...tokenFields };
}
```

Wire the accumulator into `runCodex`: construct one `TokenAccumulator` and feed every parsed stdout JSON line into it (independent of `logger.enabled`, since cost must be tracked even in quiet mode). The simplest seam is to parse lines in the existing stdout `LineBuffer` path. Add an `onEvent` callback to `runCodex` (or return the accumulator's snapshot on the result). Concretely:

- Add `tokenUsage?: TokenUsage` to `CodexProcessResult`.
- In `runCodex`, create `const tokens = new TokenAccumulator();` and a stdout line handler that parses JSON and calls `tokens.observe(parsed)` for object events, in addition to the existing verbose logging. Replace the verbose-only `stdoutLogger` line callback so it always parses for tokens but only logs when `logger?.enabled`.
- In `finish`, set `tokenUsage: tokens.snapshot()` on the result.

Then in `invoke`, attach cost to the success and timeout returns:

```ts
if (codexResult.timedOut) {
  return {
    status: 'glitch',
    reason: `Codex timed out after ${String(timeoutMs)}ms`,
    ...withCodexCost(codexResult.tokenUsage, this.#config, options?.logger),
  };
}
```

where `withCodexCost` returns `{ cost }` or `{}`:

```ts
function withCodexCost(
  usage: TokenUsage | undefined,
  config: CodexCLIAgentConfig,
  logger: Logger | undefined,
): { cost?: CostInfo } {
  const cost = buildCodexCost(usage, config, logger);
  return cost !== undefined ? { cost } : {};
}
```

Apply the same `...withCodexCost(...)` spread to the success return and the error returns that follow a real process result (the `No output received` and `buildExecErrorText` paths). Leave a return with no token data uncosted.

Also update `buildCommandArgs` to prefer `config.model`: pass the resolved model so `--model` reflects the configured value. Since `buildCommandArgs` currently reads the module-level `CODEX_MODEL`, thread the config model through by having `invoke` pass `this.#config.model ?? CODEX_MODEL` and push `--model` when defined. Keep this change minimal and behaviour-compatible when neither is set.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/agents/__test__/codex-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: green (codex-cli.ts is istanbul-ignored).

- [ ] **Step 6: Commit**

```bash
git add src/agents/codex-cli.ts src/agents/__test__/codex-cli.test.ts
git commit -m "Feature: Estimate codex-cli cost from token_count events"
```

---

## Section 5: Reporter cost serialization

The YAML reporter gains a `cost` block; the JSONL reporter already spreads `result` so cost appears automatically (covered by a new test).

**Files:**

- Modify: `src/reporters/yaml.ts`
- Test: `src/reporters/__test__/yaml.test.ts`, `src/reporters/__test__/jsonl.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/reporters/__test__/yaml.test.ts` a test that appends a success result carrying cost and asserts the block. Match the existing test setup in that file (tmp dir + reading the file back); the assertion is on the emitted lines:

```ts
it('emits a cost block for an estimated cost', async () => {
  const { reporter, read } = await makeReporter(); // use the file's existing helper
  await reporter.append(
    { id: 'a', prompt: 'p' },
    {
      status: 'success',
      output: 'done',
      cost: {
        usd: 0.01234,
        costSource: 'estimated',
        model: 'gpt-5-mini',
        inputTokens: 1200,
        outputTokens: 380,
      },
    },
  );
  const text = await read();
  expect(text).toContain('cost:\n');
  expect(text).toContain('  costSource: "estimated"\n');
  expect(text).toContain('  usd: 0.01234\n');
  expect(text).toContain('  model: "gpt-5-mini"\n');
  expect(text).toContain('  inputTokens: 1200\n');
  expect(text).toContain('  outputTokens: 380\n');
});

it('omits the cost block when cost is absent', async () => {
  const { reporter, read } = await makeReporter();
  await reporter.append({ id: 'a', prompt: 'p' }, { status: 'success', output: 'x' });
  expect(await read()).not.toContain('cost:');
});

it('emits costSource unavailable with tokens and zero usd', async () => {
  const { reporter, read } = await makeReporter();
  await reporter.append(
    { id: 'a', prompt: 'p' },
    {
      status: 'error',
      reason: 'boom',
      cost: { usd: 0, costSource: 'unavailable', inputTokens: 5 },
    },
  );
  const text = await read();
  expect(text).toContain('  costSource: "unavailable"\n');
  expect(text).toContain('  usd: 0\n');
  expect(text).toContain('  inputTokens: 5\n');
});
```

(If the YAML test file does not already have a `makeReporter`/`read` helper, follow whatever tmp-file pattern the existing tests in that file use - construct a `YamlReporter` on a tmp path and read it back with `readFile`.)

Add to `src/reporters/__test__/jsonl.test.ts`:

```ts
it('serializes cost when present and omits it when absent', async () => {
  const { reporter, read } = await makeReporter();
  await reporter.append(
    { id: 'a', prompt: 'p' },
    { status: 'success', output: 'x', cost: { usd: 0.5, costSource: 'provider' } },
  );
  await reporter.append({ id: 'b', prompt: 'p' }, { status: 'success', output: 'y' });
  const lines = (await read()).trim().split('\n').map(l => JSON.parse(l));
  expect(lines[0].cost).toEqual({ usd: 0.5, costSource: 'provider' });
  expect(lines[1].cost).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/reporters/__test__/yaml.test.ts`
Expected: FAIL - no `cost:` block emitted.

(The JSONL test should already PASS since `append` spreads `result`; if so, note it as a regression guard rather than red/green.)

- [ ] **Step 3: Implement the YAML cost block**

In `src/reporters/yaml.ts`, import `CostInfo`:

```ts
import type { CostInfo, InvokeResult } from '../types.js';
```

In `append`, after `lines.push(`status: ${result.status}`);` and before the success/else branch, insert:

```ts
if (result.cost !== undefined) {
  lines.push(...formatCostBlock(result.cost));
}
```

Add the helper at the bottom of the file:

```ts
/**
 * Render a `CostInfo` as YAML lines. `costSource` and `model` go through
 * `JSON.stringify` (quoted); numeric token counts and `usd` are emitted as
 * unquoted scalars. Undefined fields are omitted.
 */
function formatCostBlock(cost: CostInfo): Array<string> {
  const lines = ['cost:'];
  lines.push(`  costSource: ${JSON.stringify(cost.costSource)}`);
  lines.push(`  usd: ${cost.usd}`);
  if (cost.model !== undefined) {
    lines.push(`  model: ${JSON.stringify(cost.model)}`);
  }
  pushNumber(lines, 'inputTokens', cost.inputTokens);
  pushNumber(lines, 'outputTokens', cost.outputTokens);
  pushNumber(lines, 'cacheReadTokens', cost.cacheReadTokens);
  pushNumber(lines, 'cacheCreationTokens', cost.cacheCreationTokens);
  pushNumber(lines, 'reasoningTokens', cost.reasoningTokens);
  return lines;
}

/**
 * Append `  key: value` when value is defined, as an unquoted numeric scalar.
 */
function pushNumber(
  lines: Array<string>,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) {
    lines.push(`  ${key}: ${value}`);
  }
}
```

Note: to keep 100% coverage, ensure the tests exercise the `model` present/absent paths and at least one `pushNumber` defined path and one undefined path (the three tests above cover model present, model absent, and several token fields present/absent).

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test src/reporters/__test__/yaml.test.ts src/reporters/__test__/jsonl.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: green, yaml.ts at 100%.

- [ ] **Step 6: Commit**

```bash
git add src/reporters/yaml.ts src/reporters/__test__/yaml.test.ts src/reporters/__test__/jsonl.test.ts
git commit -m "Feature: Serialize cost in the YAML reporter"
```

---

## Section 6: Budget enforcement and cost logging in the loop

Thread `maxBudgetUsd` through `loop()`/`loopImpl()`, stop immediately when the persisted total is already at/over budget, stop after the prompt that crosses the cap, and log cost verbosely.

**Files:**

- Modify: `src/types.ts`, `src/loop.ts`
- Test: `src/__test__/loop.test.ts`

- [ ] **Step 1: Add the config field to `src/types.ts`**

In `LoopCliConfig`, after `maxPrompts`:

```ts
  /**
   * Lifetime USD budget across resumes. When set, the loop stops after the
   * prompt whose completion takes the persisted total at or above this cap,
   * and stops immediately at startup if the persisted total is already at or
   * above it. Track-only when omitted.
   */
  readonly maxBudgetUsd?: number;
```

- [ ] **Step 2: Write the failing tests**

Add to `src/__test__/loop.test.ts`. Use the `test` agent (or the existing `RecordingAgent`/`TestAgent` helpers) with results carrying `cost`. Drive via the file's existing `runMainWithFakeTimers` helper.

```ts
it('stops after the prompt that crosses maxBudgetUsd', async () => {
  const agent = new TestAgent({
    responses: [
      { status: 'success', output: 'a', cost: { usd: 0.6, costSource: 'estimated' } },
      { status: 'success', output: 'b', cost: { usd: 0.6, costSource: 'estimated' } },
    ],
  });
  // Build a config that uses this agent and a 2-prompt generator, with
  // maxBudgetUsd: 1, following the construction pattern already used in this
  // file. Expect the run to stop with reason 'maxBudgetUsd' after prompt 1
  // (total 0.6 < 1 after a, then 1.2 >= 1 after b -> stop on b). Adjust the
  // numbers so the crossing happens on the second prompt.
  const result = await runMainWithFakeTimers(config);
  expect(result).toEqual({
    status: 'stopped',
    reason: 'maxBudgetUsd',
    message: expect.stringContaining('Budget'),
  });
});

it('stops immediately at startup when the persisted total is already over budget', async () => {
  // Pre-write a loop-state file at `${outputDir}/${name}-loop-state.json`
  // with { version: 2, results: {}, claims: {}, totalUsd: 5 } and run with
  // maxBudgetUsd: 1. Expect stopped/maxBudgetUsd and that the agent was
  // never invoked.
  const result = await runMainWithFakeTimers(config);
  expect(result.status).toBe('stopped');
  expect(result.reason).toBe('maxBudgetUsd');
});

it('does not advance the budget for unavailable cost', async () => {
  // Two results with cost.costSource 'unavailable' (usd 0) and maxBudgetUsd 1.
  // Expect the run to complete normally (status 'completed'), proving
  // unavailable cost never triggers the budget stop.
  const result = await runMainWithFakeTimers(config);
  expect(result.status).toBe('completed');
});

it('logs cost verbosely when a logger is enabled', async () => {
  // Run with logger: 'verbose' and a result carrying cost; spy on
  // stderr (the existing tests in this file already show how to capture
  // verbose output) and assert a line containing 'Cost:' and the usd value.
});
```

The exact `config` object construction must follow the patterns already present in `loop.test.ts` (the `FixedPromptGenerator` + a reporter on a tmp `outputDir`). Keep `interPromptPause` at its default and use `runMainWithFakeTimers` so pauses resolve instantly.

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: FAIL - no budget stop branch yet.

- [ ] **Step 4: Implement in `src/loop.ts`**

Import `CostInfo`:

```ts
import type { CostInfo, LoopCliConfig, LoopRunResult } from './types.js';
```

In `loop()`, pass the budget into `loopImpl`:

```ts
maxBudgetUsd: config.maxBudgetUsd ?? Infinity,
```

Add to the `LoopConfig` interface:

```ts
  readonly maxBudgetUsd: number;
```

In `loopImpl`, destructure `maxBudgetUsd` and add the startup stop after `logger.state(`Loaded loop state for ${name}`);`:

```ts
const startingTotal = (await loopState.getSnapshot()).totalUsd;
if (startingTotal >= maxBudgetUsd) {
  const message = `Budget already reached: $${startingTotal.toFixed(4)} >= $${maxBudgetUsd}`;
  logger.state(message);
  return { status: 'stopped', reason: 'maxBudgetUsd', message };
}
```

(With the default `Infinity`, `0 >= Infinity` is false, so unconfigured runs are unaffected.)

After the success/glitch/error `if/else` block (the error branch already returns, so this runs for success and glitch), before `completed++`, add the cost log and budget stop:

```ts
if (result.cost !== undefined) {
  logger.state(`Cost: ${formatCost(result.cost)}`);
}
const runningTotal = (await loopState.getSnapshot()).totalUsd;
if (runningTotal >= maxBudgetUsd) {
  const message = `Budget reached after ${prompt.id}: $${runningTotal.toFixed(4)} >= $${maxBudgetUsd}`;
  logger.state(message);
  return { status: 'stopped', reason: 'maxBudgetUsd', message };
}
```

Add the formatter near the bottom of the file:

```ts
/**
 * One-line human summary of a cost record for the verbose log.
 */
function formatCost(cost: CostInfo): string {
  if (cost.costSource === 'unavailable') {
    return `tokens only (in=${cost.inputTokens ?? 0}, out=${cost.outputTokens ?? 0})`;
  }
  const model = cost.model !== undefined ? `, ${cost.model}` : '';
  return `$${cost.usd.toFixed(4)} (${cost.costSource}${model})`;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: PASS. Confirm both `formatCost` branches (priced and `unavailable`) are exercised so loop.ts stays at 100%.

- [ ] **Step 6: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: green, loop.ts at 100%.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/loop.ts src/__test__/loop.test.ts
git commit -m "Feature: Stop the loop at a configured maxBudgetUsd"
```

---

## Section 7: `--max-budget-usd` CLI flag

Add the value flag to the parser and the config merge, mirroring `--max-prompts` but accepting decimals and rejecting non-positive values.

**Files:**

- Modify: `src/util/load-cli-config.ts`, `src/cli.ts`
- Test: `src/util/__test__/load-cli-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/util/__test__/load-cli-config.test.ts` (follow the file's existing `parseArgs` test style):

```ts
describe('--max-budget-usd', () => {
  it('parses an integer value', () => {
    expect(parseArgs(['--max-budget-usd', '5', 'c.json']).maxBudgetUsd).toBe(5);
  });

  it('parses a decimal value', () => {
    expect(parseArgs(['--max-budget-usd=2.5', 'c.json']).maxBudgetUsd).toBe(2.5);
  });

  it.each(['0', '-1', 'abc', 'NaN', ''])(
    'rejects %s',
    value => {
      expect(() => parseArgs([`--max-budget-usd=${value}`, 'c.json'])).toThrow(
        /Invalid --max-budget-usd value/u,
      );
    },
  );

  it('is undefined when not passed', () => {
    expect(parseArgs(['c.json']).maxBudgetUsd).toBeUndefined();
  });
});
```

And a merge test alongside the existing `loadCliConfig` tests (writing a minimal valid config to a tmp file, then asserting the parsed `maxBudgetUsd` lands on the returned config):

```ts
it('merges maxBudgetUsd from the CLI flag into the config', async () => {
  // write a minimal valid config (name + test agent + per-file generator)
  // to a tmp path, then:
  const config = await loadCliConfig({ configPath, maxBudgetUsd: 3 });
  expect(config.maxBudgetUsd).toBe(3);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: FAIL - `maxBudgetUsd` not parsed.

- [ ] **Step 3: Implement in `src/util/load-cli-config.ts`**

Add `maxBudgetUsd?: number` to `ParsedArgs`.

Widen `VALUE_FLAGS`:

```ts
const VALUE_FLAGS: ReadonlyMap<string, 'maxPrompts' | 'maxBudgetUsd'> = new Map([
  ['maxprompts', 'maxPrompts'],
  ['maxbudgetusd', 'maxBudgetUsd'],
]);
```

Add a `let maxBudgetUsd: number | undefined;` next to `maxPrompts`, and replace the `istanbul ignore else` value-flag block with a real two-branch dispatch:

```ts
if (valueField === 'maxPrompts') {
  const n = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid --${rawKey} value: ${value}`);
  }
  maxPrompts = n;
} else {
  const n = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --${rawKey} value: ${value}`);
  }
  maxBudgetUsd = n;
}
```

(The decimal regex rejects negatives and non-numerics; `n <= 0` rejects `0`.)

Add `maxBudgetUsd` to both `return` objects (the help/version short-circuit and the main return).

Update `USAGE`:

```ts
export const USAGE =
  'Usage: loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--doctor] [--max-prompts N] [--max-budget-usd N] <config.json>';
```

In `loadCliConfig`, destructure `maxBudgetUsd` from `parsedArgs` and merge it (covered by the merge test, so no istanbul-ignore):

```ts
...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
```

- [ ] **Step 4: Update `src/cli.ts` help text**

Add a `--max-budget-usd N` line to whatever help/usage block `cli.ts` prints (it imports `USAGE`; if it has an additional per-flag help listing, add a one-line description: `--max-budget-usd N   Stop once the lifetime USD total reaches N`). `cli.ts` is untested by design; keep the change to text only.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: green, load-cli-config.ts at 100% (both value-flag branches now tested).

- [ ] **Step 7: Commit**

```bash
git add src/util/load-cli-config.ts src/cli.ts src/util/__test__/load-cli-config.test.ts
git commit -m "Feature: Add --max-budget-usd CLI flag"
```

---

## Section 8: Schema, example config, and README

Keep the schema, an example config, and the docs in lockstep with the new config surface (per the roadmap definition of done).

**Files:**

- Modify: `schema/loop-the-loop.schema.json`, `src/__test__/schema.test.ts`, `README.md`
- Create: `src/examples/cost-budget/cost-budget.json`, `src/examples/cost-budget/README.md`

- [ ] **Step 1: Add the schema (write the negative/positive cases first)**

Add to `src/__test__/schema.test.ts` a positive case and a negative case.

Positive (in the `positive cases` array):

```ts
[
  'openai-sdk with prices and a top-level maxBudgetUsd',
  {
    name: 'cost',
    maxBudgetUsd: 5,
    agent: [
      'openai-sdk',
      { prices: { 'gpt-5-mini': { inputPerMtok: 0.25, outputPerMtok: 2 } } },
    ],
    promptGenerator: ['per-file', { filePattern: 'x', promptTemplate: 'y' }],
  },
],
```

Negative (in the `negative cases` array):

```ts
[
  'rejects a price entry missing inputPerMtok',
  {
    name: 'cost',
    agent: ['openai-sdk', { prices: { m: { outputPerMtok: 2 } } }],
    promptGenerator: ['per-file', { filePattern: 'x', promptTemplate: 'y' }],
  },
],
[
  'rejects a non-positive maxBudgetUsd',
  {
    name: 'cost',
    maxBudgetUsd: 0,
    agent: 'claude-sdk',
    promptGenerator: ['per-file', { filePattern: 'x', promptTemplate: 'y' }],
  },
],
```

- [ ] **Step 2: Run the schema test and verify the new cases fail**

Run: `pnpm test src/__test__/schema.test.ts`
Expected: FAIL - the positive case is rejected (no `prices`/`maxBudgetUsd` in schema) and/or the negative cases pass validation when they should not.

- [ ] **Step 3: Edit `schema/loop-the-loop.schema.json`**

Add the top-level property (next to `maxPrompts`):

```json
"maxBudgetUsd": {
  "type": "number",
  "exclusiveMinimum": 0,
  "description": "Lifetime USD budget across resumes. The loop stops after the prompt whose completion takes the persisted total at or above this cap, and stops immediately at startup if it is already at or above it. Track-only when omitted."
}
```

Add a shared `modelPrice` definition under `definitions`:

```json
"modelPrice": {
  "type": "object",
  "additionalProperties": false,
  "required": ["inputPerMtok", "outputPerMtok"],
  "properties": {
    "inputPerMtok": { "type": "number", "minimum": 0 },
    "outputPerMtok": { "type": "number", "minimum": 0 },
    "cacheReadPerMtok": { "type": "number", "minimum": 0 },
    "cacheCreationPerMtok": { "type": "number", "minimum": 0 },
    "reasoningPerMtok": { "type": "number", "minimum": 0 }
  },
  "description": "Per-million-token prices for one model. cacheRead/cacheCreation/reasoning rates default to multiples of input/output when omitted."
}
```

Add a `prices` property to BOTH `openaiSdkAgentConfig` and `codexCliAgentConfig`:

```json
"prices": {
  "type": "object",
  "additionalProperties": { "$ref": "#/definitions/modelPrice" },
  "description": "Per-model prices keyed by model id, used to estimate USD cost. When the resolved model is unpriced the agent records tokens only (costSource 'unavailable')."
}
```

Add a `model` property to `codexCliAgentConfig`:

```json
"model": {
  "type": "string",
  "minLength": 1,
  "description": "Codex model to run (forwarded to `codex exec --model`) and used for cost estimation. Falls back to the CODEX_MODEL env var when omitted."
}
```

- [ ] **Step 4: Create the example config**

`src/examples/cost-budget/cost-budget.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/joewalker/loop-the-loop/refs/heads/main/schema/loop-the-loop.schema.json",
  "name": "cost-budget",
  "maxBudgetUsd": 5,
  "agent": [
    "openai-sdk",
    {
      "model": "gpt-5-mini",
      "prices": {
        "gpt-5-mini": {
          "inputPerMtok": 0.25,
          "outputPerMtok": 2,
          "cacheReadPerMtok": 0.025,
          "reasoningPerMtok": 2
        }
      }
    }
  ],
  "promptGenerator": [
    "per-file",
    {
      "filePattern": "src/**/*.ts",
      "excludePatterns": ["**/__test__/**", "**/*.test.ts"],
      "promptTemplate": "Summarise the responsibilities of {{file}} in two sentences."
    }
  ]
}
```

`src/examples/cost-budget/README.md`:

```markdown
# cost-budget example

Demonstrates cost accounting and budgets:

- `prices` on the openai-sdk agent supplies per-million-token rates for the
  resolved model, so each result carries an estimated USD cost
  (`costSource: estimated`). Without `prices` the agent records token counts
  only (`costSource: unavailable`).
- `maxBudgetUsd` caps the lifetime spend across resumes. The run stops after
  the prompt whose completion takes the persisted total at or above the cap.

claude-sdk needs no `prices`: it reports a real provider cost directly
(`costSource: provider`).
```

- [ ] **Step 5: Add the README section**

Add a "Cost accounting and budgets" section to `README.md` (placed near the existing flag/feature documentation). Prose (one line per paragraph, no bold, per AGENTS.md):

```markdown
## Cost accounting and budgets

Every agent result can carry a cost record. The `costSource` field says how it was derived: `provider` means the backend reported a real USD figure (claude-sdk), `estimated` means Loop computed USD from token counts and the per-model `prices` you configured, and `unavailable` means token counts may be known but no USD figure was produced.

To get estimated costs from openai-sdk or codex-cli, add a `prices` map to the agent config keyed by model id, where each entry sets at least `inputPerMtok` and `outputPerMtok` (cache and reasoning rates default to multiples of those). claude-sdk reports cost directly and needs no `prices`.

Run totals persist in the loop-state file across resumes. Set a top-level `maxBudgetUsd`, or pass `--max-budget-usd N`, to cap lifetime spend: the loop stops after the prompt whose completion takes the total at or above the cap, and stops immediately at startup if the persisted total is already there. Results whose cost is `unavailable` record tokens but never advance the total. Omitting the cap is track-only mode.
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm test src/__test__/schema.test.ts`
Expected: PASS - the new example validates, the positive case passes, both negative cases are rejected.

- [ ] **Step 7: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, coverage 100%.

- [ ] **Step 8: Commit**

```bash
git add schema/loop-the-loop.schema.json src/__test__/schema.test.ts src/examples/cost-budget README.md
git commit -m "Feature: Document cost/budget config in schema, example, and README"
```

---

## Self-review checklist (run after all sections)

1. Spec coverage against `step-03-cost-accounting-budgets.md` "Done when":
   - Cost recorded on success/error/glitch when determinable - Sections 2, 3, 4.
   - `unavailable` records tokens without advancing total - Sections 3/4 (emit) + Section 6 test.
   - Budget stop after the crossing prompt - Section 6.
   - Resume stops immediately when already over budget - Section 6.
   - No built-in price table - Section 1 (helper has none).
2. Type consistency: `ModelPrice`/`TokenUsage` from `src/util/pricing.ts` are imported (not redefined) by all three agents; `CostInfo` comes from `src/types.ts` everywhere; `formatCost`/`formatCostBlock` names are distinct (loop vs yaml).
3. Final full gate: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format` clean with coverage at 100%.

## Out of scope (do not implement)

Per the step doc: non-USD currencies, token-budget caps, a `budgetAction` selector, built-in price tables, per-batch cost roll-ups, real-time cost streaming, and a `--doctor` pricing probe.
