# Step 03: Cost accounting and budgets

## Goal

Record cost and token metadata for every prompt result when available, persist run totals across resumes, and optionally stop a run after it crosses a configured USD budget.

## Work

- Add a pure pricing helper for configured per-model prices. Prices are configured per agent, as a `prices` map keyed by model id on the openai-sdk and codex-cli agent configs; claude-sdk reports provider cost directly and needs none.
- Extract provider cost from Claude SDK results.
- Extract token usage from OpenAI SDK results and estimate USD only when the user has configured pricing for the resolved model.
- Extract token usage from Codex CLI JSONL events and estimate USD only when pricing is configured.
- Persist per-result cost in full reporter output. The loop-state side (per-result `cost` on outcomes plus `totalUsd` accumulation with clamping) already shipped in Step 01; this step only feeds it real agent costs.
- Add YAML reporter cost serialization.
- Add `maxBudgetUsd` to runtime config, CLI parsing, and schema.
- Use `LoopRunResult` for budget stops instead of return-string text.

## Cost model

`CostInfo` is already baseline on the result variants in `src/types.ts`; this step populates it. The tri-state `costSource` is the key field: consumers branch on it, not on whether `usd > 0`.

```ts
export interface CostInfo {
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly model?: string;
  // 'provider'    = SDK reported a real USD figure (claude-sdk).
  // 'estimated'   = computed from configured pricing and token counts.
  // 'unavailable' = tokens may be known but no USD figure was produced.
  readonly costSource: 'provider' | 'estimated' | 'unavailable';
}
```

When `costSource` is `'unavailable'`, `usd` is 0 and the token counts are still recorded. `cost` is optional on success, glitch, and error results; an agent that cannot determine cost omits it.

## Pricing helper

New `src/util/pricing.ts`: pure data plus one helper, with no I/O, no env reads, and no built-in price table (stale defaults silently undercount and rot).

```ts
export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  readonly cacheReadPerMtok?: number;       // defaults to inputPerMtok / 10
  readonly cacheCreationPerMtok?: number;   // defaults to inputPerMtok * 1.25
  readonly reasoningPerMtok?: number;       // defaults to outputPerMtok
}

export function estimateCost(
  model: string,
  usage: TokenUsage,
  prices: Readonly<Record<string, ModelPrice>>,
): { usd: number; price: ModelPrice } | undefined;
```

`estimateCost` returns `undefined` when `prices[model]` is missing; the caller then emits `costSource: 'unavailable'` with the raw token counts.

## Per-agent extraction

- claude-sdk: read `total_cost_usd`, `usage`, and `modelUsage` off the result message; `costSource: 'provider'`; pick the model when `modelUsage` has exactly one key; attach cost on the success, glitch (for example `error_max_budget_usd`), and error return paths; the catch path omits cost. Export `extractClaudeCost` for unit tests; the file keeps its `istanbul ignore`, but the extracted helper gets full coverage.
- openai-sdk: add `prices?` to the config; sum `rawResponses[i].usage` input/output plus the cache and reasoning detail keys; resolve model as `lastAgent?.model ?? config.model ?? 'unknown'`; `estimated` when priced, `unavailable` plus one `logger.system` warning otherwise. Export `extractOpenAIUsage` and `resolveOpenAIModel`.
- codex-cli: add `model?` and `prices?` to the config; a `TokenAccumulator` co-located with `LineBuffer` recognises `token_count` events in both shapes Codex has shipped (`event.type` and `event.msg.type`) and keeps the latest cumulative totals, not deltas; resolve model as `config.model ?? CODEX_MODEL ?? 'unknown'`; `estimated` when priced, `unavailable` plus one warning otherwise; the timeout path returns the partial accumulator.

## Persistence and totals

This persistence is already built. Step 01's `FileLoopState.complete()` stores `cost` on the outcome and its `#addCost` accumulates `totalUsd`, with tests covering the rules below, so the only new work here is making the agents populate `CostInfo`; the loop-state behaviour is described so this step can rely on it. Cost lands in the v2 loop-state outcomes (Step 01) and in full reporter output. `totalUsd` accumulates on every `complete()` whose `cost.costSource` is `'provider'` or `'estimated'`, including glitches, which still cost real money even though they stay outstanding for retry. `'unavailable'` records tokens but does not advance `totalUsd`. Negative or non-finite cost is clamped to a no-op increment, never written.

## Reporters

JSONL spreads `result`, so `cost` appears automatically (add a coverage test). YAML gains a `cost` block after the status line and before `output` / `reason`:

```yaml
cost:
  costSource: estimated
  usd: 0.01234
  model: gpt-5-mini
  inputTokens: 1200
  outputTokens: 380
```

Numeric scalars are unquoted; `model` and `costSource` go through `JSON.stringify`; undefined fields are omitted.

## Budgets

`maxBudgetUsd` is a lifetime cap across resumes. At startup the loop reads `getSnapshot()` and stops immediately if persisted `totalUsd >= maxBudgetUsd`. After a result is fully reported and completed in state, if `totalUsd >= maxBudgetUsd` the loop stops with `LoopRunResult` reason `maxBudgetUsd`, so the prompt that crossed the cap is recorded before stopping. Omitting `maxBudgetUsd` is track-only mode. Under Step 04 this becomes "stop on the first completion that crosses the cap", with in-flight prompts allowed to drain.

## CLI and schema

`--max-budget-usd N` accepts any positive number (integer or decimal) and rejects `0`, negatives, and `NaN` with `Invalid --max-budget-usd value: ${value}`. Schema: a top-level `maxBudgetUsd` (`number`, `exclusiveMinimum: 0`); a shared `prices` object on `openaiSdkAgentConfig` and `codexCliAgentConfig` (per-model entries require `inputPerMtok` and `outputPerMtok`, with optional `cacheReadPerMtok`, `cacheCreationPerMtok`, `reasoningPerMtok`, all `minimum: 0`); and `model` (`string`) on `codexCliAgentConfig`.

## Dependencies

- Step 01, for strict state shape and structured loop results.

## Done when

- Cost is recorded on success, error, and glitch results when the agent can determine it.
- `costSource: 'unavailable'` records token data without advancing `totalUsd`.
- Budget stops happen after the result that crosses the cap has been fully reported and completed in state.
- Resume stops immediately if persisted `totalUsd` is already at or above the configured budget.
- No built-in price table is shipped.

## Out of scope

- Currencies other than USD. Cost is tracked and capped in USD only.
- Token-budget caps separate from the USD cap.
- A `budgetAction: warn | stop` selector. Omitting `maxBudgetUsd` is the warn-only (track-only) mode.
- Built-in price tables. Users supply per-model pricing explicitly or accept `costSource: 'unavailable'`.
- Per-batch / per-summary cost roll-ups in the batch generator, and real-time cost streaming (SDKs report final usage only).

## Tests

- `src/util/__test__/pricing.test.ts`: missing model returns `undefined`; default cache/reasoning rates applied; all token classes summed; zero usage stays zero.
- Agent tests: `extractClaudeCost` over success, error, `error_max_budget_usd`, and missing-cost results; `extractOpenAIUsage` summing across `rawResponses` with `resolveOpenAIModel` precedence and the missing-pricing warning; Codex `TokenAccumulator` over both event shapes with cumulative semantics.
- Reporter tests: each `costSource` emits the expected YAML block; absent cost omits it; JSONL serialises and omits correctly.
- Loop tests: outcomes carry cost; a `maxBudgetUsd` run stops after the crossing prompt with the expected `LoopRunResult`; resume stops immediately; `unavailable` does not advance the total; a glitch-then-success leaves the id `success` with the total reflecting both attempts.
- CLI and schema: `--max-budget-usd` parsing including the `0` / negative / `NaN` rejections; `maxBudgetUsd` and `prices` schema validation, including `prices` missing `inputPerMtok` failing.

## Files

- `src/types.ts` (`maxBudgetUsd` on `LoopCliConfig` / `LoopConfig`), `src/util/pricing.ts` (new), the three agents, `src/loop.ts` (budget check and verbose cost log), `src/reporters/yaml.ts` (cost block), `src/reporters/jsonl.ts` (coverage), the reporter interface doc note, `src/util/load-cli-config.ts` (`--max-budget-usd`), `src/cli.ts` (usage), `schema/loop-the-loop.schema.json`, and a short README section on provider-reported vs configured-estimate cost.
