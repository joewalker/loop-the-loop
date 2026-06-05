# Step 05: Reader generators plus local handoff substitution

## Goal

Make one loop consume another loop's local output through normal prompt generators, with handoff paths that stay correct when `outputDir`, pipeline name, or step names change.

## Work

- Add a `jsonl` prompt generator that reads JSONL reporter output line by line. It can only read `jsonl-report` output: the default `yaml-report` is not line-delimited JSON and neither reader can consume it. A handoff path that resolves to a non-JSONL report must fail with a clear format-mismatch message rather than being silently treated as empty.
- Add a `loop-state` prompt generator that reads the strict v2 state snapshot.
- Support filtering by status and selecting success, error, or all state outcomes.
- Support field-path filter keys, including `structuredOutput.*`, with equality matching only, so a consuming step can route on a producing step's verdict. This is what Step 06 routing reads.
- Add `maxAttempts` and `minAttempts` reader knobs plus an `incrementAttempt` flag so a reader can re-emit an item at the next attempt-scoped id (`id#N`). This is the primitive that makes bounded rework loops work in Step 06.
- Gate generated ids through the consuming step's own `loopState.isOutstanding` check.
- Add local handoff substitutions such as `{{steps.review.report}}` and `{{steps.review.state}}` for config fields like `dataFile` and `stateFile`.
- Define missing local report files as empty input when the upstream step completed with no prompts, while malformed present files remain errors.

## The jsonl reader

New generator `jsonl` (`src/prompt-generators/jsonl.ts`), distinct from the existing `json` generator: `json` does one whole-file `JSON.parse`, whereas `jsonl` reads a JSONL reporter file one object per line. Config (`JsonlTask`):

- `dataFile` (required): path to the JSONL file, config-relative or a handoff substitution.
- `promptTemplate` (required): the same `{{field}}` and `{{include:}}` model as `json`.
- `idField` (optional): the line field used as the prompt id, default `id` (report lines always carry `id` because they are `{...prompt, ...result}`).
- `filter` (optional): field-path equality, for example `{ "status": "success" }` or `{ "structuredOutput.verdict": "rework" }`. Dotted paths including `structuredOutput.*` are supported; equality only, no operators or expression language.
- `maxAttempts` / `minAttempts` / `incrementAttempt` (optional): the attempt-scoped gates below.

Each line's top-level fields become template variables, plus `{{id}}` and `{{index}}`. Object-valued fields such as `structuredOutput` are stringified with `JSON.stringify`. A malformed line throws with its line number rather than being silently dropped. Duplicate ids and the resume gate work as in `json`.

## The loop-state reader

New generator `loop-state` (`src/prompt-generators/loop-state.ts`) reads the strict v2 state snapshot and yields prompts from per-id outcomes, for status-based routing without the full report. Config (`LoopStateTask`):

- `stateFile` (required): config-relative or a handoff substitution.
- `promptTemplate` (required).
- `select` (optional): `success`, `error`, or `all`, default `success` (the safe choice for forward progress).

Template variables per entry are `{{id}}`, `{{status}}`, and `{{reason}}` when the status is `error`. The reader derives entries from `results` and ignores `claims`, because active claims are not terminal routing decisions. It cannot provide `output` or `structuredOutput`, which the state file deliberately does not store; use `jsonl` when the upstream output text or a verdict is needed.

## Attempt-scoped ids

`maxAttempts` emits an item only while its parsed `#N` attempt is below the cap; `minAttempts` emits only once the attempt is at or above it; `incrementAttempt` makes a loop-back reader emit the id at `#(N+1)`. Attempt 1 is the bare id with no suffix. These three knobs are the primitive Step 06 rework loops rely on; the full routing model is in [conditional-routing-design.md](conditional-routing-design.md).

## Handoff substitution

Config fields like `dataFile` and `stateFile` accept `{{steps.<name>.report}}` and `{{steps.<name>.state}}`, which resolve to the named step's actual local artifacts under `outputDir`. This replaces hard-coded filenames, so renaming a step or pipeline updates its consumers instead of silently breaking the wiring, and it removes the config-relative-versus-`outputDir`-relative path asymmetry that hard-coded names suffered from.

## Missing and malformed files

A missing report or state file is treated as empty input: the upstream step completed with no prompts, and the reporter creates the file lazily on first append. A present-but-malformed file is an error. A `jsonl` reader pointed at non-JSONL output (for example the default `yaml-report`) fails with a clear format-mismatch message naming the mismatch, not a generic parse error or a silent empty read. Both readers gate yielded ids through the consuming step's own `loopState.isOutstanding(id)`, so the consuming step is itself resumable; its state file is a different file from the upstream artifact it reads as data.

## Dependencies

- Step 01, for the strict state snapshot shape.
- Step 03, so report and state readers can pass through cost fields.

## Done when

- The readers are useful in ordinary non-pipeline loop configs.
- Handoff paths resolve to the actual upstream local artifacts under `outputDir`.
- Renaming a step or pipeline updates handoff targets through substitution rather than silently breaking hard-coded filenames.
- A `jsonl` reader pointed at `yaml-report` output (the default reporter) fails with a clear message naming the format mismatch, not a generic parse error or a silent empty read.
- A reader can filter on `structuredOutput` fields and re-emit at an incremented attempt id, which the Step 06 routing model relies on.
- Tests cover malformed JSONL, duplicate ids, filters, field-path matching, attempt-scoped re-emission, missing files, and resume skips.

## Files

- New `src/prompt-generators/jsonl.ts` and `src/prompt-generators/loop-state.ts` plus their `__test__` files.
- `src/prompt-generators.ts`: register `jsonl` and `loop-state` and add their normalize branches.
- `src/util/load-cli-config.ts`: resolve `{{steps.*}}` handoff substitutions in generator config fields.
- `schema/loop-the-loop.schema.json`: `jsonlTask` and `loopStateTask`, modeled on `jsonTask`; example configs under `src/examples/`.

## Related plans

- [Conditional routing and rework loops](conditional-routing-design.md)
