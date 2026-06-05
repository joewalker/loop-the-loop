# Carry-over context from Step 02 into Step 03

This records the state of the runtime after Step 02 (`--doctor`) landed, so the Step 03 cost-accounting work builds on what actually shipped. Steps 01 and 02 are merged on `main`. The Step 01 carry-over that still matters for Step 03 is summarised at the end.

## What Step 02 actually shipped

A new preflight command, `--doctor`, validates the configured components and environment without ever running the loop. It exits 0 when every check passes and 1 when any check fails. `--dry-run` is ignored when `--doctor` is set.

The orchestrator and result type live in `src/doctor.ts`:

```ts
export interface CheckResult {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly message?: string;
  readonly cause?: unknown;
}

export async function doctor(
  config: LoopCliConfig,
  logger: Logger,
  write?: (line: string) => void,
): Promise<boolean>;
```

`doctor()` returns `false` iff any check reported `fail`. It streams each result as a formatted line via the injected `write` (default writes to `process.stdout`; tests inject a collector). The line format is `[<status>] <component-kind> (<component-name>): <check-name>[ - <message>]` with the status tag padded to width 6, followed by a `Summary: N ok, N warn, N fail, N skip` line. When the logger is enabled (`--verbose`), the underlying `cause` of any result is logged via `logger.error`.

`cli.ts` dispatches to `doctor()` after config load and before `loop()`, mapping the boolean to `process.exitCode`. `cli.ts` remains untested by design (no test imports it), so the dispatch is a thin pass-through and all real logic lives in `src/doctor.ts`, which is at 100% coverage.

## The optional `check()` capability

`Agent`, `PromptGenerator`, and `Reporter` each gained an optional member:

```ts
check?(): AsyncIterable<CheckResult>;
```

It is optional so external and test implementations stay valid. The interface files (`src/agents.ts`, `src/prompt-generators.ts`, `src/reporters.ts`) import `CheckResult` type-only from `./doctor.js`; `doctor.ts` imports the factories at runtime, so there is no runtime cycle. The orchestrator yields a single `skip` ("no diagnostics defined") for any component without a `check()`, a synthetic `fail` when a probe throws mid-iteration, and a synthetic `fail` (without aborting the rest of the run) when a component fails to construct.

Built-in `check()` implementations now exist for every agent (`claude-sdk`, `openai-sdk`, `codex-cli`, `test`), every prompt generator (`batch` delegates to its child source, `bugzilla`, `github`, `gitlab`, `json`, `per-file`, `test`), and both reporters (`yaml`, `jsonl`). The real external probes (claude query, openai models list, codex `--version`, github/gitlab `GET /user`, bugzilla whoami) are exercised by `*-live.test.ts` files gated on env tokens; local unit tests mock the SDK / `fetch` / `spawn`.

Note for Step 03: when cost accounting adds new agent or reporter behaviour, consider whether each component's `check()` should grow a corresponding probe (the doctor is the natural place to surface a misconfigured budget or missing pricing data early).

## The shared git preflight

The loop's inline clean-tree check was extracted into `src/git-preflight.ts`:

```ts
export interface GitPreflightItem {
  readonly name: string;       // 'inside work tree' | 'clean working tree' | 'committer identity'
  readonly ok: boolean;
  readonly message?: string;
}
export function gitPreflight(git: Git): Promise<ReadonlyArray<GitPreflightItem>>;
```

`gitPreflight` probes, in order: inside a work tree (short-circuits the rest when false), clean working tree (its failure message is byte-for-byte the loop's previous error), and committer identity (`user.name` / `user.email`). `loopImpl` now calls `gitPreflight` and throws the first failing item's message; the doctor's `environment` checks reuse it (only when `allowSourceUpdate === true`). `Git` (`src/util/git.ts`) gained `isInsideWorkTree()` and `configValue(key)` to support this. Because the loop now also requires a committer identity under `allowSourceUpdate`, the loop tests set a local `user.name` / `user.email` in their temp repo.

## CLI surface as it now stands

`ParsedArgs` (`src/util/load-cli-config.ts`) has `doctor?: boolean`; `--doctor` is in `BOOLEAN_FLAGS`; `USAGE` lists it. `loadCliConfig` computes `effectiveDryRun = dryRun && !doctor` and uses it for both the dry-run agent swap and the forced-verbose behaviour, so `--doctor` suppresses `--dry-run`. `--doctor` adds no JSON config key, so `schema/loop-the-loop.schema.json` and `src/examples/` are unchanged. The README documents `--doctor`.

## Step 01 context that still carries into Step 03

`loop()` and `loopImpl()` return a structured `LoopRunResult` (`{ status, reason?, message? }`) from `src/types.ts`. `reason: 'maxBudgetUsd'` is reserved for Step 03 and not produced yet; Step 03 will add the budget-stop path that produces it.

Cost persistence already shipped in Step 01's filesystem loop-state backend (`src/loop-states/file.ts`, class `FileLoopState`, reached via `createLoopState(DEFAULT_LOOP_STATE, { outputDir, jobName })` from `src/loop-states.ts`): per-result `cost` is persisted and `totalUsd` is accumulated in the v2 state snapshot (`{ version: 2, results, claims, totalUsd }`). Step 03's remaining cost work is therefore the agent-side cost extraction, the reporters, and the budgets, not the state plumbing.

The state file is `${outputDir}/${jobName}-loop-state.json`; the loader is strict (missing file yields a fresh store, a non-v2 or malformed file throws). The doctor's resumable-state check reuses `FileLoopState.create(path)` so the doctor and the loop agree on what counts as loadable.
