# Carry-over context for Step 04 (in-process concurrency)

Steps 01, 02, and 03 are complete and merged on `main`. This records what Step 04 needs to know from Step 03's cost accounting and budget work. The Step 03 design lives in `step-03-cost-accounting-budgets.md` and the as-built task breakdown in `step-03-cost-accounting-budgets-plans.md`; only the parts that touch Step 04 are repeated here.

## Budget enforcement is sequential today and must become completion-order

Step 04's "Done when" lists `maxBudgetUsd` as a completion-order stop condition with in-flight prompts draining. As built in Step 03, the budget logic lives inline in `loopImpl` in `src/loop.ts` in two places:

- A startup stop, immediately after the loop state is loaded: it reads `(await loopState.getSnapshot()).totalUsd` and returns `{ status: 'stopped', reason: 'maxBudgetUsd', message }` when the persisted total is already `>= maxBudgetUsd`. This runs once before any worker pulls, so under concurrency it stays where it is.
- A post-completion stop inside the sequential `for await` body, placed after the success/glitch/error if-else block (the error branch returns first, so the budget check only runs for success and glitch) and before `completed++`. It logs the cost line when `result.cost` is present, then re-reads `getSnapshot().totalUsd` and stops with reason `maxBudgetUsd` when at or over the cap.

When Step 04 converts the loop body into the `runPool` work callback, the cost log and this post-completion budget check move into that callback. Crossing the cap should make `work` return `'stop'` (set the shared `stop`, drain in-flight, then surface the `maxBudgetUsd` `LoopRunResult`), rather than returning directly from a sequential loop. The budget check currently sits before the `maxPrompts` check, so on a prompt that crosses both, budget wins; preserve whatever ordering you choose with a comment.

## Cost totals are already concurrency-safe

`FileLoopState.complete()` / `#addCost` (Step 01) accumulate `totalUsd` and persist through the internal `#saveChain`, which serializes concurrent `save()` calls. `getSnapshot().totalUsd` reflects every completion recorded so far, so reading it from concurrent workers is safe. The accumulation rules (unchanged): `costSource` of `provider` or `estimated` advances the total, including glitches; `unavailable` records tokens but does not advance it; negative / non-finite is clamped to a no-op. Step 04 does not need to touch `src/loop-states/file.ts`.

## Per-agent cost is now populated

Each agent attaches `CostInfo` when it can: claude-sdk reports a real provider USD figure (`costSource: 'provider'`); openai-sdk and codex-cli estimate USD from token counts when the user configured `prices` for the resolved model (`'estimated'`), otherwise record tokens only (`'unavailable'`, one `logger.system` warning). The pure helper is `estimateCost` in `src/util/pricing.ts` (exports `ModelPrice` and `TokenUsage` too). The three real agent files keep `// istanbul ignore file`, so their extraction helpers are unit-tested for correctness but do not count toward the coverage gate.

## CLI / schema / loop config shape Step 04 extends

Step 04 adds `--concurrency` and a top-level `concurrency`; Step 03 left these touch-points in a known state:

- `src/util/load-cli-config.ts`: `VALUE_FLAGS` is now a two-entry `ReadonlyMap<string, 'maxPrompts' | 'maxBudgetUsd'>`, and the value-flag dispatch is a real `if (valueField === 'maxPrompts') { ... } else { ... }` (the old `istanbul ignore else` is gone). Add `--concurrency` as a third `VALUE_FLAGS` entry and a third branch (or refactor the per-flag validation), keeping each branch covered by tests since this file is coverage-measured at 100%. `maxBudgetUsd` accepts decimals (`/^\d+(?:\.\d+)?$/u`, rejects `0`/negatives/non-numerics); `--concurrency` should parse like `--max-prompts` (integer, rejecting `< 1`).
- `ParsedArgs` carries `maxBudgetUsd?` and `loadCliConfig` merges it (tested, no istanbul-ignore); follow the same merge pattern for `concurrency`. `USAGE` already lists `[--max-budget-usd N]`; add `[--concurrency N]`.
- `src/cli.ts` (untested by design) lists the flags in its help text; add `--concurrency` there too.
- `src/types.ts`: `LoopCliConfig` has optional `maxBudgetUsd?: number`. `loop()` maps it to `LoopConfig.maxBudgetUsd` with a default of `Infinity`, and `loopImpl` destructures it. Add `concurrency` to both `LoopCliConfig` and `LoopConfig` (default `1` in `loop()`) the same way.
- `schema/loop-the-loop.schema.json`: top-level `maxBudgetUsd` (`number`, `exclusiveMinimum: 0`) sits next to `maxPrompts`; add `concurrency` (`integer`, `minimum: 1`, `default: 1`) alongside it. A shared `modelPrice` definition and `prices` properties now exist on `openaiSdkAgentConfig` and `codexCliAgentConfig`, plus `model` on `codexCliAgentConfig`; leave those intact.

## Verbose cost log and stop messages

`loopImpl` has a top-level `formatCost(cost: CostInfo)` helper that renders the one-line `Cost: ...` log (both the priced and `unavailable` branches). When the loop body moves into the work callback, keep calling it on each completion. The startup and post-completion budget stops emit human-readable messages containing `Budget already reached:` and `Budget reached after <id>:`; tests assert on `reason: 'maxBudgetUsd'` and a `Budget`-containing message, not exact wording.

## Example and reporter notes

- `src/examples/cost-budget/` is the example exercising `prices` + `maxBudgetUsd`; the schema test validates every example automatically, so a Step 04 example that adds `concurrency` must validate against the updated schema.
- The YAML reporter emits a `cost:` block (after `status:`, before `output`/`reason`); the JSONL reporter serialises cost via its existing `result` spread. Step 04's reporter serialization wrapper must preserve these outputs unchanged at `concurrency === 1`.
