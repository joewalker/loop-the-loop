# Plan: per-prompt cost accounting and run budgets

This plan supersedes `cost-accounting-1.md` and `cost-accounting-2.md`, which can be deleted once it lands.

## Context

The [roadmap](./roadmap.md) entry reads "Each prompt run tracks cost, estimate total budgets, etc." We want every prompt run through Loop to record what it cost, surface a running total, and (optionally) stop the loop when a user-supplied budget is exhausted.

Of the three first-party agents only the Claude Agent SDK reports a USD figure directly. `SDKResultSuccess` and `SDKResultError` in [@anthropic-ai/claude-agent-sdk/sdk.d.ts](../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) carry `total_cost_usd`, `usage` (with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), and a per-model `modelUsage: Record<string, ModelUsage>`. We surface that authoritative value as-is.

The OpenAI Agents SDK and Codex CLI both expose token usage but not USD. The OpenAI SDK's `RunResult.rawResponses: ModelResponse[]` carries a `Usage` per response. Codex's JSONL stdout already includes per-turn `token_count` events that we currently log and discard. For these two we sum the token counts ourselves and, only if the user has configured pricing for the resolved model, convert to USD. There are no built-in price defaults: stale defaults silently undercount and rot over time. When pricing is missing we still record the tokens with `costSource: 'unavailable'` so the operator can see where the cost is going.

A run total is persisted in `LoopState` so resumed runs keep accumulating. `maxBudgetUsd` is a lifetime cap across resumes; the loop stops gracefully after the prompt that pushes the total across the cap, matching how `maxPrompts` ends a run today. Cost is recorded on every result variant, including `glitch` and `error`, because failed turns still cost real money.

Design decisions:

- Use the Claude SDK's `total_cost_usd` verbatim; estimate cost for openai-sdk and codex-cli only when the user has configured pricing.
- A single tri-state `costSource: 'provider' | 'estimated' | 'unavailable'` distinguishes authoritative cost, computed estimate, and "we have tokens but no price."
- `cost` is optional on every `InvokeResult` variant. Agents that can't determine cost simply omit it.
- `maxBudgetUsd` persists across resumed runs.
- Track-only mode is `maxBudgetUsd` omitted.

## Design

### 1. Result shape - [src/types.ts](../../src/types.ts)

```ts
export interface CostInfo {
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  /** Model id the cost was computed against, when known. */
  readonly model?: string;
  /**
   * 'provider' = SDK reported a real USD figure (claude-sdk).
   * 'estimated' = computed from configured pricing and token counts.
   * 'unavailable' = tokens may be known but no USD figure was produced
   * (no pricing configured, or no usage reported).
   */
  readonly costSource: 'provider' | 'estimated' | 'unavailable';
}
```

Add `readonly cost?: CostInfo` to `SuccessfulInvocationResult`, `GlitchedInvocationResult`, and `ErrorInvocationResult`. When `costSource: 'unavailable'`, `usd` is 0. Consumers should branch on `costSource`, not on whether `usd > 0`.

### 2. Pricing helper - new `src/util/pricing.ts`

Pure data plus a single helper. No I/O, no env reads, no built-in price table.

```ts
export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  /** Defaults to inputPerMtok / 10 when omitted. */
  readonly cacheReadPerMtok?: number;
  /** Defaults to inputPerMtok * 1.25 when omitted. */
  readonly cacheCreationPerMtok?: number;
  /** Defaults to outputPerMtok when omitted. */
  readonly reasoningPerMtok?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
}

export function estimateCost(
  model: string,
  usage: TokenUsage,
  prices: Readonly<Record<string, ModelPrice>>,
): { usd: number; price: ModelPrice } | undefined;
```

`estimateCost` returns `undefined` when `prices[model]` is missing. The caller emits a `CostInfo` with `costSource: 'unavailable'`, `usd: 0`, and the raw token counts.

### 3. Claude SDK agent - [src/agents/claude-sdk.ts](../../src/agents/claude-sdk.ts)

Inside the `for await` loop, when handling `message.type === 'result'`:

- Read `total_cost_usd`, `usage`, and `modelUsage` off the result message via the existing `resultMsg` cast.
- Pick the model from `modelUsage` when exactly one key exists; otherwise leave undefined.
- Build `CostInfo` with `costSource: 'provider'`, `usd: total_cost_usd`, mapped token counts including reasoning tokens (read from `modelUsage[k]` aggregates).
- Export `extractClaudeCost(resultMsg)` for unit testing.
- Refactor the three `return` paths (`#successResult`, the `error_max_turns` / `error_max_budget_usd` early return, and the `classifyResultStatus` branch) to take the `CostInfo` so cost is attached to glitch and error returns too.
- The catch block has no result message; return with `cost` undefined.

File keeps its `// istanbul ignore file`; the extracted helper gets full coverage.

### 4. OpenAI SDK agent - [src/agents/openai-sdk.ts](../../src/agents/openai-sdk.ts)

- Extend `OpenAISDKAgentConfig` with `readonly prices?: Record<string, ModelPrice>`.
- After `await run(...)`, sum `result.rawResponses[i].usage.inputTokens` and `.outputTokens` across responses, plus `inputTokensDetails` / `outputTokensDetails` keys that map to cache and reasoning (the SDK exposes these on `Usage`).
- Resolve the model: `result.lastAgent?.model ?? this.#config.model ?? 'unknown'`.
- If `prices?.[model]` exists: attach `CostInfo` with `costSource: 'estimated'`, `usd` from `estimateCost`.
- If missing: attach `CostInfo` with `costSource: 'unavailable'`, `usd: 0`, raw token counts, and log one `logger.system` line: `No pricing configured for model '${model}'; recording tokens only`.
- Catch block: no usage; omit `cost`.

Export `extractOpenAIUsage(result)` and `resolveOpenAIModel(result, config)` for unit testing.

### 5. Codex CLI agent - [src/agents/codex-cli.ts](../../src/agents/codex-cli.ts)

Codex emits `token_count` JSON events on stdout, already routed through `logCodexJsonLine`. Add a small `TokenAccumulator` co-located with `LineBuffer`:

- Recognise events where `event.type === 'token_count'` or `event.msg?.type === 'token_count'` (Codex has shipped both shapes).
- Pull `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `reasoning_tokens` via the existing `getNestedValue` / `firstDefined` helpers.
- Codex reports cumulative running totals per turn, not deltas; the accumulator keeps the latest value seen.

Extend `CodexCLIAgentConfig` with `readonly model?: string` and `readonly prices?: Record<string, ModelPrice>`. Resolve model = `config.model ?? process.env['CODEX_MODEL'] ?? 'unknown'`. After `runCodex` returns:

- If accumulator has no data: omit `cost`.
- If accumulator has data and pricing exists: attach `costSource: 'estimated'`.
- If accumulator has data but pricing is missing: attach `costSource: 'unavailable'` with `usd: 0` and the token counts. Log one warning.
- Timeout path returns the partial accumulator.

### 6. Reporters

JSONL ([src/reporters/jsonl.ts](../../src/reporters/jsonl.ts)) already spreads `result`; `cost` appears automatically. Add a coverage test pinning the field shape.

YAML ([src/reporters/yaml.ts](../../src/reporters/yaml.ts)) needs a new block after the status line and before `output` / `reason`:

```yaml
---
id: "a.ts"
status: success
cost:
  costSource: estimated
  usd: 0.01234
  model: gpt-5-mini
  inputTokens: 1200
  outputTokens: 380
  cacheReadTokens: 0
  reasoningTokens: 0
output: |2
  Done
```

Numeric scalars unquoted; `model` and `costSource` through `JSON.stringify` for the same reasons `id` is. Undefined fields omitted.

### 7. LoopState - [src/util/loop-state.ts](../../src/util/loop-state.ts)

Restructure persistence so the per-prompt outcome (status, optional error reason, optional cost) is keyed by id in a single record. Replaces the parallel `completed: string[]` + `failed: FailedState[]` shape.

```ts
interface PromptOutcome {
  readonly status: 'success' | 'error';
  readonly reason?: string;        // present when status === 'error'
  readonly cost?: CostInfo;        // cost of the final attempt, if known
}

interface PersistedLoopState {
  readonly results?: Record<string, PromptOutcome>;
  readonly inProgress?: string;
  readonly totalUsd?: number;      // cached running total; includes glitch retry costs
}
```

Why not full `InvokeResult` per id: `output` / `structuredOutput` can be multi-KB, the file is rewritten on every `begin()` and `end()` (twice per prompt), and the reporter already persists the full result. Slim outcomes keep the state file as a fast index.

Why a separate cached `totalUsd`: glitches don't go into `results` (they retry, `isOutstanding` must keep returning true), but glitch attempts still cost real money. `totalUsd` is incremented for every `end()` whose result has a cost with `costSource !== 'unavailable'`, including glitches.

Implementation:

- Private fields: `#results: Map<string, PromptOutcome>`, `#inProgress?: string`, `#totalUsd: number`.
- `create()`: parse new shape; if `results` is absent but `completed` / `failed` are present (old format), migrate inline by building `results` from them with `cost` undefined. Old state files resume cleanly.
- `isOutstanding(id)`: returns `!#results.has(id)`. Glitches don't get stored, so they remain outstanding by construction.
- `begin(id)`: unchanged contract; sets `#inProgress`, saves.
- `end(id, result)`:
  - If `result.status === 'success'` or `'error'`: set `#results.set(id, { status, reason: result.status === 'error' ? result.reason : undefined, cost: result.cost })`.
  - If `result.status === 'glitch'`: don't touch `#results` (id stays outstanding for retry).
  - In all three cases: if `result.cost?.costSource === 'provider'` or `'estimated'`, add `result.cost.usd` to `#totalUsd`.
  - Clear `#inProgress`, save.
- Public getters for callers that still want the lists:
  - `get completed(): ReadonlyArray<string>` - ids with `status === 'success'`.
  - `get failed(): ReadonlyArray<{ id: string; reason: string }>` - entries with `status === 'error'`.
  - `get totalUsd(): number`.
  - `get outcomes(): ReadonlyMap<string, PromptOutcome>` for the budget check / future reporting.
- `save()` writes `{ results, inProgress, totalUsd }`. Negative or non-finite `totalUsd` is clamped to no-op on the increment, never written.

### 8. Loop runtime - [src/loop.ts](../../src/loop.ts)

`loopState.end(id, result)` now handles the cost accounting internally (sets the outcome and accumulates `totalUsd`). The loop just needs the verbose log and the budget check.

After `await reporter.append(prompt, result)` and after `await loopState.end(id, result)`:

```ts
if (result.cost !== undefined) {
  const tag =
    result.cost.costSource === 'provider'
      ? ''
      : result.cost.costSource === 'estimated'
        ? ' (est)'
        : ' (no price)';
  logger.state(
    `Cost: ${result.cost.usd.toFixed(4)} USD${tag}, ` +
    `total: ${loopState.totalUsd.toFixed(4)} USD`,
  );
}
```

`maxBudgetUsd` handling alongside `maxPrompts`:

- `LoopCliConfig`: `readonly maxBudgetUsd?: number;`.
- `LoopConfig`: `readonly maxBudgetUsd: number;` defaulting to `Infinity`.
- After the `completed >= maxPrompts` check, a budget check using the same return-string contract:

```ts
if (loopState.totalUsd >= maxBudgetUsd) {
  const msg = `Reached budget of ${maxBudgetUsd} USD (total ${loopState.totalUsd.toFixed(4)} USD)`;
  logger.state(msg);
  return `Done (${msg.toLowerCase()})`;
}
```

Check after `reporter.append` and `loopState.end` so the prompt that pushes us over is fully recorded, then stop before pulling the next one. When [concurrency.md](./concurrency.md) lands, the budget check becomes "stop on first completion that crosses the cap" with in-flight prompts allowed to drain. Same shape `runPool` will need for `maxPrompts`.

### 9. CLI plumbing - [src/util/load-cli-config.ts](../../src/util/load-cli-config.ts)

- `ParsedArgs`: add `readonly maxBudgetUsd?: number | undefined`.
- `VALUE_FLAGS`: add `['maxbudgetusd', 'maxBudgetUsd']`; broaden the map value type.
- Parser accepts any positive number (integer or decimal). Rejects `0`, negatives, `NaN` with `Invalid --${rawKey} value: ${value}`.
- `loadCliConfig` propagates the value into the returned config when set.
- `USAGE` extends to `[--max-budget-usd N]`.

### 10. CLI entry - [src/cli.ts](../../src/cli.ts)

Update the JSDoc usage block to include `[--max-budget-usd N]`. No other changes.

### 11. JSON schema - [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json)

Top-level `maxBudgetUsd`:

```json
"maxBudgetUsd": {
  "type": "number",
  "exclusiveMinimum": 0,
  "description": "Stop after the running cost total crosses this many USD. Persists across resumed runs."
}
```

Extend `openaiSdkAgentConfig` and `codexCliAgentConfig` with a shared `prices` definition:

```json
"prices": {
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "required": ["inputPerMtok", "outputPerMtok"],
    "additionalProperties": false,
    "properties": {
      "inputPerMtok": { "type": "number", "minimum": 0 },
      "outputPerMtok": { "type": "number", "minimum": 0 },
      "cacheReadPerMtok": { "type": "number", "minimum": 0 },
      "cacheCreationPerMtok": { "type": "number", "minimum": 0 },
      "reasoningPerMtok": { "type": "number", "minimum": 0 }
    }
  },
  "description": "Per-model price overrides keyed by model id. Required for cost estimation; no built-in defaults are shipped."
}
```

Also add `"model": { "type": "string" }` to `codexCliAgentConfig`.

### 12. Interface docs

- `InvokeResult` JSDoc in [src/types.ts](../../src/types.ts): one sentence noting that `cost` is optional and `costSource: 'unavailable'` means tokens may be present but no USD figure was produced.
- `Reporter` interface in [src/reporters.ts](../../src/reporters.ts): one line noting that when present the reporter should persist `result.cost`.

## Tests

New files:

- `src/util/__test__/pricing.test.ts`: `estimateCost` returns `undefined` for missing model, computes correctly with defaults applied for missing cache/reasoning rates, sums all token classes correctly, zero usage stays zero.

Existing files, additions:

- `src/util/__test__/loop-state.test.ts`:
  - `end()` with success stores the outcome under `results[id]`; `completed` getter returns it.
  - `end()` with error stores `{ status: 'error', reason }`; `failed` getter returns `{ id, reason }`.
  - `end()` with glitch leaves `results` untouched; `isOutstanding(id)` stays true.
  - `end()` with any status whose cost has `costSource === 'provider'` or `'estimated'` adds to `totalUsd`; `'unavailable'` does not.
  - Glitch attempts contribute to `totalUsd` even though they don't appear in `results`.
  - Non-finite or negative cost values are clamped to no-op on the increment.
  - Old-format state file (`completed: string[]` + `failed: FailedState[]`, no `results`) migrates on load: `results` populated with `cost: undefined`, `totalUsd: 0`.
  - New-format round-trip: save then reload preserves `results`, `totalUsd`, `inProgress`.
- `src/agents/__test__/claude-sdk.test.ts`: `extractClaudeCost` covering success result, error result with cost, `error_max_budget_usd` subtype carrying cost, missing-cost result. `CostInfo` attached on glitch (e.g. `terminal_reason=blocking_limit`) and error returns.
- `src/agents/__test__/openai-sdk.test.ts`: `extractOpenAIUsage` summing across multiple `rawResponses`; `resolveOpenAIModel` precedence; missing-pricing emits the logger line and produces `costSource: 'unavailable'`; pricing hit produces `costSource: 'estimated'`.
- `src/agents/__test__/codex-cli.test.ts`: synthetic JSONL with `token_count` events feeds the accumulator; both event shapes recognised; cumulative totals semantics; no events yields no `cost`.
- `src/reporters/__test__/yaml.test.ts`: result with each `costSource` value emits the expected block; absent `cost` yields no block.
- `src/reporters/__test__/jsonl.test.ts`: result with cost has the field serialised; absent cost omits it.
- `src/__test__/loop.test.ts`:
  - Each completed prompt's outcome (status + cost) lands in the persisted `results` record.
  - `maxBudgetUsd: 1.0` with a `TestAgent` returning `{ status: 'success', output: 'x', cost: { usd: 0.6, costSource: 'estimated' } }` for three prompts: completes prompt 1 (total 0.6), completes prompt 2 (total 1.2, at or above 1.0), stops with the expected return string. Prompt 3 not invoked.
  - The state file after stop has `totalUsd: 1.2`, `results` has two entries with their `cost` blocks, and the report file contains exactly two entries.
  - Resume: starting again with the same state file picks up at `totalUsd: 1.2` and stops immediately.
  - `costSource: 'unavailable'` results land in `results` but do not advance `totalUsd`.
  - Glitch plus retry: a `TestAgent` that returns one glitch (with cost) then a success (with cost) for the same id leaves `results[id].status === 'success'` and `totalUsd` reflecting both attempts.
  - `maxBudgetUsd` omitted: cost is recorded but no early stop occurs.
- `src/util/__test__/load-cli-config.test.ts`: `--max-budget-usd 1.5` parses; `0`, `-1`, `abc` rejected with the expected error.
- `src/util/__test__/schema.test.ts`: `maxBudgetUsd: 2.5` validates; `0` and negatives fail; `openai-sdk` config with `prices` validates; `prices` entry missing `inputPerMtok` fails.

Tests to update:

- `src/__test__/loop.test.ts`: any snapshots or full-content assertions over YAML or JSONL entries get the optional `cost` block treated as present-or-absent.
- `src/util/__test__/loop-state.test.ts`: state-shape assertions accept the new `results` and `totalUsd` fields, and add a migration test from the old format.

## Out of scope

- Built-in price tables. Users supply pricing explicitly or accept `costSource: 'unavailable'`.
- Per-batch / per-summary cost roll-ups in the batch generator.
- Real-time cost streaming. SDKs only report final usage today.
- Currencies other than USD.
- Token-budget caps (separate from USD).
- A `budgetAction: 'warn' | 'stop'` selector. Omitting the cap is the warn-only mode.
- True hard-cap mid-prompt cancellation. We rely on the Claude SDK's `error_max_budget_usd` (already classified as a glitch) for that.

## Files to modify

- [src/types.ts](../../src/types.ts) - `CostInfo`, `cost?` on result variants, `maxBudgetUsd` on `LoopCliConfig` / `LoopConfig`.
- [src/util/pricing.ts](../../src/util/pricing.ts) - new; pure data plus `estimateCost`.
- [src/util/loop-state.ts](../../src/util/loop-state.ts) - new `results` record, `totalUsd`, derived `completed` / `failed` getters, old-format migration.
- [src/agents/claude-sdk.ts](../../src/agents/claude-sdk.ts) - capture provider cost; thread through all return paths.
- [src/agents/openai-sdk.ts](../../src/agents/openai-sdk.ts) - `prices` config, token sum, model resolution, estimation.
- [src/agents/codex-cli.ts](../../src/agents/codex-cli.ts) - `prices` config, model config, `TokenAccumulator`, estimation.
- [src/agents/test.ts](../../src/agents/test.ts) - no runtime change; canned responses can include `cost`.
- [src/loop.ts](../../src/loop.ts) - budget check, verbose cost log.
- [src/reporters/jsonl.ts](../../src/reporters/jsonl.ts) - coverage only.
- [src/reporters/yaml.ts](../../src/reporters/yaml.ts) - `cost` block serialisation.
- [src/reporters.ts](../../src/reporters.ts) - interface doc note.
- [src/util/load-cli-config.ts](../../src/util/load-cli-config.ts) - `--max-budget-usd` parsing.
- [src/cli.ts](../../src/cli.ts) - usage docs.
- [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json) - `maxBudgetUsd`, `prices`, `model` on codex config.
- [README.md](../../README.md) - short section: provider-reported claude cost, configured openai/codex estimation, caveat that estimates depend on user prices.

Files to delete once this plan lands:

- [docs/future-plans/cost-accounting-1.md](./cost-accounting-1.md)
- [docs/future-plans/cost-accounting-2.md](./cost-accounting-2.md)

## Verification

1. `pnpm tsc && pnpm test` - all tests pass.
2. `pnpm lint` - clean.
3. `pnpm format` - no diff.
4. Manual smoke against a `test-config.json` with the `test` agent, the `json` prompt generator, three prompts, canned `cost`:
   - `--max-budget-usd 1.0` with canned `{ usd: 0.6, costSource: 'estimated' }`: stops after prompt 2 (total 1.2). State file shows `totalUsd: 1.2`, report has two entries.
   - Re-run resumes and stops immediately.
   - Omit `--max-budget-usd`: cost logged and persisted; loop runs to completion.
5. Manual smoke against a real `claude-sdk` config, single prompt: `cost.usd` matches the SDK's `total_cost_usd`; `costSource: 'provider'`.
6. Manual smoke against a real `openai-sdk` config:
   - With `prices` configured for the model: `costSource: 'estimated'`, token counts match `Usage`, `usd` matches a hand calculation.
   - Without `prices`: `costSource: 'unavailable'`, `usd: 0`, tokens still recorded, one warning line in stderr.
7. Manual smoke against a real `codex-cli` config: tokens flow through from JSONL `token_count` events; both event shapes recognised when fed synthetically.

## Risks

- Provider usage shapes shift. The type allows missing usage and missing cost without treating that as failure.
- Without built-in prices, OpenAI and Codex users see `costSource: 'unavailable'` until they configure pricing. The warning log and the recorded token counts make this discoverable rather than silent.
- Codex CLI JSON event shapes are not part of this repo. The parser is tolerant and acts only on fields it can confidently recognise.
- Concurrency and remote loop state plans may later want a shared persisted total. Persisting via `LoopState` keeps this consistent with the existing pluggable-state direction in [remote-loop-state.md](./remote-loop-state.md).
