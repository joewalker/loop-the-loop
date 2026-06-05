# Step 01: Runtime contracts and state hardening

## Goal

Establish strict runtime contracts that later work can rely on without parsing status strings, supporting legacy state shapes, or sharing filesystem details between features.

Correctness going forward is more important than compatibility with old pre-v2 state files.

## Work

- Introduce a structured `LoopRunResult` returned by `loop()` and `loopImpl`. It should distinguish successful completion from controlled stops and failures. Reasons should include at least `maxPrompts`, `maxBudgetUsd`, `errorResult`, and `tooManyGlitches`.
- Make the v2 loop-state shape the only supported persisted format: `{ version, results, claims, totalUsd }`.
- Remove compatibility concepts from the active runtime contract, including old `completed`, `failed`, `inProgress`, `begin`, and `end` paths.
- Move `FileLoopState` from `src/util/loop-state.ts` to `src/loop-states/file.ts`.
- Change filesystem writes to write a tmp file and rename it into place, so interrupted writes cannot leave a partially written state file.
- Keep serialized saves in the filesystem backend so concurrent in-process state operations do not lose updates.
- Shape `createLoopState` so later backend selection can be added without changing callers again.

## Structured loop result

`loop()` and `loopImpl` return a `LoopRunResult` instead of a status string, so later steps branch on a field rather than matching text. Cost budgets (Step 03), concurrency stop conditions (Step 04), and pipeline orchestration (Step 06) all consume this.

```ts
export interface LoopRunResult {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly reason?: 'maxPrompts' | 'maxBudgetUsd' | 'errorResult' | 'tooManyGlitches';
  readonly message?: string;
}
```

The reason set is open to extension: Step 06 adds a pipeline-level `maxPasses` stop, for example. The contract is that a structured field, never a parsed string, carries the stop condition. This replaces the old return-string contract, which earlier pipeline and budget designs called out as their main piece of technical debt.

## State contract

The `LoopState` interface in `src/loop-states.ts` is the single state contract for the runtime and every later backend. Prompt generators only call `isOutstanding`; the loop calls the rest.

```ts
export interface LoopState {
  isOutstanding(id: string): boolean;
  claim(runId: string, id: string): Promise<boolean>;
  complete(runId: string, id: string, result: LoopStateResult): Promise<void>;
  release(runId: string): Promise<void>;
  getSnapshot(): Promise<LoopStateSnapshot>;
}
```

- `isOutstanding(id)` is true unless `id` has a terminal outcome in `results`. It does not consult `claims`, so a generator skips only terminal outcomes.
- `claim(runId, id)` is the atomic race-arbiter: `false` when the id already has a terminal outcome or is owned by another run, `true` once this run owns it.
- `complete(runId, id, result)` records terminal `success` / `error` in `results`, accumulates cost into `totalUsd` (Step 03), and removes the claim. A glitch leaves the id outstanding for retry.
- `release(runId)` clears every claim held by that run. It is idempotent and is called from the loop's `finally`, and from signal handlers once Step 10 lands.
- `getSnapshot()` returns the canonical persisted shape for readers, budget checks, and diagnostics without exposing backend storage.

The only supported persisted shape is v2:

```json
{
  "version": 2,
  "results": { "id-a": { "status": "success" }, "id-c": { "status": "error", "reason": "..." } },
  "claims":  { "id-b": { "runId": "<runId>", "claimedAt": "2026-06-03T12:00:00.000Z" } },
  "totalUsd": 0
}
```

Outcomes are deliberately slim (`status`, optional `reason`, and the Step 03 `cost`): `output` and `structuredOutput` can be multi-KB and the file is rewritten often, so the state file stays a fast index while the reporter holds the full result. Old `completed` / `failed` / `inProgress` arrays and the `begin` / `end` paths are removed from the runtime. A file that is not v2 fails clearly on load rather than being silently migrated.

## Filesystem backend

`FileLoopState` moves to `src/loop-states/file.ts`. Writes go to `${path}.tmp` then `rename` into place, so an interrupted write never leaves a half-written file. An internal save chain (`#saveChain: Promise<void>`) serializes concurrent in-process `claim` / `complete` saves so updates are not lost. The backend is single-host; multi-host sharing is Step 10.

`createLoopState(spec, { outputDir, jobName })` is shaped like `createReporter`, with an internal constructor map, so Step 10 can register an `s3` backend with no caller changes. The default is the filesystem backend writing `${outputDir}/${jobName}-loop-state.json`, preserving today's behaviour byte-for-byte.

## Dependencies

None. This is the foundation for the rest of the roadmap.

## Done when

- Existing behavior is preserved for current v2 state files.
- Old state shapes fail clearly instead of being silently migrated.
- Tests cover structured loop results, strict state loading, atomic writes, serialized saves, claim ownership, completion, release, and snapshots.
- Later plans can consume a structured loop result without inspecting strings.

## Files

- New `src/loop-states/file.ts` (`FileLoopState`) and `src/loop-states/__test__/file.test.ts`, porting the cases from the old `loop-state.test.ts` and dropping assertions over old `completed` / `failed` / `inProgress` writes.
- `src/loop-states.ts`: the `LoopState` interface, `LoopRunResult`, and `createLoopState` with a backend-constructor map.
- `src/loop.ts`: return `LoopRunResult`; generate `runId` via `crypto.randomUUID()`; wrap the main loop so `release(runId)` always runs.
- `src/types.ts`: `LoopRunResult` and the v2 state types.
- Delete `src/util/loop-state.ts` and `src/util/__test__/loop-state.test.ts` after porting.
