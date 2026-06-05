# Carry-over context from Step 01 into Step 02

This records the state of the runtime after Step 01 (runtime contracts and state hardening) landed, so the Step 02 `--doctor` work builds on what actually shipped rather than on the pre-Step-01 code or on the Step 01 design doc's earlier wording. Step 01 lives on the `step-01-runtime-contracts-state-hardening` branch (five commits ahead of `main`); the items below are all merged into that branch.

## What Step 01 actually shipped

`loop()` and `loopImpl()` now return a structured `LoopRunResult` instead of a status string. The shape is in `src/types.ts`:

```ts
export interface LoopRunResult {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly reason?: 'maxPrompts' | 'maxBudgetUsd' | 'errorResult' | 'tooManyGlitches';
  readonly message?: string;
}
```

`maxBudgetUsd` is reserved for Step 03 and is not produced yet. `cli.ts` renders the result to a single line via a local `renderRunResult(result)` helper (`completed` to `Done`, `stopped` to `Done (<message>)`, `failed` to the message). `--doctor` does not return a `LoopRunResult`; it exits 0 or 1 on its own and must never invoke `loop()`.

The filesystem loop-state backend moved out of `src/util/loop-state.ts` to `src/loop-states/file.ts` (class `FileLoopState`), with its test at `src/loop-states/__test__/file.test.ts`. The old `src/util/loop-state.ts` and its test are deleted. Any Step 02 code that touches loop state must import from the new path.

## The strict state loader (for the doctor resumable-state check)

The state file is `${outputDir}/${jobName}-loop-state.json` and the only supported persisted shape is v2 (`{ version: 2, results, claims, totalUsd }`). The loader is strict, which is exactly what the doctor wants for a clear preflight verdict:

- A missing file (`ENOENT`) yields a fresh empty store, no error. The doctor should report this as `skip` (no state to resume).
- A file that parses but is not `version: 2` throws an `Error` whose message matches `Unsupported loop-state file at <path>: ...`. The doctor should report this as `fail`.
- A file that is not valid JSON throws `SyntaxError` from `JSON.parse`. The doctor should report this as `fail`.
- A valid v2 file loads and the doctor reports `ok`.

Use the Step 01 loader rather than re-parsing the file in the doctor, so the doctor and the loop agree byte-for-byte on what counts as loadable. Two equivalent entry points exist:

- `createLoopState(DEFAULT_LOOP_STATE, { outputDir, jobName })` from `src/loop-states.ts` (the factory the loop uses), or
- `FileLoopState.create(path)` from `src/loop-states/file.ts` (the path-based loader the factory wraps).

Writes are atomic (write to `${path}.tmp` then `rename`) and saves are serialized through an internal `#saveChain`. The doctor only reads, so these matter only as background.

## The git preflight to share with the loop

Step 02 plans to extract the loop's git preflight into a shared helper so doctor and loop stay in lockstep. Step 01 left that check inline in `loopImpl` (`src/loop.ts`, immediately after computing `git`):

```ts
const git = allowSourceUpdate ? new Git(process.cwd()) : undefined;
if (git && !(await git.isClean())) {
  throw new Error(
    'Working directory is not clean. Commit or stash changes before starting.',
  );
}
```

`Git` is in `src/util/git.ts` and currently exposes `isClean()`, `init()`, `add()`, `commit()`, and `maybeCommitAll()`. It does not yet have a "is inside a work tree" or "committer identity configured" probe; Step 02's deeper git checks (`git rev-parse --is-inside-work-tree`, `user.name` / `user.email`) will need new helpers there. When extracting the shared preflight, update `loopImpl` to call it so the two paths cannot drift.

## Component factories the doctor instantiates

The doctor instantiates the same configured components the loop does, then calls their optional `check()`. The factory signatures as of Step 01:

```ts
createAgent(agentSpec: AgentSpec): Promise<Agent>;                      // src/agents.ts
createPromptGenerator(spec: PromptGeneratorSpec): Promise<PromptGenerator>; // src/prompt-generators.ts
createReporter(type = DEFAULT_REPORTER, config: ReporterConfig): Promise<Reporter>; // src/reporters.ts
createLoopState(type = DEFAULT_LOOP_STATE, config: LoopStateConfig): Promise<LoopState>; // src/loop-states.ts
createLogger(loggerSpec: LoggerSpec): Logger;                          // src/loggers.ts
```

`ReporterConfig` and `LoopStateConfig` are both `{ outputDir, jobName }`. The loop derives `jobName` from `config.name`. `createReporter` and `createLoopState` are the model to copy for the doctor's component-construction-then-check pattern: a name-keyed constructor map plus a `DEFAULT_*` constant. The optional `check?()` capability Step 02 adds goes on the `Agent`, `PromptGenerator`, and `Reporter` interfaces in `src/agents.ts`, `src/prompt-generators.ts`, and `src/reporters.ts`.

## CLI surface to extend for `--doctor`

Arg parsing lives in `src/util/load-cli-config.ts`:

- `ParsedArgs` currently has `configPath`, `help`, `version`, `verbose`, `dryRun`, `maxPrompts`. Add `doctor?: boolean`.
- Flags are matched after `normalizeFlagName` (case and separators stripped), via `BOOLEAN_FLAGS` and `VALUE_FLAGS` maps. `--doctor` is a boolean flag, so add it to `BOOLEAN_FLAGS`.
- `USAGE` is a single shared string; extend it to mention `--doctor`.
- `loadCliConfig` and `normalizeCliConfig` produce the resolved config; the doctor needs the same resolved `LoopCliConfig` the loop would run.

`cli.ts` `main()` currently parses args, handles `--help` / `--version`, loads the config, runs `loop`, and prints the rendered result. The `--doctor` branch goes after config load and before `loop`, exiting with code 1 if any check fails. Note that when `--doctor` is set, `--dry-run` is ignored (the probe must hit the real configured components).

## Conventions and gotchas confirmed during Step 01

- `cli.ts` is not measured by coverage (no test imports it, and Vitest v8 only reports imported files). The `renderRunResult` helper added in Step 01 is therefore untested by design. The new `doctor()` orchestrator and checks must live in `src/doctor.ts` (imported by tests) and reach 100% coverage; keep `cli.ts` to a thin dispatch so the untested surface stays trivial.
- 100% coverage on statements, branches, functions, and lines is enforced. Prefer deleting dead code or adding a real test over an istanbul ignore.
- Tests are tagged. Default `pnpm test` runs only the `local` tag; live API tests use `*-live.test.ts` with a `// @module-tag <service>` header and are gated on env tokens. The doctor's real external probes (github / gitlab / bugzilla / codex) follow that same live-test convention.
- Test files use absolute extensionless imports (`loop-the-loop/...`); same-package runtime files use relative `.js` imports.
- This step adds a CLI flag with no JSON config key, so `schema/loop-the-loop.schema.json` does not change, and no `src/examples/` config is needed. README and `USAGE` should still mention `--doctor`.

## Note for later steps (not Step 02)

Step 01 deliberately did not add a `LoopStateSpec` union or `loopStateTypes`; the factory is keyed by a plain backend name (`type: LoopStateName`, currently only `'file'`) with the per-call config being `{ outputDir, jobName }`. Step 10 (remote loop state) introduces the spec union and reshapes the factory to carry backend-specific config; step-10's doc has been updated to reflect this. Step 03 should note that per-result `cost` persistence and `totalUsd` accumulation already shipped in Step 01's `FileLoopState`, so its remaining cost work is the agent-side extraction, the reporters, and budgets.
