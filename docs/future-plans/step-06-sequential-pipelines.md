# Step 06: Pipelines with routing and rework

## Goal

Run a named set of loop steps that hand off through reader generators, with pull-based verdict routing and bounded rework loops, per-step config overrides, and strict failure handling. Steps run sequentially within a pass; cross-step parallelism is Step 08.

A pipeline is a set of named steps plus one designated terminal `output` step. It is not a DAG: there is no acyclicity requirement, no topological sort, and no cycle detection. A `fix` to `verify` to `fix` rework cycle is a supported flow, not an error.

See [conditional-routing-design.md](conditional-routing-design.md) for the full design, including the worked rework trace and a configuration sketch.

## Work

- Place the pipeline in the `promptGenerator` slot as `["pipeline", {...}]` rather than a new top-level config key, so the single-loop common case stays simple. Add `isPipelineSpec` to detect it and `runPipeline` to run it, dispatched outside `loop()` so the normal single-loop path stays unchanged.
- Guard `createPromptGenerator` so it throws a clear error if it is ever handed a pipeline spec. Only `runPipeline` consumes the spec, and it strips the `["pipeline", ...]` wrapper before calling `loop()`, so reaching the generator factory with a pipeline spec means a misrouted config or a nested pipeline.
- Drop the DAG model. Validate only that `steps` is non-empty, that the declared terminal `output` step exists, and that any `dependsOn` entry names an existing step. `dependsOn` is an optional intra-pass ordering hint and may be cyclic.
- Run to a fixed point. Run every step's `loop()` once per pass and repeat passes until a whole pass records zero new terminal outcomes anywhere. A settled step yields nothing and returns immediately. Add a `maxPasses` safety ceiling that stops and reports rather than looping forever.
- Routing is emergent and pull-based. A producing step emits a verdict in `structuredOutput`; each consuming step's reader filters on it (Step 05). There is no central route table. Results with status `error` or `glitch` never route forward through a verdict filter; a sink step can pull them by filtering on `status`.
- Support bounded rework through attempt-scoped ids. The loop-back reader increments the `#N` attempt suffix and stops at `maxAttempts`; a complementary reader with `minAttempts` set to the same cap routes exhausted items to a giveup sink as a first-class terminal outcome (Step 05 primitives).
- Require `jsonl-report` for verdict routing, because the `loop-state` reader does not carry `structuredOutput`. Make a verdict filter against a non-jsonl source fail clearly.
- Validate the reporter/handoff contract at startup: any step whose report is consumed by a `jsonl` reader must resolve to the `jsonl-report` reporter. The default `yaml-report` cannot be read back, so a pipeline that leaves the reporter at the default while handing off through a `jsonl` reader is rejected up front with a clear message rather than silently producing unreadable handoff that only surfaces when a downstream step fails to parse.
- Build each step config by applying top-level defaults, step overrides, and a derived step name.
- Use the structured `LoopRunResult` to stop the pipeline after a failed or controlled-abort step under the strict default policy.
- Make `--dry-run` apply to every step.
- Add schema support for pipelines without permitting nested pipelines.

## Dispatch and normalization

The fork happens at the CLI entry, not inside `loop()`. `cli.ts` branches `isPipelineSpec(config.promptGenerator) ? runPipeline(config) : loop(config)`, so `loop()` is byte-for-byte unchanged on the common path. `runPipeline` lives in a new `src/pipeline.ts` and imports `loop`; `loop` never imports `pipeline.ts`, so there is no cycle.

Normalization stays in `src/util/load-cli-config.ts`. `normalizeCliConfig` detects a pipeline and, for each step, applies the same two transforms it already applies at the top level: normalize the step's agent (whose `systemPrompt` may contain includes) and its prompt generator (whose `dataFile` and includes are config-relative). The `--dry-run` agent swap descends into every step. `runPipeline` then only merges configs and calls `loop()`, so it stays pure orchestration that is easy to test with the `test` agent.

## Per-step config

`runPipeline` builds a complete config for each step before calling `loop()`. The merge is shallow: top-level defaults, then the step's own fields, then a derived `name`.

- `name`: `${pipelineName}-${stepKey}`, which determines the report filename (`${name}-report.jsonl`) and the state filename (`${name}-loop-state.json`), keeping every step's artifacts distinct.
- `outputDir`: the step value if set, otherwise the pipeline's resolved `outputDir`. Steps normally share one directory.
- `agent`, `reporter`, `allowSourceUpdate`, `maxPrompts`, `interPromptPause`, `logger`: the step value if set, otherwise the pipeline value.

`maxPrompts` and `interPromptPause` are therefore per step by inheritance. A top-level `maxPrompts: 100` caps each step at 100, not the pipeline at 100; a pipeline-wide budget is Step 07.

## Failure, resume, and termination

The default policy is strict: if a step's `LoopRunResult` is a failure or controlled abort, the pipeline stops and reports the step; downstream steps do not run. An `error` or `glitch` that no sink step consumes therefore stops the pipeline. A `continueOnFailure` escape hatch is deferred.

Resume needs no new state file. Each step resumes from its own loop-state and a settled step yields nothing, so pipeline resume is "re-run every step until the fixed point". Attempt-scoped ids are recomputed deterministically, so passes are idempotent. Termination is guaranteed by the per-reader attempt cap (the id space stops growing), backed by the fixed-point convergence check, with `maxPasses` as a final backstop.

## Dependencies

- Step 01, for structured loop results.
- Step 05, for reader generators, handoff substitution, and the filter and attempt-scoped-id primitives that routing and rework rely on.

## Done when

- Linear, fan-out, fan-in, and rework-cycle pipelines all run to a fixed point.
- A `fix` and `verify` rework loop terminates at the attempt cap with an exhausted-rework outcome rather than hanging.
- Per-step agent, reporter, output directory, and source-update overrides work.
- Resume is rerunning the pipeline. Settled steps fast-forward, and attempt-scoped ids are recomputed deterministically so passes are idempotent.
- A failing step that no sink consumes prevents further progress under the strict default policy.
- A pipeline that hands off through a `jsonl` reader while leaving the reporter at the default `yaml-report` is rejected at startup, not discovered when a downstream step fails to parse.

## Out of scope

- Nested pipelines. The schema's generator recursion structurally permits them, but the `createPromptGenerator` guard rejects them at runtime with a clear message.
- A `continueOnFailure` escape hatch.
- A first-class queue subsystem. Handoff uses report and state files read by the Step 05 readers.
- Cross-step parallelism (Step 08) and a pipeline-state index file.

## Tests

- `src/__test__/pipeline.test.ts` with the `test` agent: a linear two-step pipeline runs in order and the downstream reader reads the upstream report; fan-in over two upstream reports; a rework cycle terminates at the attempt cap with a giveup outcome; validation rejects a missing `output` and an unknown `dependsOn`; per-step `agent` and `allowSourceUpdate` overrides apply and step names produce `${pipelineName}-${stepKey}` artifacts; a failing step stops the pipeline under the strict policy; resume fast-forwards settled steps; `--dry-run` swaps every step's agent; the `createPromptGenerator` guard throws on a pipeline spec including a nested one; a `jsonl` handoff with the default reporter is rejected at startup.
- `schema.test.ts`: a pipeline config validates; a `pipelineStep` missing `promptGenerator` fails.

## Files

- New `src/pipeline.ts` (`isPipelineSpec`, `runPipeline`, validation, fixed-point passes, per-step config synthesis, strict failure policy) and `src/__test__/pipeline.test.ts`.
- `src/cli.ts`: branch to `runPipeline` via `isPipelineSpec`.
- `src/types.ts`: `PipelineTask` and `PipelineStep`.
- `src/prompt-generators.ts`: the `pipeline` guard in `createPromptGenerator` and a `pipeline` branch in `normalizePromptGeneratorSpec`.
- `src/util/load-cli-config.ts`: detect a pipeline in `normalizeCliConfig`, normalize each step's agent and generator, and apply the `--dry-run` swap across steps.
- `schema/loop-the-loop.schema.json`: the `pipeline` tuple, `pipelineTask`, and `pipelineStep`; example pipeline configs under `src/examples/`.

## Related plans

- [Conditional routing and rework loops](conditional-routing-design.md)
