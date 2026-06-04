# Step 06: Sequential pipelines

## Goal

Run a named DAG of loop steps in dependency order, with per-step config
overrides and strict failure handling.

## Work

- Add `isPipelineSpec` and `runPipeline`.
- Keep pipeline dispatch outside `loop()` so the normal single-loop path stays
  simple.
- Validate the DAG before running any step.
- Require an `output` step.
- Detect unknown dependencies, self-dependencies, and cycles.
- Warn about steps that are not reachable from `output`.
- Build each step config by applying top-level defaults, step overrides, and a
  derived step name.
- Use the structured `LoopRunResult` to stop downstream work after failed or
  controlled-abort steps.
- Make `--dry-run` apply to every step.
- Add schema support for pipelines without permitting nested pipelines.

## Dependencies

- Step 01, for structured loop results.
- Step 05, for local handoff between steps.

## Done when

- Linear, fan-out, and fan-in pipelines run sequentially.
- Per-step agent, reporter, output directory, and source-update overrides work.
- Resume is implemented by rerunning the pipeline and letting completed steps
  fast-forward.
- A failing step prevents downstream steps from running under the strict
  default policy.

## Related plans

- [Wiring loops together into pipelines](pipeline.md)
