# Step 06 Pipelines with Routing and Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a named set of loop steps that hand off through reader generators, with pull-based verdict routing and bounded rework loops, per-step config overrides, and strict failure handling. Steps run sequentially within a pass and the pipeline runs to a fixed point.

**Architecture:** A pipeline lives in the `promptGenerator` slot as `["pipeline", { output, steps, maxPasses? }]`. It is detected by `isPipelineSpec` and dispatched at the CLI entry to a new `runPipeline` in `src/pipeline.ts` rather than `loop()`, so the single-loop path is byte-for-byte unchanged. `runPipeline` synthesises a complete `LoopCliConfig` per step and calls `loop()` once per step per pass, repeating passes until a whole pass records zero new terminal outcomes anywhere. Routing is emergent and pull-based: a producing step emits a verdict in `structuredOutput`, and each consuming step's `jsonl` reader filters on it. Rework re-enters work via attempt-scoped ids, bounded by per-reader `maxAttempts`/`minAttempts`. Fan-in is homogeneous: the `jsonl` reader's `dataFile` accepts an array of report paths read in sequence.

**Tech Stack:** TypeScript (strict, ESM, `exactOptionalPropertyTypes`), vitest, ajv (schema test), pnpm. Coverage gate is 100% on non-ignored files; every new branch needs a test.

---

## Carry-over contract from Step 05

Read `docs/future-plans/next.md` and `docs/future-plans/conditional-routing-design.md` before starting. The load-bearing facts and the decisions this plan locks in:

- The two reader generators (`jsonl`, `loop-state`) already exist and carry the routing primitives: field-path equality `filter` (including `structuredOutput.*`), and the attempt knobs `maxAttempts`, `minAttempts`, `incrementAttempt` (on `jsonl` only). `loop-state` cannot route on a verdict. Step 06 composes these readers; it does not change the attempt or filter logic.
- `{{steps.<name>.report}}` resolves to `<outputDir>/<name>-report.jsonl` and `{{steps.<name>.state}}` to `<outputDir>/<name>-loop-state.json` via `resolveStepHandoff(value, outputDir)` in `src/prompt-generators/util/handoff.ts`. The substitution runs inside `normalizePromptGeneratorSpec`, which reads `outputDir` from the `PromptGeneratorConfigContext`.
- **The biggest gotcha (next.md lines 18-32):** inside a pipeline, each step's loop `name` is the derived `${pipelineName}-${stepKey}`, so step `review` in pipeline `bugfix` writes `bugfix-review-report.jsonl`, not `review-report.jsonl`. But config authors write the bare step key in markers (`{{steps.review.report}}`). This plan reconciles them by threading a `stepKeyToName` mapper through the normalization context (next.md option 2): `resolveStepHandoff` gains an optional name mapper, and the pipeline normalizer passes `(k) => `${pipelineName}-${k}``. The default mapper is identity, so the standalone (non-pipeline) loop path is unchanged.
- A missing `dataFile`/`stateFile` is empty input; a present-but-malformed file is an error. A `jsonl` reader pointed at a `.yaml`/`.yml` path fails with a format-mismatch message. Because handoff always resolves to a `.jsonl` filename, a producer left on the default `yaml-report` writes `*-report.yaml` while its consumer reads `*-report.jsonl`, which the format-mismatch guard does not catch (the resolved path ends in `.jsonl`); the consumer silently reads empty. This is why Step 06 adds a startup reporter/handoff contract check.

## Design decisions locked in by this plan

1. **Fan-in is homogeneous via `jsonl` `dataFile` arrays (decided with the user).** `dataFile` accepts a `string` or a `ReadonlyArray<string>`; arrays are read in sequence and concatenated, sharing one `filter`/`promptTemplate`. The implemented `batch` generator (single source + summary injection) is NOT used or changed for fan-in.

2. **Heterogeneous fan-in is decomposed into separate steps.** The design sketch's single `fix` step that batches two differently-filtered sources (new bugs + rework) is replaced by two steps, `fix-new` and `fix-rework`, whose reports `verify` fans in over homogeneously. This expresses the identical rework loop using only homogeneous fan-in, so no batch-with-multiple-sources capability is needed. The worked example and `next.md` are updated to this topology in Section 5.

3. **Normalization is split by sync/async need.** All per-step normalization lives in `normalizeCliConfig` via a new async `normalizePipelineSpec` helper, because per-step agents need async `{{include:...}}` resolution and the `--dry-run` swap must descend into steps. The sync per-step generator normalization is delegated to the existing `normalizePromptGeneratorSpec` (with a `stepKeyToName` context). `normalizePromptGeneratorSpec`'s `pipeline` branch only throws (nested pipelines unsupported); top-level pipelines bypass it via `normalizeCliConfig`.

4. **Fixed point is detected by counting terminal outcomes across all steps' state files.** Before pass 1 the orchestrator records the total `results` count across every step's `*-loop-state.json`. After each full pass it recounts; an unchanged total means zero new outcomes, i.e. a fixed point, and the pipeline completes. `maxPasses` (default 100, configurable) is the backstop.

5. **Strict failure policy: any non-`completed` step result stops the pipeline.** If a step's `LoopRunResult.status !== 'completed'` (a failure or a controlled abort such as `maxPrompts`/`maxBudgetUsd`), `runPipeline` returns that result annotated with the step name; downstream steps do not run. An `error`/`glitch` that no sink consumes therefore stops the pipeline.

6. **Per-step config is a shallow merge:** top-level defaults, then the step's own fields, then a derived `name`. Inherited fields are exactly `agent`, `reporter`, `outputDir`, `allowSourceUpdate`, `maxPrompts`, `interPromptPause`, `logger` (per the step-06 doc). `maxBudgetUsd` and `concurrency` are NOT threaded per step (pipeline-wide budget is Step 07; cross-step parallelism is Step 08).

7. **`dependsOn` is an optional, cycle-tolerant ordering hint.** Validation only checks that each entry names an existing step. Execution order is a greedy dependency-respecting order that falls back to config order when a cycle would otherwise stall it. Because convergence is order-independent, this only affects how many passes are needed, never correctness.

## File structure

Created:

- `src/pipeline-spec.ts` - pure pipeline detection, validation, and the reporter/handoff contract check. No I/O, no `loop` import. `PIPELINE_GENERATOR_NAME`, `isPipelineSpec`, `normalizePipelineTaskConfig`, `assertReporterHandoffContract`, `collectReportConsumers`.
- `src/__test__/pipeline-spec.test.ts` - unit tests for the spec module.
- `src/pipeline.ts` - `runPipeline`, per-step config synthesis, fixed-point passes, dependency ordering, strict failure policy. Imports `loop`.
- `src/__test__/pipeline.test.ts` - integration tests driven by the `test` agent.
- `src/examples/pipeline/bugfix.json` - worked rework pipeline (review -> fix-new/fix-rework -> verify -> commit/giveup -> summary).
- `src/examples/pipeline/README.md` - note describing the example and topology.

Modified:

- `src/types.ts` - add `PipelineStep` and `PipelineTask`; add `'maxPasses'` to `LoopRunResult.reason`.
- `src/prompt-generators/jsonl.ts` - accept `dataFile: string | ReadonlyArray<string>`; read multiple files in sequence.
- `src/prompt-generators/util/handoff.ts` - `resolveStepHandoff` gains an optional name mapper.
- `src/prompt-generators/util/config.ts` - add optional `stepKeyToName` to `PromptGeneratorConfigContext`.
- `src/prompt-generators.ts` - `pipeline` guard in `createPromptGenerator`; `pipeline` branch (throw) in `normalizePromptGeneratorSpec`; thread `stepKeyToName` through the `jsonl`/`loop-state` branches and over array `dataFile`s.
- `src/util/load-cli-config.ts` - `normalizePipelineSpec`; detect a pipeline in `normalizeCliConfig`; thread `--dry-run` into per-step agent swaps.
- `src/cli.ts` - branch to `runPipeline` via `isPipelineSpec`; reject `--doctor` on a pipeline with a clear message.
- `schema/loop-the-loop.schema.json` - the `pipeline` tuple, `pipelineTask`, `pipelineStep`; `jsonlTask.dataFile` accepts an array.
- `src/__test__/schema.test.ts` - positive and negative pipeline cases; array-`dataFile` jsonl case.
- `src/prompt-generators/__test__/jsonl.test.ts` - array `dataFile` cases.
- `src/prompt-generators/__test__/prompt-generators.test.ts` - guard and nested-pipeline normalize throw.
- `src/util/__test__/load-cli-config.test.ts` - pipeline normalization integration cases.
- `src/prompt-generators/util/__test__/handoff.test.ts` - name-mapper case.
- `README.md` - "Pipelines" section.

## Execution and commit protocol

Each section below is self-contained and ends with a commit. Sections are ordered so the build stays green (`pnpm tsc && pnpm test --coverage` clean, 100% coverage) after every commit. Dispatch one fresh sub-agent per section. Between sections the orchestrator runs the completion gate and reviews the diff before starting the next section.

Per AGENTS.md: stay on the `main` branch, do not open PRs, never run `git add`/`git mv`/`git rm` outside the commit step, use the default `~/.gitconfig` author, and do NOT add a `Co-Authored-By` trailer. Commit message tags follow recent history (`Feature:`, `Fix:`, `Docs:`). Before each commit run `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`.

Section ordering rationale: the fan-in primitive (Section 1) is an isolated `jsonl` extension with no pipeline dependency, so it lands first and independently. The pure spec module (Section 2) adds validation, schema, and guards with no runtime wiring, keeping the tree green. Normalization (Section 3) layers per-step transforms on top of the spec module. The orchestrator and CLI dispatch (Section 4) consume everything prior. Examples and docs (Section 5) come last, once the schema and runtime support pipelines end-to-end.

---

## Section 1: Homogeneous fan-in via `jsonl` `dataFile` arrays

Extend the `jsonl` reader so `dataFile` may be a single path or an array of paths read in sequence. This is the only fan-in mechanism Step 06 needs; the pipeline `verify` and `summary` steps use it.

**Files:**

- Modify: `src/prompt-generators/jsonl.ts`, `schema/loop-the-loop.schema.json`, `src/prompt-generators.ts`
- Test: `src/prompt-generators/__test__/jsonl.test.ts`, `src/__test__/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these cases to the `describe('JsonlPromptGenerator', ...)` block in `src/prompt-generators/__test__/jsonl.test.ts` (the `writeLines` and `collect` helpers already exist there):

```ts
  it('reads multiple data files in sequence', async () => {
    const a = await writeLines('a.jsonl', [{ id: 'a', status: 'success' }]);
    const b = await writeLines('b.jsonl', [{ id: 'b', status: 'success' }]);
    const prompts = await collect({
      dataFile: [a, b],
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('treats a missing file in the array as empty input', async () => {
    const a = await writeLines('a.jsonl', [{ id: 'a', status: 'success' }]);
    const prompts = await collect({
      dataFile: [a, 'absent.jsonl'],
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a']);
  });

  it('detects a duplicate id across files', async () => {
    const a = await writeLines('a.jsonl', [{ id: 'dup' }]);
    const b = await writeLines('b.jsonl', [{ id: 'dup' }]);
    await expect(
      collect({ dataFile: [a, b], promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/duplicate id "dup"/u);
  });

  it('continues index numbering across files', async () => {
    const a = await writeLines('a.jsonl', [{ status: 'success' }]);
    const b = await writeLines('b.jsonl', [{ status: 'success' }]);
    const prompts = await collect({
      dataFile: [a, b],
      promptTemplate: '{{index}}',
    });
    expect(prompts.map(p => p.prompt)).toEqual(['0', '1']);
  });
```

Add to the `describe('normalizeJsonlTaskConfig', ...)` block:

```ts
  it('accepts an array dataFile', () => {
    const task = normalizeJsonlTaskConfig({
      dataFile: ['a.jsonl', 'b.jsonl'],
      promptTemplate: '{{id}}',
    });
    expect(task.dataFile).toEqual(['a.jsonl', 'b.jsonl']);
  });

  it('rejects a dataFile array containing a non-string', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: ['a.jsonl', 7],
        promptTemplate: '{{id}}',
      }),
    ).toThrow('jsonl.dataFile must be a string or an array of strings');
  });

  it('rejects a non-string non-array dataFile', () => {
    expect(() =>
      normalizeJsonlTaskConfig({ dataFile: 7, promptTemplate: '{{id}}' }),
    ).toThrow('jsonl.dataFile must be a string or an array of strings');
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/prompt-generators/__test__/jsonl.test.ts`
Expected: FAIL - array `dataFile` not yet supported.

- [ ] **Step 3: Update `src/prompt-generators/jsonl.ts`**

Change the `dataFile` field type in `JsonlTask`:

```ts
  /**
   * Path or paths to JSONL files, config-relative or `{{steps.<name>.report}}`
   * handoff substitutions. An array is read in sequence (homogeneous fan-in),
   * sharing the same filter and template. A missing file is empty input.
   */
  dataFile: string | ReadonlyArray<string>;
```

Replace the body of `generate` that resolves and loads a single file. The single-file loader becomes a multi-file loader that keeps one continuous line index and one shared `seenIds` map. Replace the `const filePath = resolve(...)` / `const entries = await loadLines(filePath)` lines with:

```ts
    const files = Array.isArray(this.#task.dataFile)
      ? this.#task.dataFile
      : [this.#task.dataFile];
    const entries: Array<JsonlLine> = [];
    for (const file of files) {
      const filePath = resolve(this.#basePath, file);
      entries.push(...(await loadLines(filePath)));
    }
    const seenIds = new Map<string, number>();
```

Note: `JsonlLine.lineNumber` is per-file (used only in error messages); the loop `index` already runs across the concatenated `entries`, so index numbering and duplicate detection span files. The existing duplicate-id error already names the line; to keep messages unambiguous across files, leave `lineNumber` as the per-file number (acceptable; the id is the unique key).

Update `assertJsonlTaskConfig`: replace the `assertRequiredString(value, 'dataFile', 'jsonl.dataFile')` call with:

```ts
  assertDataFile(value);
```

and add this helper near the other asserts in the file:

```ts
/**
 * Assert `dataFile` is a string or an array of strings. An array enables
 * homogeneous fan-in across several reports.
 */
function assertDataFile(value: Record<string, unknown>): void {
  const dataFile = value['dataFile'];
  const ok =
    typeof dataFile === 'string' ||
    (Array.isArray(dataFile) && dataFile.every(v => typeof v === 'string'));
  if (!ok) {
    throw new Error('jsonl.dataFile must be a string or an array of strings');
  }
}
```

- [ ] **Step 4: Update the `jsonl` normalize branch in `src/prompt-generators.ts`**

The branch currently resolves a single `dataFile` via `resolveStepHandoff`. Make it map over an array:

```ts
  if (type === JsonlPromptGenerator.promptGeneratorName) {
    const task = normalizeJsonlTaskConfig(config);
    const dataFile = Array.isArray(task.dataFile)
      ? task.dataFile.map(file => resolveStepHandoff(file, outputDir))
      : resolveStepHandoff(task.dataFile, outputDir);
    return [type, { ...task, dataFile }, configDir];
  }
```

(The `stepKeyToName` mapper is added to `resolveStepHandoff` in Section 3; this section keeps the two-argument call.)

- [ ] **Step 5: Update the schema**

In `schema/loop-the-loop.schema.json`, change `jsonlTask.dataFile` (around line 869) from a plain string to:

```json
        "dataFile": {
          "anyOf": [
            { "type": "string" },
            { "type": "array", "items": { "type": "string" }, "minItems": 1 }
          ],
          "description": "Path or paths to JSONL files. Config-relative, or {{steps.<name>.report}} handoff substitutions. An array is read in sequence for homogeneous fan-in. A missing file is treated as empty input."
        },
```

Add a positive case to `src/__test__/schema.test.ts` (in the positive-cases array):

```ts
      [
        'jsonl reader with array dataFile',
        {
          name: 'fan-in',
          agent: 'claude-sdk',
          reporter: 'jsonl-report',
          promptGenerator: [
            'jsonl',
            {
              dataFile: ['a-report.jsonl', 'b-report.jsonl'],
              promptTemplate: 'Summarize {{id}}',
            },
          ],
        },
      ],
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm test src/prompt-generators/__test__/jsonl.test.ts src/__test__/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `jsonl.ts` at 100% (single-file, multi-file, missing-in-array, cross-file dup, array/non-array normalize branches all covered).

- [ ] **Step 8: Commit**

```bash
git add src/prompt-generators/jsonl.ts src/prompt-generators/__test__/jsonl.test.ts src/prompt-generators.ts schema/loop-the-loop.schema.json src/__test__/schema.test.ts
git commit -m "Feature: Support multiple dataFiles in the jsonl reader for pipeline fan-in"
```

---

## Section 2: Pipeline spec module (types, validation, schema, guards)

A pure module that defines the pipeline types, detects a pipeline spec, validates it, and checks the reporter/handoff contract. No runtime wiring yet, so the tree stays green.

**Files:**

- Create: `src/pipeline-spec.ts`, `src/__test__/pipeline-spec.test.ts`
- Modify: `src/types.ts`, `src/prompt-generators.ts`, `schema/loop-the-loop.schema.json`, `src/__test__/schema.test.ts`, `src/prompt-generators/__test__/prompt-generators.test.ts`

- [ ] **Step 1: Add the pipeline types to `src/types.ts`**

Add `'maxPasses'` to the `LoopRunResult.reason` union:

```ts
  readonly reason?:
    | 'maxPrompts'
    | 'maxBudgetUsd'
    | 'errorResult'
    | 'tooManyGlitches'
    | 'maxPasses';
```

Append these interfaces at the end of `src/types.ts` (the file already imports `AgentSpec`, `LoggerSpec`, `PromptGeneratorSpec`, `ReporterSpec`):

```ts
/**
 * One step of a pipeline. A step is one `loop()` over one prompt generator.
 * `promptGenerator` is required; every other field overrides the pipeline-level
 * default for this step only. `dependsOn` is an optional, cycle-tolerant
 * ordering hint within a pass and never a correctness constraint.
 */
export interface PipelineStep {
  readonly promptGenerator: PromptGeneratorSpec;
  readonly agent?: AgentSpec;
  readonly reporter?: ReporterSpec;
  readonly outputDir?: string;
  readonly allowSourceUpdate?: boolean;
  readonly maxPrompts?: number;
  readonly interPromptPause?: number;
  readonly logger?: LoggerSpec;
  readonly dependsOn?: ReadonlyArray<string>;
}

/**
 * A pipeline: a set of named steps plus a designated terminal `output` step.
 * Not a DAG; cycles between steps are a supported feature (rework loops). Runs
 * to a fixed point, bounded by `maxPasses`.
 */
export interface PipelineTask {
  /**
   * Key of the terminal step. Identifies the final artifact for reporting; it
   * does not impose execution order. Must name an existing step.
   */
  readonly output: string;

  /**
   * The steps, keyed by step key. Non-empty. The loop name of each step is the
   * derived `${pipelineName}-${stepKey}`.
   */
  readonly steps: Readonly<Record<string, PipelineStep>>;

  /**
   * Safety ceiling on the number of fixed-point passes. Defaults to 100.
   */
  readonly maxPasses?: number;
}
```

- [ ] **Step 2: Write the failing spec-module test**

Create `src/__test__/pipeline-spec.test.ts`:

```ts
// @module-tag local

import {
  assertReporterHandoffContract,
  collectReportConsumers,
  isPipelineSpec,
  normalizePipelineTaskConfig,
  PIPELINE_GENERATOR_NAME,
} from 'loop-the-loop/pipeline-spec';
import type { PipelineTask } from 'loop-the-loop/types';
import { describe, expect, it } from 'vitest';

const MINIMAL = {
  output: 'a',
  steps: {
    a: { promptGenerator: ['test', { prompts: ['x'] }] },
  },
};

describe('isPipelineSpec', () => {
  it('detects a pipeline tuple', () => {
    expect(isPipelineSpec([PIPELINE_GENERATOR_NAME, MINIMAL])).toBe(true);
  });

  it('rejects other generator tuples and non-arrays', () => {
    expect(isPipelineSpec(['jsonl', {}])).toBe(false);
    expect(isPipelineSpec('jsonl')).toBe(false);
    expect(isPipelineSpec(undefined)).toBe(false);
  });
});

describe('normalizePipelineTaskConfig', () => {
  it('accepts a minimal pipeline', () => {
    expect(normalizePipelineTaskConfig(MINIMAL)).toEqual(MINIMAL);
  });

  it('rejects a non-object', () => {
    expect(() => normalizePipelineTaskConfig('x')).toThrow(
      'pipeline task config must be an object',
    );
  });

  it('rejects an unknown property', () => {
    expect(() =>
      normalizePipelineTaskConfig({ ...MINIMAL, nope: 1 }),
    ).toThrow('pipeline.nope is not supported');
  });

  it('rejects a missing or empty steps object', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'a', steps: {} }),
    ).toThrow('pipeline.steps must have at least one step');
  });

  it('rejects a step without a promptGenerator', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'a', steps: { a: {} } }),
    ).toThrow('pipeline.steps.a.promptGenerator is required');
  });

  it('rejects an unknown step property', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: { a: { promptGenerator: ['test', {}], nope: 1 } },
      }),
    ).toThrow('pipeline.steps.a.nope is not supported');
  });

  it('rejects a missing output step', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'z', steps: MINIMAL.steps }),
    ).toThrow('pipeline.output "z" is not a declared step');
  });

  it('rejects a dependsOn naming an unknown step', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: { promptGenerator: ['test', {}], dependsOn: ['ghost'] },
        },
      }),
    ).toThrow('pipeline.steps.a.dependsOn references unknown step "ghost"');
  });

  it('rejects a non-integer maxPasses', () => {
    expect(() =>
      normalizePipelineTaskConfig({ ...MINIMAL, maxPasses: 0 }),
    ).toThrow('pipeline.maxPasses must be a positive integer');
  });

  it('allows a cyclic dependsOn (rework is a feature)', () => {
    const cyclic = {
      output: 'fix',
      steps: {
        fix: { promptGenerator: ['test', {}], dependsOn: ['verify'] },
        verify: { promptGenerator: ['test', {}], dependsOn: ['fix'] },
      },
    };
    expect(() => normalizePipelineTaskConfig(cyclic)).not.toThrow();
  });
});

describe('collectReportConsumers', () => {
  it('finds report markers in a jsonl reader, including arrays', () => {
    const consumers = collectReportConsumers([
      'jsonl',
      {
        dataFile: ['{{steps.commit.report}}', '{{steps.giveup.report}}'],
        promptTemplate: '{{id}}',
      },
    ]);
    expect([...consumers].sort()).toEqual(['commit', 'giveup']);
  });

  it('ignores state markers and recurses into batch sources', () => {
    const consumers = collectReportConsumers([
      'batch',
      {
        source: ['jsonl', { dataFile: '{{steps.fix.report}}', promptTemplate: 'x' }],
        summaryPromptTemplate: 's',
        reportFile: 'r',
      },
    ]);
    expect([...consumers]).toEqual(['fix']);
    expect(
      collectReportConsumers([
        'loop-state',
        { stateFile: '{{steps.fix.state}}', promptTemplate: 'x' },
      ]).size,
    ).toBe(0);
  });
});

describe('assertReporterHandoffContract', () => {
  const task: PipelineTask = {
    output: 'commit',
    steps: {
      verify: {
        promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'x' }],
        reporter: 'jsonl-report',
      },
      commit: {
        promptGenerator: [
          'jsonl',
          { dataFile: '{{steps.verify.report}}', promptTemplate: 'x' },
        ],
      },
    },
  };

  it('passes when the consumed producer uses jsonl-report', () => {
    expect(() => assertReporterHandoffContract(task, 'jsonl-report')).not.toThrow();
  });

  it('rejects when the producer falls back to a non-jsonl reporter', () => {
    expect(() => assertReporterHandoffContract(task, 'default')).toThrow(
      /step "commit" reads \{\{steps\.verify\.report\}\}/u,
    );
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm test src/__test__/pipeline-spec.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/pipeline-spec`.

- [ ] **Step 4: Implement `src/pipeline-spec.ts`**

```ts
import type { PipelineStep, PipelineTask } from './types.js';
import {
  assertKnownProperties,
  isRecord,
} from './prompt-generators/util/config.js';

/**
 * The generator-spec name under which a pipeline is nested in the
 * `promptGenerator` slot: `["pipeline", PipelineTask]`.
 */
export const PIPELINE_GENERATOR_NAME = 'pipeline';

/**
 * Matches `{{steps.<name>.report}}` markers; used by the reporter/handoff
 * contract check, which runs on the raw (pre-substitution) config.
 */
const REPORT_MARKER = /\{\{steps\.([A-Za-z0-9_-]+)\.report\}\}/gu;

/**
 * Whether a prompt-generator spec is a pipeline tuple. Cheap structural check
 * used by the CLI to dispatch to `runPipeline` instead of `loop`.
 */
export function isPipelineSpec(spec: unknown): boolean {
  return Array.isArray(spec) && spec[0] === PIPELINE_GENERATOR_NAME;
}

/**
 * Validate the shape of a pipeline task config loaded from JSON: a non-empty
 * `steps` map, each step with a `promptGenerator`, a declared `output` step,
 * and `dependsOn` entries that name existing steps. Cycles are allowed.
 * Nested pipelines are not rejected here; `normalizePromptGeneratorSpec`
 * throws when a step generator is itself a pipeline.
 */
export function normalizePipelineTaskConfig(config: unknown): PipelineTask {
  if (!isRecord(config)) {
    throw new Error('pipeline task config must be an object');
  }
  assertKnownProperties(config, ['output', 'steps', 'maxPasses'], 'pipeline');

  if (typeof config['output'] !== 'string') {
    throw new Error('pipeline.output must be a string');
  }
  if (!isRecord(config['steps'])) {
    throw new Error('pipeline.steps must be an object');
  }
  const stepKeys = Object.keys(config['steps']);
  if (stepKeys.length === 0) {
    throw new Error('pipeline.steps must have at least one step');
  }
  for (const [key, step] of Object.entries(config['steps'])) {
    assertStep(key, step, stepKeys);
  }
  if (!stepKeys.includes(config['output'])) {
    throw new Error(
      `pipeline.output "${config['output']}" is not a declared step`,
    );
  }
  if ('maxPasses' in config) {
    const maxPasses = config['maxPasses'];
    if (
      typeof maxPasses !== 'number' ||
      !Number.isInteger(maxPasses) ||
      maxPasses < 1
    ) {
      throw new Error('pipeline.maxPasses must be a positive integer');
    }
  }
  return config as unknown as PipelineTask;
}

/**
 * Validate one step entry.
 */
function assertStep(
  key: string,
  step: unknown,
  stepKeys: ReadonlyArray<string>,
): void {
  if (!isRecord(step)) {
    throw new Error(`pipeline.steps.${key} must be an object`);
  }
  assertKnownProperties(
    step,
    [
      'promptGenerator',
      'agent',
      'reporter',
      'outputDir',
      'allowSourceUpdate',
      'maxPrompts',
      'interPromptPause',
      'logger',
      'dependsOn',
    ],
    `pipeline.steps.${key}`,
  );
  if (!('promptGenerator' in step)) {
    throw new Error(`pipeline.steps.${key}.promptGenerator is required`);
  }
  if ('dependsOn' in step) {
    const dependsOn = step['dependsOn'];
    if (!Array.isArray(dependsOn) || dependsOn.some(d => typeof d !== 'string')) {
      throw new Error(`pipeline.steps.${key}.dependsOn must be an array of strings`);
    }
    for (const dep of dependsOn) {
      if (!stepKeys.includes(dep)) {
        throw new Error(
          `pipeline.steps.${key}.dependsOn references unknown step "${dep}"`,
        );
      }
    }
  }
}

/**
 * The set of producer step keys whose `{{steps.<key>.report}}` a generator
 * spec consumes. Walks `jsonl` readers (including array `dataFile`s) and
 * recurses into `batch` sources. State markers are intentionally ignored:
 * a state file is always JSON and readable regardless of reporter.
 */
export function collectReportConsumers(spec: unknown): Set<string> {
  const out = new Set<string>();
  walk(spec, out);
  return out;
}

function walk(spec: unknown, out: Set<string>): void {
  if (!Array.isArray(spec)) {
    return;
  }
  const [type, config] = spec as [string, unknown];
  if (type === 'jsonl' && isRecord(config)) {
    const dataFile = config['dataFile'];
    const files = Array.isArray(dataFile) ? dataFile : [dataFile];
    for (const file of files) {
      if (typeof file === 'string') {
        for (const match of file.matchAll(REPORT_MARKER)) {
          out.add(match[1]);
        }
      }
    }
  } else if (type === 'batch' && isRecord(config)) {
    walk(config['source'], out);
  }
}

/**
 * Reject a pipeline that hands off a report through a `jsonl` reader while the
 * producing step resolves to a non-`jsonl-report` reporter. The default
 * `yaml-report` cannot be read back by the `jsonl` reader, and because handoff
 * resolves to a `.jsonl` filename the mismatch would otherwise surface only as
 * silent empty input at run time. Runs on the raw config, before handoff
 * substitution, so markers still name bare step keys.
 */
export function assertReporterHandoffContract(
  task: PipelineTask,
  topLevelReporter: unknown,
): void {
  for (const [stepKey, step] of Object.entries(task.steps)) {
    for (const producerKey of collectReportConsumers(step.promptGenerator)) {
      const producer = task.steps[producerKey];
      const reporter = producer?.reporter ?? topLevelReporter;
      if (reporter !== 'jsonl-report') {
        throw new Error(
          `Pipeline handoff contract: step "${stepKey}" reads {{steps.${producerKey}.report}} with a jsonl reader, but step "${producerKey}" uses reporter "${String(
            reporter,
          )}". A jsonl handoff requires the producer to set reporter "jsonl-report".`,
        );
      }
    }
  }
}

/**
 * A pipeline step augmented with the fields needed to synthesise its config.
 * Re-exported for `runPipeline`.
 */
export type { PipelineStep, PipelineTask };
```

- [ ] **Step 5: Add the `createPromptGenerator` guard and the `normalizePromptGeneratorSpec` branch in `src/prompt-generators.ts`**

Add the import:

```ts
import { PIPELINE_GENERATOR_NAME } from './pipeline-spec.js';
```

In `normalizePromptGeneratorSpec`, add a branch at the top of the function body, immediately after destructuring `const [type, config] = promptGeneratorSpec;` (before the `batch` branch):

```ts
  if (type === PIPELINE_GENERATOR_NAME) {
    throw new Error('nested pipelines are not supported');
  }
```

In `createPromptGenerator`, add a guard at the top of the `if (Array.isArray(promptGeneratorSpec))` block, after `const [type, ...args] = promptGeneratorSpec;`:

```ts
    if (type === PIPELINE_GENERATOR_NAME) {
      throw new Error(
        'pipeline specs are not prompt generators; runPipeline handles them (nested pipelines are unsupported)',
      );
    }
```

- [ ] **Step 6: Add the guard/branch tests to `src/prompt-generators/__test__/prompt-generators.test.ts`**

```ts
  it('createPromptGenerator throws on a pipeline spec', async () => {
    await expect(
      createPromptGenerator(['pipeline', { output: 'a', steps: {} }] as never),
    ).rejects.toThrow('pipeline specs are not prompt generators');
  });

  it('normalizePromptGeneratorSpec throws on a nested pipeline', () => {
    expect(() =>
      normalizePromptGeneratorSpec(['pipeline', {}] as never, {
        configDir: '/x',
        outputDir: '/x',
      }),
    ).toThrow('nested pipelines are not supported');
  });
```

(Ensure `createPromptGenerator` and `normalizePromptGeneratorSpec` are imported in that test file; add them to the existing import from `loop-the-loop/prompt-generators` if missing.)

- [ ] **Step 7: Add the schema definitions**

In `schema/loop-the-loop.schema.json`, add a `pipeline` tuple to the `promptGeneratorSpec` `oneOf` array, immediately before the closing `]` (after the `batch` tuple at line ~413):

```json
        ,
        {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "additionalItems": false,
          "items": [
            { "const": "pipeline" },
            { "$ref": "#/definitions/pipelineTask" }
          ]
        }
```

Add the `pipelineTask` and `pipelineStep` definitions in the `definitions` block (after `batchTask`, around line 969):

```json
    "pipelineTask": {
      "type": "object",
      "required": ["output", "steps"],
      "additionalProperties": false,
      "properties": {
        "output": {
          "type": "string",
          "description": "Key of the terminal step. Identifies the final artifact for reporting; does not impose execution order."
        },
        "maxPasses": {
          "type": "integer",
          "minimum": 1,
          "default": 100,
          "description": "Safety ceiling on fixed-point passes."
        },
        "steps": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": { "$ref": "#/definitions/pipelineStep" },
          "description": "Steps keyed by step key. Each step's loop name is ${pipelineName}-${stepKey}."
        }
      }
    },
    "pipelineStep": {
      "type": "object",
      "required": ["promptGenerator"],
      "additionalProperties": false,
      "properties": {
        "promptGenerator": { "$ref": "#/definitions/promptGeneratorSpec" },
        "agent": { "$ref": "#/definitions/agentSpec" },
        "reporter": { "$ref": "#/definitions/reporterSpec" },
        "outputDir": { "type": "string" },
        "allowSourceUpdate": { "type": "boolean" },
        "maxPrompts": { "type": "integer", "minimum": 0 },
        "interPromptPause": { "type": "number", "minimum": 0 },
        "logger": { "type": "string", "enum": ["verbose"] },
        "dependsOn": { "type": "array", "items": { "type": "string" } }
      }
    },
```

- [ ] **Step 8: Add schema cases to `src/__test__/schema.test.ts`**

Positive case (a full rework pipeline, which doubles as a structural check of the topology):

```ts
      [
        'pipeline',
        {
          name: 'bugfix',
          agent: 'claude-sdk',
          reporter: 'jsonl-report',
          promptGenerator: [
            'pipeline',
            {
              output: 'summary',
              maxPasses: 20,
              steps: {
                fix: {
                  promptGenerator: [
                    'jsonl',
                    { dataFile: 'seed.jsonl', promptTemplate: 'fix {{id}}' },
                  ],
                },
                verify: {
                  agent: ['claude-sdk', { model: 'claude-opus-4-8' }],
                  promptGenerator: [
                    'jsonl',
                    {
                      dataFile: '{{steps.fix.report}}',
                      promptTemplate: 'verify {{id}}',
                    },
                  ],
                  dependsOn: ['fix'],
                },
                summary: {
                  promptGenerator: [
                    'jsonl',
                    {
                      dataFile: ['{{steps.verify.report}}'],
                      promptTemplate: 'summary {{id}}',
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
```

Negative cases (in the negative-cases array):

```ts
      [
        'pipeline step missing promptGenerator',
        {
          name: 'p',
          agent: 'claude-sdk',
          promptGenerator: [
            'pipeline',
            { output: 'a', steps: { a: {} } },
          ],
        },
      ],
      [
        'pipeline missing output',
        {
          name: 'p',
          agent: 'claude-sdk',
          promptGenerator: [
            'pipeline',
            { steps: { a: { promptGenerator: ['test', { prompts: [] }] } } },
          ],
        },
      ],
```

- [ ] **Step 9: Run the tests and verify they pass**

Run: `pnpm test src/__test__/pipeline-spec.test.ts src/prompt-generators/__test__/prompt-generators.test.ts src/__test__/schema.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `pipeline-spec.ts` at 100%.

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/pipeline-spec.ts src/__test__/pipeline-spec.test.ts src/prompt-generators.ts src/prompt-generators/__test__/prompt-generators.test.ts schema/loop-the-loop.schema.json src/__test__/schema.test.ts
git commit -m "Feature: Add pipeline spec validation, schema, and guards"
```

---

## Section 3: Per-step normalization with prefixed handoff resolution

Wire pipelines into config normalization: resolve each step's `{{steps.<stepKey>.report|state}}` markers to the derived `${pipelineName}-${stepKey}` artifact names, normalize each step's agent (includes), and descend the `--dry-run` swap into every step.

**Files:**

- Modify: `src/prompt-generators/util/handoff.ts`, `src/prompt-generators/util/config.ts`, `src/prompt-generators.ts`, `src/util/load-cli-config.ts`
- Test: `src/prompt-generators/util/__test__/handoff.test.ts`, `src/util/__test__/load-cli-config.test.ts`

- [ ] **Step 1: Write the failing handoff test**

Add to `src/prompt-generators/util/__test__/handoff.test.ts`:

```ts
  it('applies a name mapper to the marker step key', () => {
    const result = resolveStepHandoff(
      '{{steps.review.report}}',
      '/out',
      key => `bugfix-${key}`,
    );
    expect(result).toBe(resolve('/out', 'bugfix-review-report.jsonl'));
  });

  it('applies the mapper to state markers too', () => {
    const result = resolveStepHandoff(
      '{{steps.fix.state}}',
      '/out',
      key => `bugfix-${key}`,
    );
    expect(result).toBe(resolve('/out', 'bugfix-fix-loop-state.json'));
  });
```

(Ensure `resolve` from `node:path` is imported in that test file.)

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm test src/prompt-generators/util/__test__/handoff.test.ts`
Expected: FAIL - `resolveStepHandoff` takes only two arguments.

- [ ] **Step 3: Extend `resolveStepHandoff` in `src/prompt-generators/util/handoff.ts`**

```ts
import { resolve } from 'node:path';

const REPORT_HANDOFF = /\{\{steps\.([A-Za-z0-9_-]+)\.report\}\}/gu;
const STATE_HANDOFF = /\{\{steps\.([A-Za-z0-9_-]+)\.state\}\}/gu;

/**
 * Resolve `{{steps.<name>.report}}` and `{{steps.<name>.state}}` handoff
 * markers to the named step's local artifacts under `outputDir`. `mapName`
 * maps the marker's step key to the actual artifact basename; it defaults to
 * identity (standalone loop, where the loop name equals the basename). Inside
 * a pipeline the caller passes `(key) => `${pipelineName}-${key}`` so a marker
 * written with the bare step key resolves to the pipeline-prefixed filename.
 */
export function resolveStepHandoff(
  value: string,
  outputDir: string,
  mapName: (name: string) => string = name => name,
): string {
  return value
    .replace(REPORT_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${mapName(name)}-report.jsonl`),
    )
    .replace(STATE_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${mapName(name)}-loop-state.json`),
    );
}
```

- [ ] **Step 4: Add `stepKeyToName` to the context and thread it in `src/prompt-generators.ts`**

In `src/prompt-generators/util/config.ts`, add an optional field to `PromptGeneratorConfigContext`:

```ts
  /**
   * Maps a `{{steps.<key>...}}` marker's step key to the actual artifact
   * basename. Used inside a pipeline to apply the `${pipelineName}-${stepKey}`
   * prefix. Defaults to identity when omitted (standalone loop).
   */
  readonly stepKeyToName?: (key: string) => string;
```

In `src/prompt-generators.ts`, update the `jsonl` and `loop-state` branches to pass the mapper. For `jsonl` (replacing the Section 1 form):

```ts
  if (type === JsonlPromptGenerator.promptGeneratorName) {
    const task = normalizeJsonlTaskConfig(config);
    const dataFile = Array.isArray(task.dataFile)
      ? task.dataFile.map(file =>
          resolveStepHandoff(file, outputDir, context.stepKeyToName),
        )
      : resolveStepHandoff(task.dataFile, outputDir, context.stepKeyToName);
    return [type, { ...task, dataFile }, configDir];
  }
```

For `loop-state`:

```ts
  if (type === LoopStatePromptGenerator.promptGeneratorName) {
    const task = normalizeLoopStateTaskConfig(config);
    return [
      type,
      {
        ...task,
        stateFile: resolveStepHandoff(
          task.stateFile,
          outputDir,
          context.stepKeyToName,
        ),
      },
      configDir,
    ];
  }
```

Note: `resolveStepHandoff(x, outputDir, undefined)` uses the identity default, so non-pipeline callers (who never set `stepKeyToName`) are unaffected. Confirm `context` is destructured to keep `stepKeyToName` available (the function already destructures `configDir` and `outputDir`; pass `context.stepKeyToName` directly rather than destructuring to avoid an unused-var lint when it is undefined).

- [ ] **Step 5: Write the failing normalization test**

Add to `src/util/__test__/load-cli-config.test.ts`. These exercise `normalizeCliConfig` directly (it is exported). Use a temp dir for the config path so `configDir`/`outputDir` resolve predictably.

```ts
  it('normalizes a pipeline: handoff markers get the pipeline name prefix', async () => {
    const configPath = join(dir, 'config.json');
    const normalized = await normalizeCliConfig(
      {
        name: 'bugfix',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        promptGenerator: [
          'pipeline',
          {
            output: 'verify',
            steps: {
              fix: {
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'seed.jsonl', promptTemplate: 'fix {{id}}' },
                ],
              },
              verify: {
                promptGenerator: [
                  'jsonl',
                  {
                    dataFile: '{{steps.fix.report}}',
                    promptTemplate: 'verify {{id}}',
                  },
                ],
              },
            },
          },
        ],
      },
      configPath,
    );

    const spec = normalized.promptGenerator as [string, PipelineTask, string];
    const verifyGen = spec[1].steps['verify'].promptGenerator as [
      string,
      { dataFile: string },
      string,
    ];
    expect(verifyGen[1].dataFile).toBe(
      resolve(dir, 'bugfix-fix-report.jsonl'),
    );
  });

  it('normalizes a pipeline: per-step agent systemPrompt includes are resolved', async () => {
    await writeFile(join(dir, 'sys.md'), 'You verify fixes.');
    const configPath = join(dir, 'config.json');
    const normalized = await normalizeCliConfig(
      {
        name: 'bugfix',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        promptGenerator: [
          'pipeline',
          {
            output: 'verify',
            steps: {
              verify: {
                agent: [
                  'claude-sdk',
                  { systemPrompt: '{{include:sys.md}}' },
                ],
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'seed.jsonl', promptTemplate: 'v {{id}}' },
                ],
              },
            },
          },
        ],
      },
      configPath,
    );
    const spec = normalized.promptGenerator as [string, PipelineTask, string];
    const agent = spec[1].steps['verify'].agent as [
      string,
      { systemPrompt: string },
    ];
    expect(agent[1].systemPrompt).toBe('You verify fixes.');
  });

  it('descends the --dry-run swap into every step', async () => {
    const configPath = join(dir, 'config.json');
    const normalized = await normalizeCliConfig(
      {
        name: 'bugfix',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        promptGenerator: [
          'pipeline',
          {
            output: 'fix',
            steps: {
              fix: {
                agent: ['claude-sdk', {}],
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'seed.jsonl', promptTemplate: 'f {{id}}' },
                ],
              },
            },
          },
        ],
      },
      configPath,
      { dryRun: true },
    );
    const spec = normalized.promptGenerator as [string, PipelineTask, string];
    expect(spec[1].steps['fix'].agent?.[0]).toBe('test');
  });

  it('rejects a nested pipeline at normalization', async () => {
    const configPath = join(dir, 'config.json');
    await expect(
      normalizeCliConfig(
        {
          name: 'p',
          agent: 'claude-sdk',
          promptGenerator: [
            'pipeline',
            {
              output: 'a',
              steps: {
                a: {
                  promptGenerator: [
                    'pipeline',
                    { output: 'b', steps: { b: { promptGenerator: ['test', {}] } } },
                  ],
                },
              },
            },
          ],
        },
        configPath,
      ),
    ).rejects.toThrow('nested pipelines are not supported');
  });
```

Ensure the test file imports `PipelineTask` from `loop-the-loop/types`, `resolve`/`join` from `node:path`, `writeFile` from `node:fs/promises`, and has a `dir` temp directory in scope (mirror the existing handoff integration test setup in this file; reuse its `beforeEach`/`afterEach` temp-dir pattern).

- [ ] **Step 6: Run it and verify it fails**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: FAIL - `normalizeCliConfig` does not yet handle pipelines or a `dryRun` option.

- [ ] **Step 7: Implement pipeline normalization in `src/util/load-cli-config.ts`**

Add imports:

```ts
import { isPipelineSpec, normalizePipelineTaskConfig } from '../pipeline-spec.js';
import type { PipelineStep, PipelineTask } from '../types.js';
import type { PromptGeneratorSpec } from '../prompt-generators.js';
```

Change the `normalizeCliConfig` signature and body to detect a pipeline and pass the dry-run flag:

```ts
export async function normalizeCliConfig(
  config: LoopCliConfig,
  configPath: string,
  options: { dryRun?: boolean } = {},
): Promise<LoopCliConfig> {
  const resolvedPath = resolve(configPath);
  const configDir = dirname(resolvedPath);

  const outputDir =
    config.outputDir === undefined
      ? configDir
      : resolve(configDir, config.outputDir);

  const promptGenerator = isPipelineSpec(config.promptGenerator)
    ? await normalizePipelineSpec(
        config.promptGenerator as readonly [string, unknown],
        config.name,
        { configDir, outputDir },
        options.dryRun === true,
      )
    : normalizePromptGeneratorSpec(config.promptGenerator, {
        configDir,
        outputDir,
      });

  return {
    ...config,
    outputDir,
    agent: await normalizeAgentSpec(config.agent, configDir),
    promptGenerator,
  };
}
```

Add the pipeline normalizer near the bottom of the file:

```ts
/**
 * Normalize a `["pipeline", task]` spec. Validates the task, then for each
 * step resolves its generator's handoff markers against the pipeline-prefixed
 * step names, resolves its agent's `{{include:...}}` macros, and (under
 * `--dry-run`) swaps its agent for the dry-run test agent. The reporter/handoff
 * contract is checked on the raw task before substitution. Returns a
 * `["pipeline", normalizedTask, configDir]` spec for `runPipeline`.
 */
async function normalizePipelineSpec(
  spec: readonly [string, unknown],
  pipelineName: string,
  context: { configDir: string; outputDir: string },
  dryRun: boolean,
): Promise<PromptGeneratorSpec> {
  const task = normalizePipelineTaskConfig(spec[1]);
  assertReporterHandoffContract(task, undefined); // see note below
  const stepKeyToName = (key: string): string => `${pipelineName}-${key}`;

  const steps: Record<string, PipelineStep> = {};
  for (const [key, step] of Object.entries(task.steps)) {
    const promptGenerator = normalizePromptGeneratorSpec(
      step.promptGenerator,
      { ...context, stepKeyToName },
    );
    const agent = await normalizeStepAgent(step.agent, context.configDir, dryRun);
    const outputDir =
      step.outputDir === undefined
        ? undefined
        : resolve(context.configDir, step.outputDir);
    steps[key] = {
      ...step,
      promptGenerator,
      ...(agent !== undefined ? { agent } : {}),
      ...(outputDir !== undefined ? { outputDir } : {}),
    };
  }

  const normalizedTask: PipelineTask = { ...task, steps };
  return [spec[0], normalizedTask, context.configDir] as unknown as PromptGeneratorSpec;
}

/**
 * Normalize a step's agent: under `--dry-run` swap it for the dry-run agent;
 * otherwise resolve includes when present, or leave undefined to inherit the
 * pipeline-level agent.
 */
async function normalizeStepAgent(
  agent: PipelineStep['agent'],
  configDir: string,
  dryRun: boolean,
): Promise<PipelineStep['agent']> {
  if (dryRun) {
    return DRY_RUN_AGENT_SPEC;
  }
  if (agent === undefined) {
    return undefined;
  }
  return normalizeAgentSpec(agent, configDir);
}
```

Important note on `assertReporterHandoffContract`: it needs the effective top-level reporter. `normalizePipelineSpec` does not receive `config.reporter`. Two clean options; pick one and keep it consistent:

- Option A (preferred): pass `config.reporter` through. Change the `normalizePipelineSpec` signature to accept a `topReporter: unknown` argument and have `normalizeCliConfig` pass `config.reporter`. Then call `assertReporterHandoffContract(task, config.reporter)`. Defer to `DEFAULT_REPORTER` (import `'default'` semantics) is unnecessary here: when `config.reporter` is undefined the contract must still fire (undefined !== 'jsonl-report'), which is correct because the default reporter is yaml.

Adopt Option A. Update the signature:

```ts
async function normalizePipelineSpec(
  spec: readonly [string, unknown],
  pipelineName: string,
  topReporter: unknown,
  context: { configDir: string; outputDir: string },
  dryRun: boolean,
): Promise<PromptGeneratorSpec> {
  const task = normalizePipelineTaskConfig(spec[1]);
  assertReporterHandoffContract(task, topReporter);
  ...
```

and the call site:

```ts
    ? await normalizePipelineSpec(
        config.promptGenerator as readonly [string, unknown],
        config.name,
        config.reporter,
        { configDir, outputDir },
        options.dryRun === true,
      )
```

Add the import for the contract:

```ts
import {
  assertReporterHandoffContract,
  isPipelineSpec,
  normalizePipelineTaskConfig,
} from '../pipeline-spec.js';
```

- [ ] **Step 8: Thread `--dry-run` from `loadCliConfig`**

In `loadCliConfig`, pass the dry-run flag into `normalizeCliConfig` so the per-step swap fires. Replace the `normalizeCliConfig(config as LoopCliConfig, resolvedPath)` call in the return spread with:

```ts
    ...(await normalizeCliConfig(config as LoopCliConfig, resolvedPath, {
      dryRun: effectiveDryRun,
    })),
```

The existing top-level dry-run agent swap in the same return object stays: it covers steps that inherit the pipeline-level agent (no per-step `agent`), while `normalizeStepAgent` covers steps with their own `agent`. For a non-pipeline config the `dryRun` option is ignored by `normalizeCliConfig` (only the pipeline branch reads it), so the existing top-level swap remains the sole effect, unchanged.

- [ ] **Step 9: Run the tests and verify they pass**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts src/prompt-generators/util/__test__/handoff.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; new branches in `load-cli-config.ts` and `handoff.ts` at 100% (the `normalizeStepAgent` dry-run/undefined/include branches, step `outputDir` set/unset, and the contract check all need a test path — add small extra cases if coverage flags any).

- [ ] **Step 11: Commit**

```bash
git add src/prompt-generators/util/handoff.ts src/prompt-generators/util/config.ts src/prompt-generators.ts src/util/load-cli-config.ts src/prompt-generators/util/__test__/handoff.test.ts src/util/__test__/load-cli-config.test.ts
git commit -m "Feature: Normalize pipeline step configs with prefixed handoff resolution"
```

---

## Section 4: The `runPipeline` orchestrator and CLI dispatch

The fixed-point orchestrator and the CLI fork. This is the behavioural core, tested end-to-end with the `test` agent.

**Files:**

- Create: `src/pipeline.ts`, `src/__test__/pipeline.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement `src/pipeline.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loop } from './loop.js';
import {
  assertReporterHandoffContract,
  isPipelineSpec,
  PIPELINE_GENERATOR_NAME,
} from './pipeline-spec.js';
import type { LoopCliConfig, LoopRunResult, PipelineTask } from './types.js';

/**
 * Default safety ceiling on fixed-point passes.
 */
const DEFAULT_MAX_PASSES = 100;

/**
 * Run a pipeline to a fixed point. Runs every step's `loop()` once per pass,
 * in dependency-hint order, repeating passes until a whole pass records zero
 * new terminal outcomes across all steps. Under the strict default policy a
 * step whose result is not `completed` stops the pipeline immediately and is
 * reported. `maxPasses` is the backstop against a misconfiguration that keeps
 * producing new work.
 */
export async function runPipeline(config: LoopCliConfig): Promise<LoopRunResult> {
  /* istanbul ignore next -- cli.ts only calls this when isPipelineSpec holds */
  if (!isPipelineSpec(config.promptGenerator)) {
    throw new Error('runPipeline called without a pipeline spec');
  }
  const spec = config.promptGenerator as unknown as [
    string,
    PipelineTask,
    string?,
  ];
  const task = spec[1];
  assertReporterHandoffContract(task, config.reporter);

  const stepKeys = orderStepKeys(task);
  const maxPasses = task.maxPasses ?? DEFAULT_MAX_PASSES;

  let previousTotal = await countAllOutcomes(config, task, stepKeys);
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    for (const key of stepKeys) {
      const stepConfig = buildStepConfig(config, task, key);
      const result = await loop(stepConfig);
      if (result.status !== 'completed') {
        return {
          ...result,
          message: `Pipeline stopped at step "${stepConfig.name}": ${
            result.message ?? result.reason ?? result.status
          }`,
        };
      }
    }
    const total = await countAllOutcomes(config, task, stepKeys);
    if (total === previousTotal) {
      return { status: 'completed' };
    }
    previousTotal = total;
  }
  return {
    status: 'stopped',
    reason: 'maxPasses',
    message: `Pipeline did not converge within ${maxPasses} passes`,
  };
}

/**
 * Order the step keys so a step follows the steps it `dependsOn` where that is
 * acyclic, falling back to configuration order when a cycle would otherwise
 * stall placement. Order is a pass-count optimisation only; convergence does
 * not depend on it.
 */
function orderStepKeys(task: PipelineTask): ReadonlyArray<string> {
  const configOrder = Object.keys(task.steps);
  const placed = new Set<string>();
  const order: Array<string> = [];
  const remaining = [...configOrder];

  while (remaining.length > 0) {
    const ready = remaining.find(key => {
      const deps = task.steps[key].dependsOn ?? [];
      return deps.every(dep => placed.has(dep));
    });
    // No step's deps are all placed (a cycle): take the next in config order.
    const next = ready ?? remaining[0];
    order.push(next);
    placed.add(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

/**
 * Synthesise a full LoopCliConfig for one step: top-level defaults, then the
 * step's own fields, then the derived name. The step generator is already
 * normalized (handoff resolved); `outputDir` is already absolute.
 */
function buildStepConfig(
  config: LoopCliConfig,
  task: PipelineTask,
  key: string,
): LoopCliConfig {
  const step = task.steps[key];
  const reporter = step.reporter ?? config.reporter;
  const outputDir = step.outputDir ?? config.outputDir;
  const allowSourceUpdate = step.allowSourceUpdate ?? config.allowSourceUpdate;
  const maxPrompts = step.maxPrompts ?? config.maxPrompts;
  const interPromptPause = step.interPromptPause ?? config.interPromptPause;
  const logger = step.logger ?? config.logger;

  return {
    name: `${config.name}-${key}`,
    agent: step.agent ?? config.agent,
    promptGenerator: step.promptGenerator,
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(reporter !== undefined ? { reporter } : {}),
    ...(allowSourceUpdate !== undefined ? { allowSourceUpdate } : {}),
    ...(maxPrompts !== undefined ? { maxPrompts } : {}),
    ...(interPromptPause !== undefined ? { interPromptPause } : {}),
    ...(logger !== undefined ? { logger } : {}),
  };
}

/**
 * Total number of terminal outcomes recorded across all steps' state files.
 * The fixed-point check compares this between passes.
 */
async function countAllOutcomes(
  config: LoopCliConfig,
  task: PipelineTask,
  stepKeys: ReadonlyArray<string>,
): Promise<number> {
  let total = 0;
  for (const key of stepKeys) {
    const stepConfig = buildStepConfig(config, task, key);
    const dir = stepConfig.outputDir ?? process.cwd();
    const statePath = resolve(dir, `${stepConfig.name}-loop-state.json`);
    total += await countOutcomes(statePath);
  }
  return total;
}

/**
 * Count `results` entries in one v2 state file. A missing file is zero
 * outcomes (the step has not run, or produced nothing).
 */
async function countOutcomes(statePath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return 0;
    }
    /* istanbul ignore next -- non-ENOENT read errors are not exercised */
    throw err;
  }
  const data = JSON.parse(raw) as { results?: Record<string, unknown> };
  return data.results ? Object.keys(data.results).length : 0;
}

export { PIPELINE_GENERATOR_NAME };
```

- [ ] **Step 2: Wire the CLI fork in `src/cli.ts`**

Add imports:

```ts
import { isPipelineSpec } from './pipeline-spec.js';
import { runPipeline } from './pipeline.js';
```

Replace the doctor and run section of `main()` so doctor rejects pipelines clearly and the run forks to `runPipeline`:

```ts
  const config = await loadCliConfig(parsedArgs);
  const pipeline = isPipelineSpec(config.promptGenerator);
  if (parsedArgs.doctor === true) {
    if (pipeline) {
      console.error('--doctor does not yet support pipelines');
      process.exitCode = 1;
      return;
    }
    const ok = await doctor(config, createLogger(config.logger));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const result = pipeline ? await runPipeline(config) : await loop(config);
  console.log(renderRunResult(result));
```

- [ ] **Step 3: Write the integration tests**

Create `src/__test__/pipeline.test.ts`. The tests drive `runPipeline` directly with `test` agents and `jsonl` readers, writing real report/state files to a temp dir. The key technique: per-step `agent: ['test', { responses: [...], repeat: 'cycle' }]`, where verify emits `structuredOutput.verdict`. Build each config through `normalizeCliConfig` so handoff markers resolve to pipeline-prefixed names.

```ts
// @module-tag local

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPipeline } from 'loop-the-loop/pipeline';
import type { LoopCliConfig } from 'loop-the-loop/types';
import { normalizeCliConfig } from 'loop-the-loop/util/load-cli-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runPipeline', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Normalize a raw pipeline config against a config file in the temp dir, so
   * outputDir is the temp dir and handoff markers resolve to ${name}-${key}.
   */
  async function normalize(raw: LoopCliConfig): Promise<LoopCliConfig> {
    return normalizeCliConfig(raw, join(dir, 'config.json'));
  }

  async function readReportIds(name: string): Promise<Array<string>> {
    const path = join(dir, `${name}-report.jsonl`);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => (JSON.parse(line) as { id: string }).id);
  }

  const successAgent = ['test', { responses: [{ status: 'success', output: 'ok' }], repeat: 'cycle' }];
  const reworkAgent = [
    'test',
    {
      responses: [{ status: 'success', output: 'judged', structuredOutput: { verdict: 'rework' } }],
      repeat: 'cycle',
    },
  ];

  it('runs a linear pipeline; downstream reads upstream report', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'lin',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'fix',
          steps: {
            review: {
              agent: successAgent,
              promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' }],
            },
            fix: {
              agent: successAgent,
              dependsOn: ['review'],
              promptGenerator: ['jsonl', { dataFile: '{{steps.review.report}}', promptTemplate: 'fix {{id}}' }],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('lin-review')).toEqual(['bug-1']);
    expect(await readReportIds('lin-fix')).toEqual(['bug-1']);
  });

  it('fans in over two upstream reports', async () => {
    await writeFile(join(dir, 'seed-a.jsonl'), `${JSON.stringify({ id: 'a', status: 'success' })}\n`);
    await writeFile(join(dir, 'seed-b.jsonl'), `${JSON.stringify({ id: 'b', status: 'success' })}\n`);
    const config = await normalize({
      name: 'fan',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'merge',
          steps: {
            left: { agent: successAgent, promptGenerator: ['jsonl', { dataFile: 'seed-a.jsonl', promptTemplate: 'l {{id}}' }] },
            right: { agent: successAgent, promptGenerator: ['jsonl', { dataFile: 'seed-b.jsonl', promptTemplate: 'r {{id}}' }] },
            merge: {
              agent: successAgent,
              dependsOn: ['left', 'right'],
              promptGenerator: ['jsonl', { dataFile: ['{{steps.left.report}}', '{{steps.right.report}}'], promptTemplate: 'm {{id}}' }],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect((await readReportIds('fan-merge')).sort()).toEqual(['a', 'b']);
  });

  it('terminates a rework cycle at the attempt cap with a giveup outcome', async () => {
    await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`);
    const config = await normalize({
      name: 'rw',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'summary',
          steps: {
            'fix-new': {
              agent: successAgent,
              promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'fix {{id}}' }],
            },
            'fix-rework': {
              agent: successAgent,
              dependsOn: ['verify'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.verify.report}}',
                  filter: { 'structuredOutput.verdict': 'rework' },
                  maxAttempts: 2,
                  incrementAttempt: true,
                  promptTemplate: 'rework {{id}}',
                },
              ],
            },
            verify: {
              agent: reworkAgent,
              dependsOn: ['fix-new', 'fix-rework'],
              promptGenerator: ['jsonl', { dataFile: ['{{steps.fix-new.report}}', '{{steps.fix-rework.report}}'], promptTemplate: 'verify {{id}}' }],
            },
            giveup: {
              agent: successAgent,
              dependsOn: ['verify'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.verify.report}}',
                  filter: { 'structuredOutput.verdict': 'rework' },
                  minAttempts: 2,
                  promptTemplate: 'giveup {{id}}',
                },
              ],
            },
            summary: {
              agent: successAgent,
              dependsOn: ['giveup'],
              promptGenerator: ['jsonl', { dataFile: ['{{steps.giveup.report}}'], promptTemplate: 'summary {{id}}' }],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('rw-giveup')).toEqual(['bug-1#2']);
    expect(await readReportIds('rw-summary')).toEqual(['bug-1#2']);
  });

  it('applies per-step agent overrides and derives ${pipeline}-${step} artifacts', async () => {
    await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ id: 'x', status: 'success' })}\n`);
    const config = await normalize({
      name: 'ovr',
      agent: ['test', { responses: [{ status: 'error', reason: 'top-level agent used' }], repeat: 'cycle' }],
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              agent: successAgent,
              promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' }],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    // The step agent (success), not the top-level error agent, ran.
    expect(await readReportIds('ovr-only')).toEqual(['x']);
  });

  it('stops the pipeline at a failing step under the strict policy', async () => {
    await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ id: 'x', status: 'success' })}\n`);
    const config = await normalize({
      name: 'fail',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'down',
          steps: {
            up: {
              agent: ['test', { responses: [{ status: 'error', reason: 'boom' }], repeat: 'cycle' }],
              promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'up {{id}}' }],
            },
            down: {
              agent: successAgent,
              dependsOn: ['up'],
              promptGenerator: ['jsonl', { dataFile: '{{steps.up.report}}', promptTemplate: 'down {{id}}' }],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/Pipeline stopped at step "fail-up"/u);
    // down never ran.
    expect(await readReportIds('fail-down')).toEqual([]);
  });

  it('fast-forwards a settled pipeline on resume', async () => {
    await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ id: 'x', status: 'success' })}\n`);
    const make = async (): Promise<LoopCliConfig> =>
      normalize({
        name: 'res',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        promptGenerator: [
          'pipeline',
          {
            output: 'only',
            steps: {
              only: { agent: successAgent, promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'd {{id}}' }] },
            },
          },
        ],
      } as unknown as LoopCliConfig);

    expect((await runPipeline(await make())).status).toBe('completed');
    const first = await readReportIds('res-only');
    expect((await runPipeline(await make())).status).toBe('completed');
    // No new lines appended on the settled resume.
    expect(await readReportIds('res-only')).toEqual(first);
  });

  it('stops with reason maxPasses when it cannot converge in the budget', async () => {
    await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ id: 'x', status: 'success' })}\n`);
    // fix is ordered before review (config order, no dependsOn), so fix sees
    // nothing in pass 1; review produces in pass 1; with maxPasses=1 the run
    // stops before fix can consume review's output.
    const config = await normalize({
      name: 'mp',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'review',
          maxPasses: 1,
          steps: {
            fix: { agent: successAgent, promptGenerator: ['jsonl', { dataFile: '{{steps.review.report}}', promptTemplate: 'f {{id}}' }] },
            review: { agent: successAgent, promptGenerator: ['jsonl', { dataFile: 'seed.jsonl', promptTemplate: 'r {{id}}' }] },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxPasses',
      message: 'Pipeline did not converge within 1 passes',
    });
  });
});
```

If the `maxPasses` test proves flaky because `review` and `fix` happen to converge within one pass (e.g. ordering), force the ordering by giving `fix` no `dependsOn` and confirming config order places `fix` first; `Object.keys` preserves insertion order, so `fix` precedes `review` as written.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test src/__test__/pipeline.test.ts`
Expected: PASS. If the rework trace differs, re-derive it against `conditional-routing-design.md`'s worked trace (the giveup arm captures `bug-1#2` at the cap).

- [ ] **Step 5: Add a CLI dispatch test**

In the CLI test file (find the existing `src/__test__/cli.test.ts` or equivalent that drives `main`/`parseArgs`; mirror its harness), add a case that a pipeline config routes through `runPipeline` and that `--doctor` on a pipeline exits non-zero with the clear message. If the CLI is only tested via `loadCliConfig`/`parseArgs` units, add a focused test that `isPipelineSpec` on a normalized pipeline config is true and that `runPipeline` returns completed for a trivial dry-run pipeline. Keep this light; the heavy behaviour is covered in `pipeline.test.ts`.

- [ ] **Step 6: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `pipeline.ts` at 100% (linear, fan-in, rework, override, failure-stop, resume, maxPasses, and the cycle-fallback branch in `orderStepKeys` all exercised). If `orderStepKeys`'s cyclic fallback (`ready ?? remaining[0]`) is uncovered, the rework pipeline's `fix-rework`<->`verify` cycle should cover it; if not, add a tiny direct unit test importing nothing else.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline.ts src/__test__/pipeline.test.ts src/cli.ts
# plus the CLI test file you touched in Step 5
git commit -m "Feature: Add runPipeline fixed-point orchestrator and CLI dispatch"
```

---

## Section 5: Worked example, docs, and carry-over updates

Ship a runnable example pipeline, document the feature, and update the design/carry-over notes to the homogeneous-fan-in topology.

**Files:**

- Create: `src/examples/pipeline/bugfix.json`, `src/examples/pipeline/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write the example pipeline**

Create `src/examples/pipeline/bugfix.json`. It must validate against the schema (the `schema.test.ts` example block validates every `src/examples/**/*.json` automatically) and use the homogeneous-fan-in topology. Use `claude-sdk` agents and `{{include:...}}` prompt templates kept inline-simple (no include files needed if templates are literal strings).

```json
{
  "$schema": "../../../schema/loop-the-loop.schema.json",
  "name": "bugfix",
  "agent": "claude-sdk",
  "reporter": "jsonl-report",
  "promptGenerator": [
    "pipeline",
    {
      "output": "summary",
      "maxPasses": 25,
      "steps": {
        "review": {
          "promptGenerator": [
            "per-file",
            { "filePattern": "src/**/*.ts", "promptTemplate": "Review {{file}} and report any bug as structured output." }
          ]
        },
        "fix-new": {
          "promptGenerator": [
            "jsonl",
            { "dataFile": "{{steps.review.report}}", "filter": { "status": "success" }, "promptTemplate": "Fix the bug in {{id}}." }
          ]
        },
        "fix-rework": {
          "promptGenerator": [
            "jsonl",
            {
              "dataFile": "{{steps.verify.report}}",
              "filter": { "structuredOutput.verdict": "rework" },
              "maxAttempts": 3,
              "incrementAttempt": true,
              "promptTemplate": "The previous fix for {{id}} was rejected. Try again."
            }
          ]
        },
        "verify": {
          "dependsOn": ["fix-new", "fix-rework"],
          "promptGenerator": [
            "jsonl",
            { "dataFile": ["{{steps.fix-new.report}}", "{{steps.fix-rework.report}}"], "promptTemplate": "Verify the fix for {{id}}. Emit { verdict: approve | rework }." }
          ]
        },
        "commit": {
          "allowSourceUpdate": true,
          "dependsOn": ["verify"],
          "promptGenerator": [
            "jsonl",
            { "dataFile": "{{steps.verify.report}}", "filter": { "structuredOutput.verdict": "approve" }, "promptTemplate": "Commit the approved fix for {{id}}." }
          ]
        },
        "giveup": {
          "dependsOn": ["verify"],
          "promptGenerator": [
            "jsonl",
            { "dataFile": "{{steps.verify.report}}", "filter": { "structuredOutput.verdict": "rework" }, "minAttempts": 3, "promptTemplate": "Record {{id}} as exhausted rework." }
          ]
        },
        "summary": {
          "dependsOn": ["commit", "giveup"],
          "promptGenerator": [
            "jsonl",
            { "dataFile": ["{{steps.commit.report}}", "{{steps.giveup.report}}"], "promptTemplate": "Summarize the outcome for {{id}}." }
          ]
        }
      }
    }
  ]
}
```

Note for the executor: confirm the `per-file` task's template variable is `{{file}}` (check `src/prompt-generators/per-file.ts`); adjust if the variable name differs. The example must validate; run `pnpm test src/__test__/schema.test.ts` after writing it.

- [ ] **Step 2: Write the example README**

Create `src/examples/pipeline/README.md`:

```markdown
# Pipeline example

`bugfix.json` is a review -> fix -> verify -> commit/giveup -> summary pipeline
with a bounded rework loop.

The rework loop is split into two fix steps rather than one. `fix-new` handles
freshly reported bugs from `review`; `fix-rework` pulls verify results whose
`structuredOutput.verdict` is `rework`, re-emitting them at the next attempt
(`#2`, `#3`) up to `maxAttempts`. `verify` fans in over both fix reports with a
single `jsonl` reader whose `dataFile` is an array. When an item reaches the
attempt cap, the complementary `giveup` reader (same `minAttempts` value) pulls
it as a first-class "exhausted rework" terminal outcome instead of looping
forever.

Verdict routing requires `jsonl-report`, because the `loop-state` reader does
not carry `structuredOutput`. Every step here inherits the pipeline's
`jsonl-report` reporter. Each step's artifacts are named `bugfix-<step>-*`.

The pipeline runs to a fixed point: every step runs once per pass and passes
repeat until a whole pass adds no new outcomes anywhere.
```

- [ ] **Step 3: Add a README section**

Add a "Pipelines" section to the top-level `README.md`, after the reader-generators section. Match the existing prose style (one-line paragraphs, minimal markdown per AGENTS.md). Cover: the `["pipeline", { output, steps }]` shape, derived `${pipelineName}-${stepKey}` artifact names, pull-based verdict routing, bounded rework via attempt-scoped ids, homogeneous fan-in via array `dataFile`, the `jsonl-report` requirement for verdict routing, the strict failure policy, `maxPasses`, and that resume is rerunning the pipeline. Link to `src/examples/pipeline/bugfix.json`.

- [ ] **Step 4: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; the new example validates via `schema.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/examples/pipeline/bugfix.json src/examples/pipeline/README.md README.md
git commit -m "Docs: Add pipeline example and README section"
```

---

## Self-review checklist (run before declaring the step done)

1. Spec coverage against `step-06-sequential-pipelines.md` "Done when":
   - Linear, fan-out, fan-in, rework-cycle run to a fixed point — pipeline.test.ts (linear, fan-in, rework; fan-out is a step feeding two consumers, structurally identical to linear and covered by the example).
   - Rework terminates at the cap with a giveup outcome — pipeline.test.ts rework test.
   - Per-step overrides work — pipeline.test.ts override test; output dir override has a normalize test in Section 3.
   - Resume reruns and fast-forwards — pipeline.test.ts resume test.
   - Failing step stops under strict policy — pipeline.test.ts failure test.
   - jsonl handoff with default reporter rejected at startup — pipeline-spec.test.ts contract test (and `runPipeline` calls it).
2. Schema/examples/docs lockstep (roadmap "Definition of done"): schema gains `pipelineTask`/`pipelineStep`/tuple and the array `dataFile` (Sections 1-2); example added (Section 5); README updated (Section 5).
3. No placeholders; every code step shows code; type names consistent (`PipelineTask`, `PipelineStep`, `runPipeline`, `isPipelineSpec`, `normalizePipelineTaskConfig`, `assertReporterHandoffContract`, `collectReportConsumers`, `resolveStepHandoff` three-arg form, `PromptGeneratorConfigContext.stepKeyToName`).

## Related plans

- [Pipelines with routing and rework (step doc)](step-06-sequential-pipelines.md)
- [Conditional routing and rework loops (design)](conditional-routing-design.md)
