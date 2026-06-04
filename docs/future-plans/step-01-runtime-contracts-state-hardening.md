# Step 01: Runtime contracts and state hardening

## Goal

Establish strict runtime contracts that later work can rely on without parsing
status strings, supporting legacy state shapes, or sharing filesystem details
between features.

Correctness going forward is more important than compatibility with old
pre-v2 state files.

## Work

- Introduce a structured `LoopRunResult` returned by `loop()` and `loopImpl`.
  It should distinguish successful completion from controlled stops and
  failures. Reasons should include at least `maxPrompts`, `maxBudgetUsd`,
  `errorResult`, and `tooManyGlitches`.
- Make the v2 loop-state shape the only supported persisted format:
  `{ version, results, claims, totalUsd }`.
- Remove compatibility concepts from the active runtime contract, including
  old `completed`, `failed`, `inProgress`, `begin`, and `end` paths.
- Move `FileLoopState` from `src/util/loop-state.ts` to
  `src/loop-states/file.ts`.
- Change filesystem writes to write a tmp file and rename it into place, so
  interrupted writes cannot leave a partially written state file.
- Keep serialized saves in the filesystem backend so concurrent in-process
  state operations do not lose updates.
- Shape `createLoopState` so later backend selection can be added without
  changing callers again.

## Dependencies

None. This is the foundation for the rest of the roadmap.

## Done when

- Existing behavior is preserved for current v2 state files.
- Old state shapes fail clearly instead of being silently migrated.
- Tests cover structured loop results, strict state loading, atomic writes,
  serialized saves, claim ownership, completion, release, and snapshots.
- Later plans can consume a structured loop result without inspecting strings.

## Related plans

- [Pluggable loop state for CI and concurrent runs](remote-loop-state.md)
- [Per-prompt cost accounting and run budgets](cost-accounting.md)
- [Wiring loops together into pipelines](pipeline.md)
