# Plan: wiring loops together into pipelines

## Context

The [roadmap](./roadmap.md) entry reads "Add the ability to wire together a number of prompts (e.g. find bug, fix bug, review fix, update fix, create pr)." A realistic example:

1. Review every source file against a standard, raising bugs above a severity threshold, and record the findings.
2. For each recorded bug, generate a fix.
3. Review each proposed fix against its bug report using a different model, and decide whether the fix proceeds or goes back for more work.
4. Generate a commit message and commit the change.
5. Group the commits together and write a review summary to help a human reviewer.

The work needs a directed acyclic graph (DAG) rather than a fixed linear sequence because we want fan-out (one review pass raises many bugs), fan-in (one summary combines many upstream results), and non-linear flows (a fix may be sent back, or proceed).

The first thing to settle is what a pipeline is, because the obvious framing does not work. A pipeline cannot be a prompt generator. A `PromptGenerator` ([src/prompt-generators.ts](../../src/prompt-generators.ts)) yields only `{id, prompt}`; it never sees agent output, never invokes an agent, and never writes to a reporter. But `loop()` ([src/loop.ts](../../src/loop.ts)) binds exactly one agent, one reporter, and one `allowSourceUpdate` setting per run. The example needs a different model for the review step and `allowSourceUpdate` only for the commit step. Those are per-step agent, reporter, and git settings, none of which a prompt generator can express. So a pipeline must be an orchestrator that runs a full `loop()` once per step.

The feature therefore splits into two independent halves:

1. Two new reader prompt generators, `jsonl` and `loop-state`, that let one step consume another step's output file. These are ordinary `PromptGenerator`s and are useful on their own, even outside a pipeline.
2. A pipeline orchestrator, `runPipeline`, a sibling to `loop()` that runs a `loop()` per step in dependency order. The `["pipeline", {...}]` spec is a marker intercepted before `createPromptGenerator` is ever called; it is not registered as a generator.

Design decisions confirmed with the user:

- The pipeline is configured nested under `promptGenerator` as `["pipeline", { steps }]`, not as a new top-level config key. The common case is a single loop (one agent over one generator); keeping the pipeline out of the top level keeps that case simple. The engine special-cases the pipeline spec.
- Each step is a sub-config (everything a top-level loop carries except `name`) plus a `dependsOn` list. The top-level `agent`, `reporter`, `allowSourceUpdate`, and similar fields act as defaults each step may override.
- Handoff between steps uses the two reader generators reading the upstream step's report or loop-state file. There is no separate queue subsystem. The "github queue" and "git queue" in the original sketch were illustrative; in practice a step either reads a prior step's report file or, where it makes sense, files real GitHub issues that a later step reads back with the existing `github` generator.
- The first version runs steps sequentially. Parallelism is layered on later and is where the [concurrency.md](./concurrency.md) plan becomes a real dependency.
- Conditional routing (a verify step sending work back to a fix step) is out of scope for the first version.

## Configuration shape

A pipeline lives in the `promptGenerator` slot. Steps are named entries; the names are labels, not an execution order. Edges are stated with `dependsOn`. Execution is resolved from the step named `output`.

```json
{
  "$schema": "https://raw.githubusercontent.com/joewalker/loop-the-loop/refs/heads/main/schema/loop-the-loop.schema.json",
  "name": "fix-bugs",
  "agent": ["claude-sdk", { "allowedTools": [] }],
  "reporter": "jsonl-report",
  "promptGenerator": [
    "pipeline",
    {
      "steps": {
        "review": {
          "promptGenerator": [
            "per-file",
            { "filePattern": "src/**/*.ts", "promptTemplate": "{{include:review.md}}" }
          ]
        },
        "fix": {
          "dependsOn": ["review"],
          "promptGenerator": [
            "jsonl",
            {
              "dataFile": "fix-bugs-review-report.jsonl",
              "filter": { "status": "success" },
              "promptTemplate": "{{include:fix.md}}"
            }
          ]
        },
        "verify": {
          "dependsOn": ["fix"],
          "agent": ["claude-sdk", { "model": "claude-opus-4-8", "allowedTools": [] }],
          "promptGenerator": [
            "jsonl",
            { "dataFile": "fix-bugs-fix-report.jsonl", "promptTemplate": "{{include:verify.md}}" }
          ]
        },
        "commit": {
          "dependsOn": ["verify"],
          "allowSourceUpdate": true,
          "promptGenerator": [
            "loop-state",
            {
              "stateFile": "fix-bugs-verify-loop-state.json",
              "select": "completed",
              "promptTemplate": "{{include:commit.md}}"
            }
          ]
        },
        "output": {
          "dependsOn": ["commit"],
          "promptGenerator": [
            "jsonl",
            { "dataFile": "fix-bugs-commit-report.jsonl", "promptTemplate": "{{include:summary.md}}" }
          ]
        }
      }
    }
  ]
}
```

Notes on the example:

- `verify` overrides `agent` so the fix review uses a different model from the rest of the pipeline.
- `commit` sets `allowSourceUpdate: true` for the only step that mutates the working tree.
- The handoff is explicit. Each step that consumes upstream work names the upstream report or state file in its generator config (see "Inter-step handoff" for how those filenames are derived).
- The reporter `jsonl-report` is chosen at the top level so that report files are line-delimited JSON and can be read by the `jsonl` generator. The default `yaml-report` cannot be read by either reader generator.

### How a step config inherits and overrides

`runPipeline` builds a complete `LoopCliConfig` for each step before calling `loop()`. The merge is shallow: top-level defaults, then the step's own fields, then a derived `name`.

- `name`: `${pipelineName}-${stepKey}`, for example `fix-bugs-review`. This determines the report filename (`${name}-report.jsonl`) and the state filename (`${name}-loop-state.json`), so a compound name keeps every step's artifacts distinct.
- `outputDir`: the step value if set, otherwise the pipeline's resolved `outputDir`. All steps normally share one directory.
- `agent`, `reporter`, `allowSourceUpdate`, `maxPrompts`, `interPromptPause`, `logger`: the step value if set, otherwise the pipeline value. The `verify` and `commit` steps in the example use this to override `agent` and `allowSourceUpdate`.

Because all steps share the single config file, every `{{include:...}}` and every `dataFile` resolves relative to that one config file's directory, exactly as the `batch` generator's nested source does today.

## Dispatch and normalization

The fork happens at the CLI entry, not inside `loop()`. Today [src/cli.ts](../../src/cli.ts) does `loadCliConfig(parsedArgs)` then `await loop(config)`. We add a one-line predicate, `isPipelineSpec(spec)` (true when `spec` is an array whose first element is `"pipeline"`), and branch:

```ts
const result = isPipelineSpec(config.promptGenerator)
  ? await runPipeline(config)
  : await loop(config);
```

Keeping the fork at the entry leaves `loop()` byte-for-byte unchanged on the common path, which matters because the concurrency.md and cost-accounting.md plans both patch `loop()` heavily. `runPipeline` lives in a new `src/pipeline.ts` and imports `loop`; `loop` never imports `pipeline.ts`, so there is no cycle.

`createPromptGenerator` ([src/prompt-generators.ts](../../src/prompt-generators.ts)) gains a guard: if it is ever handed a `pipeline` spec it throws a clear error. The only legitimate caller, `runPipeline`, strips the pipeline wrapper before it calls `loop()`, so reaching `createPromptGenerator` with a pipeline spec means either a misrouted config or a nested pipeline. This mirrors the existing `batch` special-case in the same function.

Normalization is the subtle part. Each step has its own `agent` (whose `systemPrompt` may contain includes) and its own `promptGenerator` (whose `dataFile` and includes are config-relative). Agent normalization lives in [src/util/load-cli-config.ts](../../src/util/load-cli-config.ts) (`normalizeAgentSpec`), not in the generator module, so pipeline normalization is done there too. `normalizeCliConfig` detects a pipeline and, for each step, applies the same two transforms it already applies at the top level: `normalizeAgentSpec(step.agent ?? topLevelAgent, configDir)` and `normalizePromptGeneratorSpec(step.promptGenerator, { configDir })`. `runPipeline` then only merges and calls `loop()`; it performs no normalization itself, which keeps it pure orchestration and easy to test with the `test` agent.

## DAG model, validation, and execution

A pipeline is `{ steps: Record<string, PipelineStep> }` where `PipelineStep` is `Omit<LoopCliConfig, "name">` plus an optional `dependsOn: Array<string>`. Step identity is the object key. The required terminal node is the key named `output`.

All validation runs at startup, before any step's `loop()` runs, so a malformed graph fails fast rather than after expensive steps:

- `steps` is a non-empty object.
- A step named `output` exists.
- Every `dependsOn` entry names an existing step.
- No step depends on itself.
- No cycles (depth-first three-color walk from `output`; a back-edge to a gray node is a cycle, reported as a path).
- Duplicate names cannot occur because they are object keys, so there is no duplicate check.
- A step not reachable from `output` is warned about, not failed. Someone may be mid-edit, and failing is too strict.

Execution is a topological sort of the DAG rooted at `output`: walk dependencies first, run each step's `loop()` to completion, then move to the next.

This is the place to correct the original sketch. It argued the pipeline must run in "pull mode" because a push model cannot decide how many step-one loops to run. Under the orchestrator design that concern does not arise. Each step is a single loop that runs over all of its input. The review step runs once; its `per-file` generator fans out over every matching file inside that one run. Fan-in is the same: the output step runs once and its generator reads one or more upstream files and yields prompts from them. So the number of loops per step is always one, and "pull from output" means nothing more than topologically ordering the DAG so that when a downstream step opens an upstream file, that file is already complete. There is no laziness and no dynamic step instantiation. The only flow that genuinely does not fit a DAG is conditional re-routing, which is out of scope (see below).

One sharp edge the DAG cannot catch: `dependsOn` declares ordering, it does not wire data. A step can declare `dependsOn: ["review"]` while its generator reads some other file or re-globs the filesystem, and nothing will complain. Authors must point each consuming step's generator at the right upstream file themselves.

## Inter-step handoff and the reader generators

A downstream step reads an upstream step's output file. For the first version, files are named by the deterministic convention `${pipelineName}-${stepKey}-report.{ext}` and `${pipelineName}-${stepKey}-loop-state.json`, and the consuming step names that path directly in its generator config (as the example does with `fix-bugs-review-report.jsonl`).

The alternative, an injected template variable such as `{{steps.review.report}}`, is deferred. It would require a new substitution pass over generator config fields like `dataFile`, which does not exist today (current `{{...}}` substitution happens only inside prompt strings at generate time). The deterministic-filename approach needs no new machinery. Its cost is coupling: renaming the pipeline or a step silently breaks the wiring, and the consuming generator throws when it cannot find the file. That coupling, plus an `outputDir` resolution asymmetry described under Risks, is the motivation to add the injected variable in a later phase.

### The jsonl generator

A new generator named `jsonl` (file `src/prompt-generators/jsonl.ts`). It is distinct from the existing `json` generator: `json` does one whole-file `JSON.parse` and reads a single JSON value, whereas a JSONL report file ([src/reporters/jsonl.ts](../../src/reporters/jsonl.ts)) is one JSON object per line. The `jsonl` generator reads line by line.

Config (`JsonlTask`):

- `dataFile` (required): path to the JSONL file, resolved relative to the config directory.
- `promptTemplate` (required): the same `{{field}}` and `{{include:}}` model as `json`.
- `idField` (optional): the line field to use as the prompt id, defaulting to the line's `id` field. Report lines always carry `id` because they are `{...prompt, ...result}`.
- `filter` (optional): for example `{ "status": "success" }`. Because a report line carries `status`, this routes only successful (or only failed) upstream items forward, which is the headline pipeline use case ("proceed on successes, retry failures").

Each line's top-level fields become template variables, plus `{{id}}` and `{{index}}`. Since a report line includes `output`, `structuredOutput`, `status`, and (once cost-accounting lands) `cost`, a downstream prompt can embed the upstream output directly. Object-valued fields such as `structuredOutput` are stringified with `JSON.stringify`. Duplicate ids and the `loopState.isOutstanding(id)` resume gate work as in `json`. A malformed line throws with its line number rather than being silently dropped.

### The loop-state generator

A new generator named `loop-state` (file `src/prompt-generators/loop-state.ts`). It reads a `*-loop-state.json` file and yields prompts derived from per-id outcomes. It is for status-based routing without needing the full report, for example "emit one prompt per succeeded id" or "re-run every failed id."

Config (`LoopStateTask`):

- `stateFile` (required): path to the loop-state JSON, config-relative.
- `promptTemplate` (required).
- `select` (optional): `completed`, `failed`, or `all`. Default `completed`, the safe choice for forward progress.

Template variables per entry are `{{id}}`, `{{status}}`, and `{{reason}}` when failed. It cannot provide `output` or `structuredOutput`, because the loop-state file deliberately does not store them (cost-accounting.md keeps outcomes slim for size; the reporter already holds the full result). Use `loop-state` for status and routing, and `jsonl` when the upstream output text is needed.

The reader must tolerate both loop-state shapes, because this plan and cost-accounting.md can land in either order. The current shape ([src/util/loop-state.ts](../../src/util/loop-state.ts)) is `{ completed: [], failed: [], inProgress? }`; the cost-accounting.md shape is `{ results: Record<id, {status, reason?, cost?}>, inProgress?, totalUsd? }`. If `results` is present, derive completed and failed from it; otherwise read the arrays. The reader parses the file independently rather than going through `LoopState`, so it is not coupled to whichever shape the class currently writes. It ignores `inProgress`, so the array-versus-map change in [remote-loop-state.md](./remote-loop-state.md) does not affect it.

Both readers gate yielded ids through `loopState.isOutstanding(id)` so the consuming step is itself resumable. Note that the consuming step's own state file is a different file from the upstream state file it reads as data; there is no conflict, but the two-files distinction is worth keeping in mind.

## Error, abort, and resume

`loop()` returns a status string and, on three conditions (an error result, too many consecutive glitches, or reaching `maxPrompts`), returns early. It throws in one case only: a dirty working tree when `allowSourceUpdate` is true. So `runPipeline` cannot tell "completed" from "aborted" by catching; it inspects the return and the step's loop-state file.

The default policy is strict: if a step produced any failed outcome or aborted, the pipeline stops and returns an aggregate message naming the step; downstream steps do not run. The rationale is that the commit step depends on verify having succeeded, and running commit after verify failed is dangerous. A `continueOnFailure` escape hatch is deferred.

Detecting abort by inspecting a return string is fragile, and is the main piece of technical debt in the first version. The follow-up, once concurrency.md and cost-accounting.md have landed, is to give `loop()` a structured return such as `{ status: "done" | "aborted", reason? }` and have `runPipeline` branch on that.

Resume needs no new state file. Each step already resumes from its own loop-state, and a generator skips non-outstanding ids. So pipeline resume is simply "re-run every step in topological order"; a fully completed step fast-forwards because its generator yields nothing and `loop()` returns immediately. The only waste is re-reading upstream files, which is negligible. A pipeline-state index file is a possible later optimization for pipelines with very many already-completed steps.

`maxPrompts` and `interPromptPause` are consumed inside `loopImpl` and there is no shared counter across `loop()` calls, so both are per step by inheritance. A top-level `maxPrompts: 100` caps each step at 100, not the pipeline at 100. This is worth stating because users will expect a pipeline-wide cap. A pipeline-wide cap (and, once cost-accounting lands, a pipeline-wide budget) is deferred; it would require threading a shared budget through each `loop()` call.

## Phasing

Phase 1: the two reader generators. Fully independent and shippable alone. A user can run an ordinary loop whose generator reads a previous run's report. No orchestrator and no dependency on concurrency.md.

Phase 2: the sequential orchestrator. `isPipelineSpec`, `runPipeline`, the `createPromptGenerator` guard, pipeline normalization in `load-cli-config.ts`, DAG validation and topological sort, per-step execution, the strict abort policy, resume by re-run, and the schema for the pipeline tuple and step. One step at a time, no parallelism. Depends on Phase 1 for the handoff, and on nothing in concurrency.md. This is the core feature.

Phase 3: within-step concurrency. A step sets `concurrency: N`, which flows straight into that step's `loop()`. This becomes available the moment concurrency.md lands, with no pipeline-specific work, because `concurrency` is just another inherited field. A step that sets `allowSourceUpdate: true` cannot set `concurrency > 1`, but that rejection already lives inside `loop()` per concurrency.md, so it comes for free. Hard dependency on concurrency.md, trivial integration.

Phase 4: cross-branch parallelism. The orchestrator runs independent branches of the DAG concurrently: maintain a ready-set of steps whose dependencies are complete and run up to K at once. This is the only part needing real scheduling, and it is where concurrency.md's safety rules apply at the pipeline level. Because git commits cannot interleave, any `allowSourceUpdate` step must run alone (a global barrier), since even a non-commit step's agent could leave the tree dirty. Hard dependency on concurrency.md, and the scheduling plus git-safety reasoning is genuinely new work. Optional and deferrable; sequential pipelines are fully functional without it.

Phases 1 and 2 are the deliverable. Phase 3 is a freebie after concurrency lands. Phase 4 is a stretch goal gated on concurrency.md.

## Interaction with other planned work

[concurrency.md](./concurrency.md): soft, becoming a hard dependency only for Phases 3 and 4. Sequential pipelines need nothing from it. Within-step concurrency is a pass-through that inherits concurrency.md's refusal of `allowSourceUpdate` plus concurrency and of the `batch` generator plus concurrency. Cross-branch parallelism must extend that reasoning to serialize source-mutating steps. Its change of `inProgress` from a string to an array does not affect the `loop-state` reader, which ignores `inProgress`.

[cost-accounting.md](./cost-accounting.md): soft, with one mandatory integration point. The `jsonl` reader surfaces `cost` for free, because report lines spread the result and cost-accounting adds `cost` to that spread. The `loop-state` reader must tolerate cost-accounting's `results` record shape; that dual-shape parse is required regardless of land order. A pipeline-wide budget is the real gap, since cost-accounting persists `totalUsd` per step state file, so per-step budgets work by inheritance but a pipeline-wide cap needs aggregation across step files; deferred.

[remote-loop-state.md](./remote-loop-state.md): mostly independent. It changes the loop-state backend and the `inProgress` shape, neither of which affects the readers (they ignore `inProgress` and keep reading `completed` and `failed`). One caveat: the readers read a local file with `readFile`, so a step whose state lives in S3 cannot be read this way. The first version documents that readers require local files (the common case where all steps share a local `outputDir`); S3-backed handoff is future work and would route the reader through the pluggable state loader.

[doctor-flag.md](./doctor-flag.md): independent, with an easy bonus. When doctor lands, the two readers implement its optional `check()` to verify their `dataFile` or `stateFile` exists, mirroring the `json` generator's check. A natural later extension of `--doctor` is validating the DAG and running each step's component checks, but that is additive.

[dashboard.md](./dashboard.md): independent and downstream. A pipeline produces one report and one state file per step, and the `${pipelineName}-${stepKey}-*` naming convention makes those easy for a future dashboard to aggregate.

## Schema changes

In [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json):

- Add a `pipeline` tuple to `promptGeneratorSpec.oneOf` referencing a new `pipelineTask`.
- Add `pipelineTask` requiring a non-empty `steps` object whose values reference a new `pipelineStep`.
- Add `pipelineStep`: required `promptGenerator`, plus optional `dependsOn`, `agent`, `reporter`, `outputDir`, `maxPrompts`, `interPromptPause`, `allowSourceUpdate`, and `logger`. Its `promptGenerator` references `promptGeneratorSpec`, which now includes the `pipeline` tuple, so the schema structurally permits nested pipelines. The runtime guard rejects them. Forbidding nesting only at depth two would mean duplicating the whole generator union; the recommendation is to allow it in the schema and reject at runtime with a clear error, documenting that nested pipelines are unsupported.
- Add `jsonl` and `loop-state` tuples to `promptGeneratorSpec.oneOf`, with `jsonlTask` (required `dataFile`, `promptTemplate`; optional `idField`, `filter`) and `loopStateTask` (required `stateFile`, `promptTemplate`; optional `select`), modeled on `jsonTask`.
- Add example configs under `src/examples/` so the existing schema test, which validates every example, exercises the new shapes.

Per AGENTS.md the schema moves in lockstep with the runtime types, so the types and schema land in the same change.

## Files to modify

New:

- `src/pipeline.ts`: `isPipelineSpec`, `runPipeline`, DAG validation and topological sort, per-step config synthesis, abort and resume policy.
- `src/prompt-generators/jsonl.ts`: `JsonlTask`, `normalizeJsonlTaskConfig`, `JsonlPromptGenerator`.
- `src/prompt-generators/loop-state.ts`: `LoopStateTask`, `normalizeLoopStateTaskConfig`, `LoopStatePromptGenerator` with the dual-shape parse.
- Tests: `src/__test__/pipeline.test.ts`, `src/prompt-generators/__test__/jsonl.test.ts`, `src/prompt-generators/__test__/loop-state.test.ts`.
- Example configs under `src/examples/`.

Modified:

- [src/cli.ts](../../src/cli.ts): branch to `runPipeline` via `isPipelineSpec`.
- [src/types.ts](../../src/types.ts): `PipelineTask` and `PipelineStep`.
- [src/prompt-generators.ts](../../src/prompt-generators.ts): register `jsonl` and `loop-state`; add their normalize branches; add the `pipeline` guard in `createPromptGenerator` and a `pipeline` branch in `normalizePromptGeneratorSpec`.
- [src/util/load-cli-config.ts](../../src/util/load-cli-config.ts): detect a pipeline in `normalizeCliConfig` and normalize each step's agent and generator; apply the `--dry-run` agent swap across steps.
- [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json): the pipeline tuple, `pipelineTask`, `pipelineStep`, `jsonlTask`, `loopStateTask`, and the two reader tuples.

## Tests

Reader generators (mirroring the `json` generator tests):

- `jsonl`: reads multiple lines into prompts; `idField` default of `id` and an override; the `status` filter; object fields stringified with `JSON.stringify`; duplicate id throws; `isOutstanding` skip on resume; malformed line throws with its line number; trailing blank lines ignored; missing file behavior (the chosen empty-versus-throw policy).
- `loop-state`: reads the old shape (`completed`, `failed`); reads the cost-accounting `results` shape; `select` of `completed`, `failed`, and `all`; `{{reason}}` present only for failed; `isOutstanding` skip on resume.

Orchestrator (`runPipeline`, with the `test` agent so no real backend is hit):

- A linear two-step pipeline runs both steps in order; the downstream `jsonl` step reads the upstream report.
- Fan-in: an `output` step reading two upstream reports.
- Validation: missing `output`, a `dependsOn` to an unknown step, a self-dependency, and a cycle each fail at startup with the expected message; an unreachable step warns but does not fail.
- Per-step overrides: a step's `agent` and `allowSourceUpdate` override the top-level defaults; step names produce `${pipelineName}-${stepKey}` report and state files.
- Abort: a step that produces a failed outcome stops the pipeline under the strict policy and downstream steps do not run.
- Resume: re-running a partially complete pipeline fast-forwards completed steps.
- Dry-run: `--dry-run` swaps every step's agent for the canned test agent.
- The `createPromptGenerator` guard throws on a pipeline spec (including a nested pipeline).

Schema:

- A pipeline config validates; the two reader tuples validate; a `pipelineStep` missing `promptGenerator` fails.

100% coverage is maintained per AGENTS.md.

## Out of scope

- Conditional routing and in-pipeline cycles (a verify step sending work back to fix). A reader generator can partially emulate it across separate runs (re-emitting failed ids), but true cycles are a separate feature.
- A first-class queue subsystem. Handoff uses report and state files read by the two generators.
- Pipeline-wide `maxPrompts` and `maxBudgetUsd`. Both are per step by inheritance in the first version.
- Nested pipelines. Permitted by the schema's recursion but rejected at runtime.
- Cross-branch parallelism (Phase 4) and a pipeline-state index file.
- The injected `{{steps.*.report}}` handoff variable. Deterministic filenames are used first.
- S3-backed handoff between steps. Readers require local files for now.

## Verification

1. `pnpm tsc && pnpm test` pass; `pnpm lint` clean; `pnpm format` no diff.
2. Reader generators in isolation: an ordinary loop config whose generator is `jsonl` pointed at a hand-written JSONL file yields the expected prompts under `--dry-run`; the same for `loop-state` against a hand-written state file in both the old and the `results` shapes.
3. A two-step pipeline (`review` then `output`) with the `test` agent and `jsonl-report`: confirm `fix-bugs-review-report.jsonl` is written, that `output` reads it, and that `fix-bugs-output-report.jsonl` is the final artifact.
4. Per-step override: a `verify` step with a different agent uses that agent; a `commit` step with `allowSourceUpdate: true` requires a clean tree and commits, while earlier steps do not.
5. Validation: configs with a missing `output`, an unknown `dependsOn`, and a cycle each fail at startup with a clear message before any step runs.
6. Resume: interrupt a pipeline mid-step, re-run, and confirm completed steps fast-forward and the interrupted step continues from its loop-state.
7. Dry-run: `--dry-run` against a multi-step pipeline invokes no real agent for any step.

## Risks and open questions

- `loop()` returns a string rather than a structured status, so abort detection is fragile. This is the main technical debt; the follow-up is a structured return once concurrency.md and cost-accounting.md land.
- Reader file-not-found. A step that yields zero prompts never creates a report file (the reporter creates the directory eagerly but the file lazily on first append), so a downstream reader can hit a missing file. Decision to confirm: treat a missing report as empty (yield nothing) but throw on a present-but-malformed file.
- The `dataFile` and `stateFile` paths are config-relative while report files are `outputDir`-relative. When `outputDir` is omitted the two coincide and wiring just works; when `outputDir` is set, the reader path must include it. This asymmetry is a footgun and is the strongest argument for the future injected-variable handoff.
- No `${pipelineName}-report.{ext}` file exists, because every loop runs under `${pipelineName}-${stepKey}`. Users expecting the top-level name to produce the main report should look at the `output` step's report instead.
- Dry-run must swap every step's agent, not just a top-level one. The swap currently lives in `loadCliConfig` and only touches the top-level agent; it must descend into steps when the config is a pipeline.
- Ordering hazard with `allowSourceUpdate`. Only the commit step should touch source. If an earlier step leaves the tree dirty, the commit step's clean-tree precondition throws.
- There is no pause between steps; the inter-prompt pause is intra-loop only. Back-to-back steps against the same rate-limited backend fire immediately. Probably fine; noted.
- Nested pipelines, single-step pipelines, and source steps with no `dependsOn` are all decided: nesting rejected at runtime, a single `output` step is legal and useful as a thin wrapper, and a step nothing reaches from `output` warns rather than fails.
