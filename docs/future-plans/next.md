# Carry-over context for Step 03 (cost accounting and budgets)

Steps 01 and 02 are complete and merged on `main`. This records what Step 03 needs to know from them. Step 02's own internals (the doctor orchestrator, output format, git preflight) are documented in `step-02-doctor.md` and the source; only the parts that touch Step 03's files are repeated here.

## Cost plumbing already exists (Step 01)

Step 03 should not rebuild persistence or the result type; both shipped in Step 01.

- `CostInfo` is already baseline on the success / glitch / error result variants in `src/types.ts`. Step 03 populates it; it does not define it. The tri-state `costSource` (`'provider' | 'estimated' | 'unavailable'`) is the field consumers branch on.
- `FileLoopState.complete()` (`src/loop-states/file.ts`) already stores `cost` on the outcome, and its `#addCost` accumulates `totalUsd` in the v2 snapshot (`{ version: 2, results, claims, totalUsd }`) with the agreed rules: `'provider'` and `'estimated'` advance `totalUsd` (including glitches), `'unavailable'` records tokens but does not advance it, and negative / non-finite costs are clamped to a no-op. Tests cover these. Step 03's remaining work is the agent-side cost extraction, the YAML reporter cost block, the JSONL coverage test, and the budget enforcement, not the state plumbing.
- `loop()` / `loopImpl()` return a structured `LoopRunResult` (`{ status, reason?, message? }`) from `src/types.ts`. The reason `'maxBudgetUsd'` is already declared in the union but is not produced yet; Step 03 adds the branch that emits it (stop after the crossing prompt is reported and completed, and an immediate stop at startup when persisted `totalUsd >= maxBudgetUsd`).
- The state file is `${outputDir}/${jobName}-loop-state.json`; read totals via `getSnapshot()`. The loader is strict (missing file -> fresh store; non-v2 or malformed -> throws).

## Files Step 03 edits that Step 02 also touched

- `src/reporters/yaml.ts` and `src/reporters/jsonl.ts` now each implement an optional `check()` method (the doctor probe) in addition to `append()`. Step 03 adds the YAML `cost` block and a JSONL cost coverage test; leave the existing `check()` methods intact and keep both reporters at 100% coverage.
- `src/util/load-cli-config.ts` gained the `--doctor` boolean flag and the `effectiveDryRun = dryRun && !doctor` logic, and `ParsedArgs` gained `doctor?: boolean`. Add `--max-budget-usd` as a `VALUE_FLAGS` entry alongside `maxPrompts` (with the `0` / negative / `NaN` rejection), without disturbing the `--doctor` / dry-run handling. Extend `USAGE` for the new flag.
- `src/cli.ts` dispatches to `doctor()` after config load and before `loop()`, and is untested by design (no test imports it). Keep it a thin pass-through: add the `--max-budget-usd` mention to usage and let the budget logic live in `src/loop.ts` and the agents, which are coverage-measured.

## Optional, deferred

Step 02 added an optional `check?(): AsyncIterable<CheckResult>` capability to the `Agent`, `PromptGenerator`, and `Reporter` interfaces (the doctor calls it). A "pricing configured for the resolved model" doctor probe would slot in naturally once Step 03 adds per-model `prices`, but Step 03's doc lists it as out of scope. Mentioned here only so the opportunity is not forgotten.
