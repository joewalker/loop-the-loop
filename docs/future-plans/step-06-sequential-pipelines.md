# Step 06: Pipelines with routing and rework

## Goal

Run a named set of loop steps that hand off through reader generators, with
pull-based verdict routing and bounded rework loops, per-step config overrides,
and strict failure handling. Steps run sequentially within a pass; cross-step
parallelism is Step 08.

A pipeline is a set of named steps plus one designated terminal `output` step.
It is not a DAG: there is no acyclicity requirement, no topological sort, and no
cycle detection. A `fix` to `verify` to `fix` rework cycle is a supported flow,
not an error.

See [conditional-routing-design.md](conditional-routing-design.md) for the full
design, including the worked rework trace and a configuration sketch.

## Work

- Add `isPipelineSpec` and `runPipeline`. Keep pipeline dispatch outside
  `loop()` so the normal single-loop path stays simple.
- Drop the DAG model. Validate only that `steps` is non-empty, that the
  declared terminal `output` step exists, and that any `dependsOn` entry names
  an existing step. `dependsOn` is an optional intra-pass ordering hint and may
  be cyclic.
- Run to a fixed point. Run every step's `loop()` once per pass and repeat
  passes until a whole pass records zero new terminal outcomes anywhere. A
  settled step yields nothing and returns immediately. Add a `maxPasses` safety
  ceiling that stops and reports rather than looping forever.
- Routing is emergent and pull-based. A producing step emits a verdict in
  `structuredOutput`; each consuming step's reader filters on it (Step 05).
  There is no central route table. Results with status `error` or `glitch`
  never route forward through a verdict filter; a sink step can pull them by
  filtering on `status`.
- Support bounded rework through attempt-scoped ids. The loop-back reader
  increments the `#N` attempt suffix and stops at `maxAttempts`; a complementary
  reader with `minAttempts` set to the same cap routes exhausted items to a
  giveup sink as a first-class terminal outcome (Step 05 primitives).
- Require `jsonl-report` for verdict routing, because the `loop-state` reader
  does not carry `structuredOutput`. Make a verdict filter against a non-jsonl
  source fail clearly.
- Build each step config by applying top-level defaults, step overrides, and a
  derived step name.
- Use the structured `LoopRunResult` to stop the pipeline after a failed or
  controlled-abort step under the strict default policy.
- Make `--dry-run` apply to every step.
- Add schema support for pipelines without permitting nested pipelines.

## Dependencies

- Step 01, for structured loop results.
- Step 05, for reader generators, handoff substitution, and the filter and
  attempt-scoped-id primitives that routing and rework rely on.

## Done when

- Linear, fan-out, fan-in, and rework-cycle pipelines all run to a fixed point.
- A `fix` and `verify` rework loop terminates at the attempt cap with an
  exhausted-rework outcome rather than hanging.
- Per-step agent, reporter, output directory, and source-update overrides work.
- Resume is rerunning the pipeline. Settled steps fast-forward, and attempt-
  scoped ids are recomputed deterministically so passes are idempotent.
- A failing step that no sink consumes prevents further progress under the
  strict default policy.

## Related plans

- [Conditional routing and rework loops](conditional-routing-design.md)
- [Wiring loops together into pipelines](../archived-plans/pipeline.md)
