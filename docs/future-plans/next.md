# Carry-over context for Step 06 (pipelines with routing and rework)

Steps 01 through 05 are complete on `main`. This records what Step 06 needs to know from Step 05's reader-generator and local-handoff work. The Step 05 design lives in `step-05-reader-generators-local-handoff.md` and the as-built task breakdown in `step-05-reader-generators-local-handoff-plans.md`; only the parts that touch Step 06 are repeated here.

## Two reader generators now exist and are consumed like any other generator

`jsonl` (`src/prompt-generators/jsonl.ts`) reads a `jsonl-report` one JSON object per line. `loop-state` (`src/prompt-generators/loop-state.ts`) reads the strict v2 state snapshot. Both are registered in `src/prompt-generators.ts` (in `promptGeneratorCreators`, with a normalize branch in `normalizePromptGeneratorSpec`) and validate against `schema/loop-the-loop.schema.json` via the `jsonlTask` and `loopStateTask` definitions. Step 06 does not change the readers; it composes them. Fan-in is the existing `batch` generator wrapping several readers, exactly as the routing design sketch shows.

Each reader gates every emitted id through the consuming loop's own `loopState.isOutstanding(id)`, so a step that reads an upstream artifact as data is itself resumable: its state file (`${name}-loop-state.json`) is a different file from the upstream report or state it reads. This is what makes "resume is rerunning the pipeline" work without new state.

## The routing and rework primitives are in place on `jsonl`

- Filtering: `filter` is field-path equality, including dotted paths into `structuredOutput`, for example `{ "structuredOutput.verdict": "rework" }`. Matching is string-coerced equality only (no operators). A path that misses (absent field or non-object intermediate) does not match, so a line with no `structuredOutput` is simply not pulled by a verdict filter. This is the pull-based routing channel Step 06 relies on.
- Attempt-scoped ids: `maxAttempts` emits only while the parsed `#N` attempt is below the cap; `minAttempts` emits only once it is at or above the cap; `incrementAttempt` re-emits at `#(N+1)`. Attempt 1 is the bare id. The logic lives in `src/prompt-generators/util/attempt.ts` (`parseAttempt`, `formatAttempt`, `resolveAttemptId`). A numeric suffix counts as an attempt only when it is 2 or greater, so ids that legitimately contain `#` (or `#1`) round-trip unchanged. The rework arm uses `maxAttempts` + `incrementAttempt`; the giveup arm uses `minAttempts` set to the same cap. These two readers partition rework items, which is what bounds termination.

Important: the attempt knobs live on `jsonl` only. `loop-state` carries `status` and `reason` but never `structuredOutput`, so it cannot route on a verdict and has no attempt knobs. A pipeline that uses verdict-based rework must use `jsonl-report` as its reporter. Step 06's "require `jsonl-report` for verdict routing" and "reject a `jsonl` handoff that leaves the reporter at the default `yaml-report`" startup checks are still Step 06's to add.

## Handoff substitution exists, but its name-to-filename mapping is the single biggest Step 06 gotcha

`{{steps.<name>.report}}` and `{{steps.<name>.state}}` are resolved by `resolveStepHandoff(value, outputDir)` in `src/prompt-generators/util/handoff.ts`. As built, it maps the marker name DIRECTLY to a filename under `outputDir`:

- `{{steps.<name>.report}}` resolves to `<outputDir>/<name>-report.jsonl`
- `{{steps.<name>.state}}` resolves to `<outputDir>/<name>-loop-state.json`

This is correct for a standalone (non-pipeline) loop, where the loop `name` equals the report basename. But Step 06 derives each step's `name` as `${pipelineName}-${stepKey}` (step-06 doc, Per-step config), so the actual report file for step `review` in pipeline `bugfix` is `bugfix-review-report.jsonl`, NOT `review-report.jsonl`. The routing-design configuration sketch writes `{{steps.review.report}}` using the bare step key. So Step 06 MUST reconcile the marker's step key with the derived, pipeline-prefixed artifact name. Two clean options:

1. Before handing each step's generator spec to `normalizePromptGeneratorSpec`, rewrite the inner name of every `{{steps.<stepKey>.report|state}}` marker to the derived `${pipelineName}-${stepKey}`, so the existing `resolveStepHandoff` then produces the right path.
2. Or extend `resolveStepHandoff` to take a `stepKey -> derivedName` resolver and have the pipeline pass one.

Either way, do not assume the marker name already equals the filename inside a pipeline. There is no test for the pipeline case yet because Step 05 is non-pipeline only; add one in Step 06.

The substitution is applied inside `normalizePromptGeneratorSpec`, which now reads `outputDir` from the `PromptGeneratorConfigContext` (a required field as of Step 05). The only place that constructs that context is `normalizeCliConfig` in `src/util/load-cli-config.ts`, which passes `{ configDir, outputDir }`. Step 06's per-step normalization must pass the pipeline's resolved `outputDir` (the directory the steps actually share) into each step's context, or handoff markers resolve against the wrong directory.

## Missing files are empty input, which interacts with the reporter contract

Both readers treat a missing `dataFile`/`stateFile` as empty input (the upstream step completed with no prompts, or has not run yet), while a present-but-malformed file is an error. The `jsonl` reader additionally fails with a clear format-mismatch message when pointed at a `.yaml`/`.yml` path.

The consequence Step 06 must guard: because handoff always resolves to a `.jsonl` filename, a step left on the default `yaml-report` writes `${name}-report.yaml` while its consumer reads `${name}-report.jsonl`. The reader does not see a `.yaml` extension (the resolved path ends in `.jsonl`), so the format-mismatch guard does NOT fire; instead the consumer reads a missing file as empty and silently makes no progress. This is exactly why step-06 line 60 requires a startup reporter/handoff contract check: validate up front that any step whose report is consumed by a `jsonl` reader resolves to the `jsonl-report` reporter, rather than discovering the silent-empty handoff at run time.

## Template variables the readers expose

- `jsonl`: every top-level line field becomes a `{{field}}` variable (object-valued fields such as `structuredOutput` and `cost` are JSON-stringified), plus `{{id}}` (the emitted, possibly attempt-incremented id, which wins over a same-named line field) and `{{index}}`. Cost passes through as the stringified `{{cost}}` field; nothing special is needed for the Step 03 cost dependency.
- `loop-state`: `{{id}}`, `{{status}}`, and `{{reason}}` (only for `error` outcomes). It derives entries from `results` and ignores `claims`. `select` is `success` (default), `error`, or `all`.

## Unchanged surfaces and small as-built notes

- `createPromptGenerator` has no `pipeline` branch yet; Step 06 adds the guard there and a `pipeline` branch in `normalizePromptGeneratorSpec`.
- The new readers do not implement the optional `check()` doctor probe (deliberate scope choice). Doctor handles its absence.
- `jsonl`'s `filter` schema uses `additionalProperties: { anyOf: [ {string}, {number}, {boolean} ] }` rather than a union `type` array, because the schema test runs ajv in strict mode. Follow that pattern if Step 06 adds scalar-valued maps to the schema.
- `resolveAttemptId` is called as `resolveAttemptId(rawId, this.#task)` in `jsonl.ts` because `JsonlTask` structurally satisfies `AttemptKnobs`; building a literal of the optional fields trips `exactOptionalPropertyTypes`. Keep that in mind when constructing option objects for these helpers.
- Coverage is enforced at 100%. The normalize-branch coverage for each generator lives in `src/util/__test__/load-cli-config.test.ts` (there is now a `jsonl` and a `loop-state` case there); add a pipeline-step normalize case in the same style.
- Example reader configs live under `src/examples/reader-generators/` and are validated automatically by `src/__test__/schema.test.ts`.
