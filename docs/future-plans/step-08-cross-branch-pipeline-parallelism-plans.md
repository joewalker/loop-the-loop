# Step 08 Cross-branch Pipeline Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pipeline overlap independent steps within a fixed-point pass, up to a configured limit, while preserving the source-update barrier, the shared budget gate, and deterministic step-level results under out-of-order completion.

**Architecture:** Today `runPipeline` in `src/pipeline.ts` runs every step's `loop()` strictly sequentially within a pass, in `orderStepKeys` order, with a budget check before each step and a stop-on-first-failure policy. Step 08 extracts the per-pass scheduling into a pure, side-effect-free module (`src/pipeline-schedule.ts`) that overlaps independent steps up to a new pipeline-level `maxStepConcurrency`, treats any `allowSourceUpdate` step as an exclusive barrier, gates new dispatch on the shared budget, and selects the surfaced stop result by canonical step order so the outcome never depends on completion order. `runPipeline` keeps ownership of ordering, the fixed-point check, `maxPasses`, and the state-file reads; it injects `runStep` (one step's `loop()`) and `readSpend` (`countAllSpend`) into the scheduler. A second, independent lever is added: a per-step `concurrency` override threaded into the step's own `loop()` (the within-step Step 04 lever), kept strictly separate from the new cross-step `maxStepConcurrency`.

**Tech Stack:** TypeScript (strict, ESM, `exactOptionalPropertyTypes`), vitest, ajv (schema test), pnpm. Coverage gate is 100% on non-ignored files; every new branch needs a test.

---

## Carry-over contract from Step 07

Read `docs/future-plans/next.md`, `docs/future-plans/step-08-cross-branch-pipeline-parallelism.md`, `docs/future-plans/conditional-routing-design.md`, and `docs/future-plans/step-07-pipeline-wide-budgets-plans.md` before starting. The load-bearing facts and the decisions this plan locks in:

- `runPipeline(config)` is the only consumer of a pipeline; `cli.ts` dispatches `isPipelineSpec(config.promptGenerator) ? runPipeline(config) : loop(config)`. The single-loop path is untouched. The pipeline spec is `["pipeline", PipelineTask]` nested in the `promptGenerator` slot, with `output` naming the terminal step.
- Today the inner pass loop is `for (const key of stepKeys)` running each `await loop(buildStepConfig(...))` before the next, with the aggregate budget check (`countAllSpend >= aggregateCap`) at the top of each iteration and an immediate `return` on any non-`completed` step result, annotated `Pipeline stopped at step "<name>": <detail>`. Step 08 replaces this inner loop with a call to the new scheduler; everything else in `runPipeline` (validation, `orderStepKeys`, `maxPasses`, `countAllOutcomes` fixed-point check, the `maxPasses` exhaustion return) is preserved verbatim.
- `orderStepKeys(task)` is a greedy, cycle-tolerant dependency order (it places a step once its `dependsOn` are placed, else falls back to config order to break cycles). It is only a pass-count optimisation. Step 08 keeps it as the canonical order and derives "independent within a pass" from the `dependsOn` graph oriented by that order (see decision 2), never from the bare linear sequence.
- `buildStepConfig(config, task, key)` synthesises each step's `LoopCliConfig` by shallow-merging top-level defaults, the step's own fields, then the derived `name = ${config.name}-${key}`. After Step 07 it inherits `agent`, `reporter`, `outputDir`, `allowSourceUpdate`, `maxPrompts`, `interPromptPause`, `logger`, and threads a step-level `maxBudgetUsd` override (no top-level fallback). It does NOT thread `concurrency` today, so every step's `loop()` runs at the Step 04 default of 1 (within-step serial). That is the seam this plan closes for the within-step lever (decision 6).
- `loop()` enforces source safety only within a single step: it rejects `concurrency > 1` together with `allowSourceUpdate` (commits cannot interleave) or with the batch prompt generator (summary prompts would race), and runs `gitPreflight` when `allowSourceUpdate` is true, committing after each success. There is no cross-step coordination yet; that barrier is new in Step 08 (decision 3).
- The aggregate spend and the fixed-point outcome counts are both read from the per-step state files, never tracked in memory: `statePathForStep` derives each step's `${name}-loop-state.json`, and `readStateData` parses it once into `{ outcomes, totalUsd }` (missing file is zero on both). `countAllOutcomes` sums `outcomes`; `countAllSpend` sums `totalUsd`. These helpers are unchanged and remain the source of truth for the budget gate (read deterministically on resume).
- Pipelines now tend to have more, smaller steps (Step 06 fan-in): the shipped `src/examples/pipeline/bugfix.json` is review -> fix-new / fix-rework -> verify -> commit / giveup -> summary, where `fix-new` and `fix-rework` are independent siblings and `commit` and `giveup` are independent siblings after `verify`. `commit` is the only `allowSourceUpdate: true` step, so it is the ready barrier case.
- Pipeline tests (`src/__test__/pipeline.test.ts`) drive `runPipeline` with `test` agents and real seed/report files in a temp dir, building configs through `normalizeCliConfig` (the `normalize` helper), and set top-level `interPromptPause: 0` (inherited by every step) so the real `setTimeout` pause in `loop()` does not fire. The `successAgent`, `reworkAgent`, and `costAgent` constants are already declared; `costAgent` returns `cost: { usd: 1, costSource: 'provider' }` so each prompt records $1 of spend. `readReportIds(name)` reads `${name}-report.jsonl` ids. The within-step-concurrency proof in this plan instead injects a concrete probe agent and uses fake timers, mirroring `src/__test__/loop.test.ts` (`OverlapAgent` + the advance-timers race helper).
- Coverage is enforced at 100% in `vitest.config.ts`. `pipeline.ts` keeps one `/* istanbul ignore */` on the non-ENOENT state-read re-throw in `readStateData` and one on the CLI-entry guard. The new scheduler module is written so every branch (including the `result.message ?? result.reason ?? result.status` fallback) is reachable from a unit test, so it carries zero istanbul ignores.

## Design decisions locked in by this plan

1. **Two distinct concurrency levers, kept separate.** A new pipeline-level `maxStepConcurrency` on `PipelineTask` (default 1) limits how many independent steps overlap within a pass. A new per-step `concurrency` on `PipelineStep` is the existing within-step Step 04 lever, threaded into that step's own `loop()`. They are orthogonal: `maxStepConcurrency` governs the scheduler; `concurrency` governs one step's prompt pool. Neither falls back to the top-level `LoopCliConfig.concurrency` (which `runPipeline` continues to ignore). At `maxStepConcurrency: 1` the scheduler reduces byte-for-byte to today's sequential behaviour.

2. **Independence is derived from `dependsOn` oriented by the canonical order.** Let `stepKeys = orderStepKeys(task)` be the canonical order and `i` a step's index in it. A step's `earlierDeps` are its `dependsOn` entries whose canonical index is `< i`. A step becomes ready once all its `earlierDeps` have completed in this pass. Dependencies that point later in the canonical order (back-edges of a cycle, which `orderStepKeys` already broke) are intentionally excluded, so the schedule is a DAG and never deadlocks. Two steps with no ordering relationship are both ready at once and may overlap.

3. **An `allowSourceUpdate` step is an exclusive barrier.** A step whose effective `allowSourceUpdate` is true (`step.allowSourceUpdate ?? config.allowSourceUpdate`) starts only when nothing else is in flight, and while it runs no other step starts. This is stronger than the concurrency limit and is independent of it. Because the only step that dirties the tree is a source step, and a source step commits and runs alone, no step ever runs against a tree dirtied by another step. This is the conservative answer the Step 08 design selects for the dirty-tree question.

4. **The budget gate stops new dispatch and drains in-flight work.** Before launching each new step the scheduler re-reads the aggregate spend (`readSpend`); once it reaches the cap, the scheduler dispatches no further step, lets in-flight steps drain, and surfaces a `maxBudgetUsd` stop keyed to the gated step. A step already in flight is governed only by its own (optional) local cap, exactly as in Step 07. When the cap is `Infinity` (omitted) the gate is skipped entirely and every existing pipeline behaves as today.

5. **The surfaced stop is chosen by canonical order, not completion order.** Every stop signal, a step whose result is not `completed` or a budget gate that prevents a step from starting, is keyed to that step's canonical index. When several fire, the scheduler returns the one with the smallest index. So if two steps fail out of order, the earlier-in-order failure is surfaced; a failed step also prevents its dependents from ever becoming ready (decision 2). This makes the returned result deterministic under non-deterministic completion order.

6. **The within-step `concurrency` seam is closed.** `PipelineStep` gains an optional `concurrency`, validated as a positive integer, and `buildStepConfig` threads it into the step's `loop()` with no top-level fallback. The Step 04 combination guards are lifted to the pipeline layer so a misconfiguration fails clearly at load time rather than as a thrown `loop()` rejection mid-pass: a step combining `concurrency > 1` with `allowSourceUpdate: true`, or with a `["batch", ...]` prompt generator, is rejected by `normalizePipelineTaskConfig`.

7. **The scheduler is a pure module.** `schedulePass` in `src/pipeline-schedule.ts` takes step metadata plus injected `runStep` and `readSpend` callbacks and returns the stop result (or `undefined`). It owns dispatch, the barrier, the gate, the drain, and the deterministic stop selection including the stop-message annotation. It is free of agents, loop state, and file IO, so it is unit-tested in isolation with controllable promises, the same isolation principle as `src/util/run-pool.ts`.

## File structure

Created:

- `src/pipeline-schedule.ts` - the pure per-pass scheduler: `PassStep`, `SchedulePassOptions`, `schedulePass`.
- `src/__test__/pipeline-schedule.test.ts` - unit tests for the scheduler (overlap, dependency ordering, source barrier, budget gate + drain, deterministic out-of-order stop, message fallbacks).

Modified:

- `src/types.ts` - add `maxStepConcurrency?: number` to `PipelineTask`; add `concurrency?: number` to `PipelineStep`.
- `src/pipeline-spec.ts` - accept and validate `maxStepConcurrency` (task) and `concurrency` (step), including the two cross-field combination guards.
- `src/pipeline.ts` - thread `step.concurrency` in `buildStepConfig`; build `PassStep[]` and replace the inner pass loop with `schedulePass`.
- `schema/loop-the-loop.schema.json` - add `maxStepConcurrency` to `pipelineTask` and `concurrency` to `pipelineStep`.
- `src/__test__/pipeline-spec.test.ts` - positive and negative cases for both new fields and the two combo guards.
- `src/__test__/pipeline.test.ts` - cross-step overlap, a cyclic-`dependsOn` ordering case, a gated source step (covers `isSource`), and the per-step within-step concurrency proof.
- `src/__test__/schema.test.ts` - a positive case carrying `maxStepConcurrency` and a step `concurrency`.
- `src/examples/pipeline/bugfix.json` - add `maxStepConcurrency` to the task and a within-step `concurrency` on a non-source, non-batch step.
- `README.md` - a parallelism paragraph in the "Pipelines" section.

## Execution and commit protocol

Each section below is self-contained and ends with a commit. Sections are ordered so the build stays green (`pnpm tsc && pnpm test --coverage` clean, 100% coverage) after every commit. Dispatch one fresh sub-agent per section. Between sections the orchestrator runs the completion gate and reviews the diff before starting the next section.

Per AGENTS.md: stay on the `main` branch, do not open PRs, never run `git add`/`git mv`/`git rm` outside the commit step, use the default `~/.gitconfig` author, and do NOT add a `Co-Authored-By` trailer. Commit message tags follow recent history (`Feature:`, `Fix:`, `Docs:`). Before each commit run `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`. Do not pipe test output through `| tail`.

Section ordering rationale: Section 1 adds both config-surface fields (types, validation, schema) with nothing reading them yet, keeping the tree green and the schema in lockstep. Section 2 adds the pure scheduler with full unit-test coverage, exercised only by its own tests, so it is green in isolation before anything depends on it. Section 3 wires the scheduler into `runPipeline` and threads `step.concurrency`, turning both levers on with integration coverage. Section 4 documents the feature and updates the worked example once the runtime supports it end-to-end.

---

## Section 1: Config surface for both concurrency levers

Add the pipeline-level `maxStepConcurrency` and the per-step `concurrency` fields, validate them (including the two combination guards), and keep the schema in lockstep. No runtime wires them yet; both are inert optionals until Sections 2 and 3.

**Files:**

- Modify: `src/types.ts`, `src/pipeline-spec.ts`, `schema/loop-the-loop.schema.json`
- Test: `src/__test__/pipeline-spec.test.ts`, `src/__test__/schema.test.ts`

- [ ] **Step 1: Write the failing spec-module tests**

Add to the `describe('normalizePipelineTaskConfig', ...)` block in `src/__test__/pipeline-spec.test.ts`:

```ts
  it('accepts a pipeline-level maxStepConcurrency', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        maxStepConcurrency: 3,
        steps: { a: { promptGenerator: ['test', {}] } },
      }),
    ).not.toThrow();
  });

  it('rejects a non-integer maxStepConcurrency', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        maxStepConcurrency: 1.5,
        steps: { a: { promptGenerator: ['test', {}] } },
      }),
    ).toThrow('pipeline.maxStepConcurrency must be a positive integer');
  });

  it('rejects a maxStepConcurrency below 1', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        maxStepConcurrency: 0,
        steps: { a: { promptGenerator: ['test', {}] } },
      }),
    ).toThrow('pipeline.maxStepConcurrency must be a positive integer');
  });

  it('accepts a step-level concurrency', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: { a: { promptGenerator: ['test', {}], concurrency: 4 } },
      }),
    ).not.toThrow();
  });

  it('rejects a non-integer step concurrency', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: { a: { promptGenerator: ['test', {}], concurrency: 2.5 } },
      }),
    ).toThrow('pipeline.steps.a.concurrency must be a positive integer');
  });

  it('rejects a step concurrency below 1', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: { a: { promptGenerator: ['test', {}], concurrency: 0 } },
      }),
    ).toThrow('pipeline.steps.a.concurrency must be a positive integer');
  });

  it('rejects step concurrency > 1 with allowSourceUpdate', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: {
            promptGenerator: ['test', {}],
            concurrency: 2,
            allowSourceUpdate: true,
          },
        },
      }),
    ).toThrow(
      'pipeline.steps.a.concurrency > 1 is not supported with allowSourceUpdate',
    );
  });

  it('rejects step concurrency > 1 with a batch prompt generator', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: {
            promptGenerator: ['batch', { source: ['test', {}] }],
            concurrency: 2,
          },
        },
      }),
    ).toThrow(
      'pipeline.steps.a.concurrency > 1 is not supported with the batch prompt generator',
    );
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/__test__/pipeline-spec.test.ts`
Expected: FAIL - `maxStepConcurrency` and `concurrency` are currently rejected as unknown properties, and the positive cases throw.

- [ ] **Step 3: Add the fields in `src/types.ts`**

Add `concurrency` to the `PipelineStep` interface, next to `maxBudgetUsd`:

```ts
  /**
   * Stricter local USD budget for this step alone, passed into the step's
   * `loop()`. Independent of the pipeline-wide shared cap (a top-level
   * `maxBudgetUsd`), which is enforced across all steps by the orchestrator.
   */
  readonly maxBudgetUsd?: number;

  /**
   * Within-step prompt concurrency for this step's own `loop()` (the Step 04
   * lever). Independent of the pipeline-level `maxStepConcurrency`, which limits
   * how many steps overlap. No top-level fallback. `loop()` rejects values > 1
   * together with `allowSourceUpdate` or a batch generator; the pipeline rejects
   * those combinations at load time.
   */
  readonly concurrency?: number;
  readonly interPromptPause?: number;
```

Add `maxStepConcurrency` to the `PipelineTask` interface, next to `maxPasses`:

```ts
  /**
   * Safety ceiling on the number of fixed-point passes. Defaults to 100.
   */
  readonly maxPasses?: number;

  /**
   * Maximum number of independent steps to run concurrently within a pass.
   * Defaults to 1 (steps run sequentially in dependency-hint order, exactly as
   * before). A step with `allowSourceUpdate` always runs as an exclusive
   * barrier regardless of this limit.
   */
  readonly maxStepConcurrency?: number;
```

- [ ] **Step 4: Accept and validate both fields in `src/pipeline-spec.ts`**

Add `'maxStepConcurrency'` to the task-level `assertKnownProperties` list in `normalizePipelineTaskConfig`:

```ts
  assertKnownProperties(
    config,
    ['output', 'steps', 'maxPasses', 'maxStepConcurrency'],
    'pipeline',
  );
```

Add a validation block after the existing `maxPasses` validation (still inside `normalizePipelineTaskConfig`, before `return`):

```ts
  if ('maxStepConcurrency' in config) {
    const maxStepConcurrency = config['maxStepConcurrency'];
    if (
      typeof maxStepConcurrency !== 'number' ||
      !Number.isInteger(maxStepConcurrency) ||
      maxStepConcurrency < 1
    ) {
      throw new Error('pipeline.maxStepConcurrency must be a positive integer');
    }
  }
```

Add `'concurrency'` to the per-step `assertKnownProperties` list in `assertStep` (after `'maxBudgetUsd'`):

```ts
  assertKnownProperties(
    step,
    [
      'promptGenerator',
      'agent',
      'reporter',
      'outputDir',
      'allowSourceUpdate',
      'maxPrompts',
      'maxBudgetUsd',
      'concurrency',
      'interPromptPause',
      'logger',
      'dependsOn',
    ],
    `pipeline.steps.${key}`,
  );
```

Add a validation block after the `maxBudgetUsd` validation (still inside `assertStep`):

```ts
  if ('concurrency' in step) {
    const concurrency = step['concurrency'];
    if (
      typeof concurrency !== 'number' ||
      !Number.isInteger(concurrency) ||
      concurrency < 1
    ) {
      throw new Error(
        `pipeline.steps.${key}.concurrency must be a positive integer`,
      );
    }
    if (concurrency > 1) {
      if (step['allowSourceUpdate'] === true) {
        throw new Error(
          `pipeline.steps.${key}.concurrency > 1 is not supported with allowSourceUpdate`,
        );
      }
      const generator = step['promptGenerator'];
      if (Array.isArray(generator) && generator[0] === 'batch') {
        throw new Error(
          `pipeline.steps.${key}.concurrency > 1 is not supported with the batch prompt generator`,
        );
      }
    }
  }
```

- [ ] **Step 5: Add both fields to the schema**

In `schema/loop-the-loop.schema.json`, add to the `pipelineTask` `properties` block (after `maxPasses`):

```json
        "maxPasses": {
          "type": "integer",
          "minimum": 1,
          "default": 100,
          "description": "Safety ceiling on fixed-point passes."
        },
        "maxStepConcurrency": {
          "type": "integer",
          "minimum": 1,
          "default": 1,
          "description": "Maximum number of independent steps to run concurrently within a pass. Defaults to 1 (sequential). An allowSourceUpdate step always runs as an exclusive barrier."
        },
```

And add to the `pipelineStep` `properties` block (after `maxBudgetUsd`):

```json
        "concurrency": {
          "type": "integer",
          "minimum": 1,
          "description": "Within-step prompt concurrency for this step's own loop (the Step 04 lever). Independent of the pipeline-level maxStepConcurrency. Values > 1 are rejected with allowSourceUpdate or a batch generator."
        },
```

- [ ] **Step 6: Add a schema positive case in `src/__test__/schema.test.ts`**

Add to the `cases` array (after the existing 'pipeline with shared and step-level budgets' entry, before the closing `]`):

```ts
      [
        'pipeline with step and cross-step concurrency',
        {
          name: 'parallel',
          agent: 'claude-sdk',
          reporter: 'jsonl-report',
          promptGenerator: [
            'pipeline',
            {
              output: 'verify',
              maxStepConcurrency: 3,
              steps: {
                fix: {
                  concurrency: 4,
                  promptGenerator: [
                    'jsonl',
                    { dataFile: 'seed.jsonl', promptTemplate: 'fix {{id}}' },
                  ],
                },
                verify: {
                  dependsOn: ['fix'],
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
      ],
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `pnpm test src/__test__/pipeline-spec.test.ts src/__test__/schema.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `pipeline-spec.ts` at 100% (the accept branch, the two non-positive-integer reject branches for each field, and both combo-guard branches are all exercised). Note both combo guards' `concurrency > 1` true side and the `allowSourceUpdate === true` / `generator[0] === 'batch'` true sides are covered by the two combo tests, and their false sides by the plain positive cases.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/pipeline-spec.ts schema/loop-the-loop.schema.json src/__test__/pipeline-spec.test.ts src/__test__/schema.test.ts
git commit -m "Feature: Add cross-step and within-step concurrency to the pipeline config surface"
```

---

## Section 2: The pure per-pass scheduler

Add `src/pipeline-schedule.ts`, a side-effect-free scheduler that overlaps independent steps up to a limit, honours the source barrier and budget gate, drains in-flight work on a stop, and selects the surfaced result deterministically by canonical order. It is exercised only by its own unit tests in this section; `runPipeline` wires it in Section 3.

**Files:**

- Create: `src/pipeline-schedule.ts`
- Test: `src/__test__/pipeline-schedule.test.ts`

- [ ] **Step 1: Write the failing scheduler unit tests**

Create `src/__test__/pipeline-schedule.test.ts`:

```ts
import { schedulePass, type PassStep } from 'loop-the-loop/pipeline-schedule';
import type { LoopRunResult } from 'loop-the-loop/types';
import { describe, expect, it } from 'vitest';

/**
 * A promise whose resolution is controlled from the test, used to hold steps
 * in flight so overlap and ordering are observable deterministically.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Flush pending microtasks so the scheduler can dispatch the next step after a
 * gate resolves. The scheduler uses no timers, so a macrotask turn settles it.
 */
function tick(): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

/**
 * Build PassStep metadata in canonical order. `deps` are raw dependsOn; this
 * helper computes earlierDeps (deps at a smaller canonical index), matching
 * what runPipeline computes.
 */
function steps(
  defs: ReadonlyArray<{
    key: string;
    deps?: ReadonlyArray<string>;
    source?: boolean;
  }>,
): ReadonlyArray<PassStep> {
  const order = defs.map(d => d.key);
  return defs.map((d, i) => ({
    key: d.key,
    name: `p-${d.key}`,
    earlierDeps: (d.deps ?? []).filter(dep => order.indexOf(dep) < i),
    isSource: d.source === true,
  }));
}

const completed: LoopRunResult = { status: 'completed' };

describe('schedulePass', () => {
  it('overlaps independent steps up to the limit', async () => {
    let active = 0;
    let peak = 0;
    const gate = deferred();
    const runStep = async (): Promise<LoopRunResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return completed;
    };
    const promise = schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }, { key: 'c' }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    // a and b launch synchronously; c is held back by the limit.
    expect(peak).toBe(2);
    gate.resolve();
    expect(await promise).toBeUndefined();
    expect(peak).toBe(2);
  });

  it('waits for a dependency before starting the dependent step', async () => {
    const order: Array<string> = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
    };
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      order.push(step.key);
      await gates[step.key].promise;
      return completed;
    };
    const promise = schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b', deps: ['a'] }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    expect(order).toEqual(['a']); // b blocked on a
    gates.a.resolve();
    await tick();
    expect(order).toEqual(['a', 'b']);
    gates.b.resolve();
    expect(await promise).toBeUndefined();
  });

  it('runs a source step alone after in-flight work drains', async () => {
    let active = 0;
    let peak = 0;
    let sourceSawActive = -1;
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
      s: deferred(),
    };
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      active += 1;
      peak = Math.max(peak, active);
      if (step.isSource) {
        sourceSawActive = active;
      }
      await gates[step.key].promise;
      active -= 1;
      return completed;
    };
    const promise = schedulePass({
      steps: steps([
        { key: 'a' },
        { key: 'b' },
        { key: 's', deps: ['a', 'b'], source: true },
      ]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    expect(peak).toBe(2); // a, b overlap
    gates.a.resolve();
    gates.b.resolve();
    await tick();
    expect(sourceSawActive).toBe(1); // s ran alone
    gates.s.resolve();
    expect(await promise).toBeUndefined();
    expect(peak).toBe(2);
  });

  it('blocks other steps from starting while a source step is in flight', async () => {
    const order: Array<string> = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {
      s: deferred(),
      t: deferred(),
    };
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      order.push(step.key);
      await gates[step.key].promise;
      return completed;
    };
    const promise = schedulePass({
      // s is earliest in order and is a source step, so it launches alone and
      // holds dispatch until it drains, even though t is independent.
      steps: steps([{ key: 's', source: true }, { key: 't' }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    expect(order).toEqual(['s']); // t blocked by the barrier
    gates.s.resolve();
    await tick();
    expect(order).toEqual(['s', 't']);
    gates.t.resolve();
    expect(await promise).toBeUndefined();
  });

  it('stops scheduling new steps once the shared cap is reached', async () => {
    const ran: Array<string> = [];
    let done = 0;
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      ran.push(step.key);
      done += 1;
      return completed;
    };
    const result = await schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }]),
      maxStepConcurrency: 1,
      aggregateCap: 2,
      runStep,
      readSpend: async () => done * 2, // 0 before a, 2 after a
    });
    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxBudgetUsd',
      message: 'Pipeline budget reached before step "p-b": $2.0000 >= $2',
    });
    expect(ran).toEqual(['a']);
  });

  it('gates the very first step when spend already meets the cap', async () => {
    const ran: Array<string> = [];
    const result = await schedulePass({
      steps: steps([{ key: 'a' }]),
      maxStepConcurrency: 1,
      aggregateCap: 1,
      runStep: async (step: PassStep): Promise<LoopRunResult> => {
        ran.push(step.key);
        return completed;
      },
      readSpend: async () => 5,
    });
    expect(result?.reason).toBe('maxBudgetUsd');
    expect(result?.message).toMatch(/before step "p-a"/u);
    expect(ran).toEqual([]);
  });

  it('drains an in-flight step when the cap trips before a later step', async () => {
    const ran: Array<string> = [];
    let finishedA = false;
    const gate = deferred();
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      ran.push(step.key);
      if (step.key === 'a') {
        await gate.promise;
        finishedA = true;
      }
      return completed;
    };
    let spendCalls = 0;
    const promise = schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }]),
      maxStepConcurrency: 2,
      aggregateCap: 3,
      runStep,
      // The first gate check (for a) sees no spend, so a launches and is held.
      // The next check (for b) sees the cap reached, so b is never dispatched
      // while a is still in flight.
      readSpend: async () => (spendCalls++ === 0 ? 0 : 5),
    });
    // a was launched and held; b was gated. Draining a lets the pass finish.
    gate.resolve();
    const result = await promise;
    expect(finishedA).toBe(true); // in-flight a drained
    expect(result?.reason).toBe('maxBudgetUsd');
    expect(result?.message).toMatch(/before step "p-b"/u);
    expect(ran).toEqual(['a']); // b never dispatched after the gate
  });

  it('surfaces the earliest-in-order failure under out-of-order completion', async () => {
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
    };
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      await gates[step.key].promise;
      return { status: 'failed', reason: 'errorResult', message: `boom-${step.key}` };
    };
    const promise = schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    gates.b.resolve(); // b fails first (later in order)
    await tick();
    gates.a.resolve(); // a fails second (earlier in order)
    const result = await promise;
    expect(result).toEqual({
      status: 'failed',
      reason: 'errorResult',
      message: 'Pipeline stopped at step "p-a": boom-a',
    });
  });

  it('does not start a step that depends on a failed step', async () => {
    const ran: Array<string> = [];
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      ran.push(step.key);
      if (step.key === 'a') {
        return { status: 'failed', reason: 'errorResult', message: 'boom' };
      }
      return completed;
    };
    const result = await schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b', deps: ['a'] }]),
      maxStepConcurrency: 1,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    expect(result?.message).toMatch(/at step "p-a"/u);
    expect(ran).toEqual(['a']); // b never ran
  });

  it('annotates a non-completed result lacking a message using reason then status', async () => {
    const reasonOnly = await schedulePass({
      steps: steps([{ key: 'a' }]),
      maxStepConcurrency: 1,
      aggregateCap: Infinity,
      runStep: async () => ({ status: 'stopped', reason: 'maxPrompts' }),
      readSpend: async () => 0,
    });
    expect(reasonOnly?.message).toBe('Pipeline stopped at step "p-a": maxPrompts');

    const statusOnly = await schedulePass({
      steps: steps([{ key: 'a' }]),
      maxStepConcurrency: 1,
      aggregateCap: Infinity,
      runStep: async () => ({ status: 'stopped' }),
      readSpend: async () => 0,
    });
    expect(statusOnly?.message).toBe('Pipeline stopped at step "p-a": stopped');
  });

  it('returns undefined when every step completes', async () => {
    const result = await schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep: async () => completed,
      readSpend: async () => 0,
    });
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/__test__/pipeline-schedule.test.ts`
Expected: FAIL - `loop-the-loop/pipeline-schedule` does not exist yet.

- [ ] **Step 3: Create the scheduler module**

Create `src/pipeline-schedule.ts`:

```ts
import type { LoopRunResult } from './types.js';

/**
 * One step's scheduling metadata for a single fixed-point pass. The scheduler
 * is deliberately free of agents, loop state, and file IO so it can be unit
 * tested in isolation; `runStep` and `readSpend` inject all side effects.
 */
export interface PassStep {
  /**
   * The step key, used to key results and dependency checks.
   */
  readonly key: string;

  /**
   * The derived loop name `${pipelineName}-${key}`, used in stop messages.
   */
  readonly name: string;

  /**
   * Keys this step must wait for within the pass: its `dependsOn` entries that
   * sit earlier in the canonical order. Later-in-order dependencies (cycle
   * back-edges, already broken by `orderStepKeys`) are excluded so the schedule
   * is a DAG and never deadlocks.
   */
  readonly earlierDeps: ReadonlyArray<string>;

  /**
   * Whether this step resolves to `allowSourceUpdate: true`. A source step runs
   * as an exclusive barrier: it starts only when nothing else is in flight, and
   * nothing else starts while it runs.
   */
  readonly isSource: boolean;
}

/**
 * Inputs to `schedulePass`. `steps` is in canonical (`orderStepKeys`) order.
 */
export interface SchedulePassOptions {
  readonly steps: ReadonlyArray<PassStep>;
  readonly maxStepConcurrency: number;
  /**
   * Pipeline-wide shared cap, or `Infinity` to skip the budget gate.
   */
  readonly aggregateCap: number;
  /**
   * Runs one step's `loop()` and returns its result.
   */
  readonly runStep: (step: PassStep) => Promise<LoopRunResult>;
  /**
   * Reads the aggregate spend across all steps' state files.
   */
  readonly readSpend: () => Promise<number>;
}

/**
 * Run one fixed-point pass, overlapping independent steps up to
 * `maxStepConcurrency` while preserving dependency order, the source-update
 * barrier, and the shared budget gate.
 *
 * Returns the stop result the pipeline should surface, or `undefined` when the
 * pass completed without a stop (the caller then runs the fixed-point check).
 *
 * Determinism under out-of-order completion: every stop signal (a step whose
 * result is not `completed`, or a budget gate that prevents a step from
 * starting) is keyed to that step's index in `steps`. When several fire, the
 * one with the smallest index is surfaced, so the returned result does not
 * depend on the order in which steps happened to finish.
 */
export async function schedulePass(
  options: SchedulePassOptions,
): Promise<LoopRunResult | undefined> {
  const { steps, maxStepConcurrency, aggregateCap, runStep, readSpend } =
    options;

  const started = new Set<string>();
  const done = new Set<string>();
  const active = new Map<string, Promise<void>>();
  let stop: { index: number; result: LoopRunResult } | undefined;

  const noteStop = (index: number, result: LoopRunResult): void => {
    if (stop === undefined || index < stop.index) {
      stop = { index, result };
    }
  };

  const ready = (step: PassStep): boolean =>
    !started.has(step.key) && step.earlierDeps.every(dep => done.has(dep));

  const launch = (step: PassStep, index: number): void => {
    started.add(step.key);
    const promise = runStep(step).then(result => {
      done.add(step.key);
      active.delete(step.key);
      if (result.status !== 'completed') {
        const detail = result.message ?? result.reason ?? result.status;
        noteStop(index, {
          ...result,
          message: `Pipeline stopped at step "${step.name}": ${detail}`,
        });
      }
    });
    active.set(step.key, promise);
  };

  while (true) {
    if (stop === undefined) {
      // A source step in flight blocks all dispatch (exclusive barrier).
      const sourceActive = steps.some(s => active.has(s.key) && s.isSource);
      while (!sourceActive) {
        const index = steps.findIndex(ready);
        if (index === -1) {
          break;
        }
        const step = steps[index];
        if (step.isSource) {
          // The barrier starts only once nothing else is running.
          if (active.size > 0) {
            break;
          }
        } else if (active.size >= maxStepConcurrency) {
          break;
        }
        if (aggregateCap !== Infinity) {
          const spend = await readSpend();
          if (spend >= aggregateCap) {
            noteStop(index, {
              status: 'stopped',
              reason: 'maxBudgetUsd',
              message: `Pipeline budget reached before step "${step.name}": $${spend.toFixed(
                4,
              )} >= $${aggregateCap}`,
            });
            break;
          }
        }
        launch(step, index);
        if (step.isSource) {
          // Hold dispatch until the barrier drains.
          break;
        }
      }
    }
    if (active.size === 0) {
      break;
    }
    await Promise.race(active.values());
  }

  return stop?.result;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test src/__test__/pipeline-schedule.test.ts`
Expected: PASS - all overlap, ordering, barrier, gate, drain, deterministic-stop, and message-fallback cases hold.

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `pipeline-schedule.ts` at 100% with no istanbul ignores. Branches to confirm covered:
- `stop === undefined` true (normal dispatch) and false (drain after a stop is noted, the drain test and out-of-order failure test).
- `sourceActive` true (source-in-flight test) and false (everything else).
- `step.isSource` true (both source tests) and false (overlap test); the inner `active.size > 0` true (source-waits-to-drain) and false (source-launches-alone).
- `active.size >= maxStepConcurrency` true (overlap limit, drain test) and false (free slot).
- `aggregateCap !== Infinity` true (all budget tests) and false (non-budget tests); `spend >= aggregateCap` true (gate tests) and false (the first iteration of the drain test).
- `result.status !== 'completed'` true (failure/stop tests) and false (completed tests); the `message ?? reason ?? status` chain all three arms (failure test, reason-only and status-only test).
- `index === -1` true (nothing ready -> break to drain/finish) and false (a step is ready).
- `stop === undefined || index < stop.index` both arms (out-of-order failure test sets a later index first, then a smaller one replaces it).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline-schedule.ts src/__test__/pipeline-schedule.test.ts
git commit -m "Feature: Add a pure per-pass pipeline step scheduler"
```

---

## Section 3: Wire the scheduler into runPipeline and thread step concurrency

Replace the inner sequential pass loop in `runPipeline` with a `schedulePass` call, build `PassStep` metadata from the canonical order, and thread the per-step `concurrency` override in `buildStepConfig`. After this section both levers are live.

**Files:**

- Modify: `src/pipeline.ts`
- Test: `src/__test__/pipeline.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add to `src/__test__/pipeline.test.ts`. First add the imports and a probe agent near the top of the file (the `Agent`/`InvokeResult` types and the fake-timer helper mirror `src/__test__/loop.test.ts`). Add to the existing import block:

```ts
import type { Agent } from 'loop-the-loop/agents';
import type { InvokeResult, LoopRunResult } from 'loop-the-loop/types';
```

After the `costAgent` declaration inside the `describe('runPipeline', ...)` block, add the probe agent and a fake-timer advance helper:

```ts
  /**
   * An agent that records the peak number of overlapping invocations, using a
   * real-but-faked timer delay so several invocations stay in flight. Used to
   * prove a per-step `concurrency` override reaches the step's loop pool.
   */
  class OverlapAgent implements Agent {
    active = 0;
    maxActive = 0;
    async invoke(): Promise<InvokeResult> {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise<void>(resolve => {
        setTimeout(resolve, 10);
      });
      this.active -= 1;
      return { status: 'success', output: 'ok' };
    }
  }

  /**
   * Run a pipeline under fake timers, advancing them until it resolves so the
   * agent's fake delay fires instantly.
   */
  async function runPipelineWithFakeTimers(
    config: LoopCliConfig,
  ): Promise<LoopRunResult> {
    const promise = runPipeline(config);
    while (true) {
      const raceResult = await Promise.race([
        promise.then(v => ({ done: true as const, value: v })),
        vi
          .advanceTimersByTimeAsync(10_000)
          .then(() => ({ done: false as const })),
      ]);
      if (raceResult.done) {
        return raceResult.value;
      }
    }
  }
```

Then add these cases inside the `describe('runPipeline', ...)` block:

```ts
  it('overlaps independent steps within a pass under maxStepConcurrency', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'par',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'right',
          maxStepConcurrency: 2,
          steps: {
            left: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'left {{id}}' },
              ],
            },
            right: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'right {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    // Two independent steps both run in the pass and the pipeline converges,
    // exercising the maxStepConcurrency > 1 dispatch path.
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('par-left')).toEqual(['x']);
    expect(await readReportIds('par-right')).toEqual(['x']);
  });

  it('respects a dependsOn cycle when orienting earlier dependencies', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'cyc',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'a',
          maxStepConcurrency: 2,
          steps: {
            // a <-> b is a dependsOn cycle. orderStepKeys breaks it, so one
            // back-edge is excluded from earlierDeps and the pass never stalls.
            a: {
              agent: successAgent,
              dependsOn: ['b'],
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'a {{id}}' },
              ],
            },
            b: {
              agent: successAgent,
              dependsOn: ['a'],
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'b {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('cyc-a')).toEqual(['x']);
    expect(await readReportIds('cyc-b')).toEqual(['x']);
  });

  it('treats an allowSourceUpdate step as a source step even when gated', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'src',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      maxBudgetUsd: 1,
      promptGenerator: [
        'pipeline',
        {
          output: 'commit',
          steps: {
            review: {
              agent: costAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
              ],
            },
            // Marked source: its isSource is computed when building the pass
            // schedule, covering the true branch. The shared cap trips after
            // review spends $1, so commit is gated before it ever runs (so no
            // gitPreflight fires in the plain temp dir).
            commit: {
              agent: costAgent,
              allowSourceUpdate: true,
              dependsOn: ['review'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'commit {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('maxBudgetUsd');
    expect(result.message).toMatch(/before step "src-commit"/u);
    expect(await readReportIds('src-review')).toEqual(['bug-1']);
    expect(await readReportIds('src-commit')).toEqual([]);
  });

  it('threads a per-step concurrency override into the step loop', async () => {
    vi.useFakeTimers();
    try {
      const overlap = new OverlapAgent();
      await writeFile(
        join(dir, 'seed.jsonl'),
        `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({
          id: 'b',
        })}\n${JSON.stringify({ id: 'c' })}\n`,
      );
      const config: LoopCliConfig = {
        name: 'wc',
        outputDir: dir,
        reporter: 'jsonl-report',
        interPromptPause: 0,
        agent: ['test', { responses: [{ status: 'success', output: 'ok' }] }],
        promptGenerator: [
          'pipeline',
          {
            output: 'only',
            steps: {
              only: {
                agent: overlap,
                concurrency: 3,
                promptGenerator: [
                  'jsonl',
                  {
                    dataFile: join(dir, 'seed.jsonl'),
                    promptTemplate: 'do {{id}}',
                  },
                ],
              },
            },
          },
        ],
      } as unknown as LoopCliConfig;

      const result = await runPipelineWithFakeTimers(config);
      // Without buildStepConfig threading `concurrency`, the step would run at
      // the default of 1 and maxActive would be 1.
      expect(result).toEqual({ status: 'completed' });
      expect(overlap.maxActive).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/__test__/pipeline.test.ts`
Expected: FAIL - the within-step concurrency override is not threaded (`maxActive` is 1, not 3); the overlap and cycle cases may already pass via the existing sequential path, and the gated-source case already passes via the existing budget check, but the within-step case fails until Step 3 threads `concurrency`. (The new scheduler is not yet wired, so behaviour is still the Step 07 sequential one.)

- [ ] **Step 3: Thread the per-step `concurrency` override in `buildStepConfig`**

In `src/pipeline.ts`, inside `buildStepConfig`, read the override and include it in the returned config (mirroring `maxBudgetUsd`, with no top-level fallback):

```ts
  const maxBudgetUsd = step.maxBudgetUsd;
  const concurrency = step.concurrency;
  const interPromptPause = step.interPromptPause ?? config.interPromptPause;
```

```ts
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(interPromptPause !== undefined ? { interPromptPause } : {}),
```

- [ ] **Step 4: Build PassStep metadata and replace the inner pass loop**

In `src/pipeline.ts`, add the import at the top (with the other local imports):

```ts
import { schedulePass, type PassStep } from './pipeline-schedule.js';
```

In `runPipeline`, after `const aggregateCap = config.maxBudgetUsd ?? Infinity;`, derive the cross-step limit and the per-step schedule metadata once (the metadata does not change between passes):

```ts
  const stepKeys = orderStepKeys(task);
  const maxPasses = task.maxPasses ?? DEFAULT_MAX_PASSES;
  const aggregateCap = config.maxBudgetUsd ?? Infinity;
  const maxStepConcurrency = task.maxStepConcurrency ?? 1;
  const passSteps: ReadonlyArray<PassStep> = stepKeys.map((key, i) => {
    const step = task.steps[key];
    const earlierDeps = (step.dependsOn ?? []).filter(
      dep => stepKeys.indexOf(dep) < i,
    );
    const isSource = (step.allowSourceUpdate ?? config.allowSourceUpdate) === true;
    return { key, name: `${config.name}-${key}`, earlierDeps, isSource };
  });
```

Replace the entire inner `for (const key of stepKeys) { ... }` block with a `schedulePass` call:

```ts
  let previousTotal = await countAllOutcomes(config, task, stepKeys);
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const stop = await schedulePass({
      steps: passSteps,
      maxStepConcurrency,
      aggregateCap,
      runStep: step => loop(buildStepConfig(config, task, step.key)),
      readSpend: () => countAllSpend(config, task, stepKeys),
    });
    if (stop !== undefined) {
      return stop;
    }
    const total = await countAllOutcomes(config, task, stepKeys);
    if (total === previousTotal) {
      return { status: 'completed' };
    }
    previousTotal = total;
  }
```

The `maxPasses` exhaustion `return` after the loop is unchanged. The old inline budget check and the old non-completed annotation block (including its `/* istanbul ignore next -- loop() always sets message */` comment) are deleted; the annotation now lives in `schedulePass`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm test src/__test__/pipeline.test.ts`
Expected: PASS - the within-step concurrency proof now reports `maxActive` of 3, and all existing pipeline tests (linear, rework, budget shared-cap / step-override / resume / no-cost) still pass through the new scheduler at their configured limits (default 1 for the Step 07 budget tests).

- [ ] **Step 6: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `pipeline.ts` at 100%. Branches to confirm covered:
- `step.dependsOn ?? []` both arms (steps with and without `dependsOn`, present across the rework and new tests).
- `stepKeys.indexOf(dep) < i` true (a real earlier dep, e.g. `verify` after `fix-*`) and false (the cyclic test's back-edge).
- `(step.allowSourceUpdate ?? config.allowSourceUpdate) === true` true (the gated-source test's `commit`) and false (every non-source step), and the `??` both arms (top-level `allowSourceUpdate` is absent in all pipeline tests, so the right arm is the covered default; the left arm is covered by `commit` setting it explicitly).
- `concurrency !== undefined` true (within-step test) and false (everything else).
- `task.maxStepConcurrency ?? 1` both arms (overlap/cycle tests set it; the rest default).
- `stop !== undefined` true (budget and any failure tests) and false (completing pipelines).

- [ ] **Step 7: Commit**

```bash
git add src/pipeline.ts src/__test__/pipeline.test.ts
git commit -m "Feature: Overlap independent pipeline steps and thread per-step concurrency"
```

---

## Section 4: Documentation and worked example

Document cross-step parallelism, the source barrier, and the within-step lever, and update the worked example so the feature is discoverable. The schema test validates the example automatically.

**Files:**

- Modify: `README.md`, `src/examples/pipeline/bugfix.json`

- [ ] **Step 1: Add a parallelism paragraph to the README "Pipelines" section**

In `README.md`, after the budget paragraph (the one ending "stops deterministically before any step re-runs.") and before the `See src/examples/pipeline/bugfix.json` line, add:

```markdown
A pipeline can also overlap work within a pass. Set `maxStepConcurrency` on the pipeline (default 1, sequential) to run that many independent steps at once. Independence is derived from the `dependsOn` graph: a step waits only for the dependencies that precede it in the pass order, so steps with no ordering relationship overlap while a dependent step still waits for its inputs. A step whose effective `allowSourceUpdate` is true runs as an exclusive barrier regardless of the limit: it starts only once nothing else is in flight and nothing else starts while it runs, so a source-touching step never interleaves with another step and no step ever runs against a tree another step has dirtied. When the shared budget cap is reached the orchestrator stops dispatching new steps and lets in-flight ones drain, and the surfaced result is chosen by step order rather than completion order, so a failed or budget-stopped pipeline reports the same result regardless of the order steps happened to finish. Separately, a step may set its own `concurrency` to run its prompts in parallel within that one step (the same lever as a top-level `concurrency`); this is independent of `maxStepConcurrency`, has no top-level fallback, and is rejected for `concurrency > 1` together with `allowSourceUpdate` or a batch generator.
```

- [ ] **Step 2: Add concurrency to the worked example `src/examples/pipeline/bugfix.json`**

Add `maxStepConcurrency` to the pipeline task, next to `maxPasses` (so the independent `fix-new` / `fix-rework` siblings and the `commit` / `giveup` siblings can overlap, while `commit` still runs as a barrier):

```json
      "output": "summary",
      "maxPasses": 25,
      "maxStepConcurrency": 2,
      "steps": {
```

Add a within-step `concurrency` to the `verify` step (a non-source, non-batch `jsonl` step, so the combination guards are satisfied), next to its `dependsOn`:

```json
        "verify": {
          "dependsOn": ["fix-new", "fix-rework"],
          "concurrency": 3,
          "promptGenerator": [
```

- [ ] **Step 3: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; the example validates against the schema (the `schema.test.ts` example-files suite parses every config under `src/examples`).

- [ ] **Step 4: Commit**

```bash
git add README.md src/examples/pipeline/bugfix.json
git commit -m "Docs: Document pipeline step parallelism and the source-update barrier"
```

---

## After all sections: roadmap, carry-over, and final commit

These are performed by the orchestrator once Sections 1-4 are committed and the full completion gate is green.

- [ ] **Update `docs/future-plans/roadmap.md`:** mark Step 08 complete in the Sequence list (matching the `- completed` style of steps 1-7), update the "Steps 1 through 7 are complete" sentence to "Steps 1 through 8", and add a link to this as-built plan (`step-08-cross-branch-pipeline-parallelism-plans.md`) alongside the other as-built links. Confirm the remaining sequence (Steps 09-11) still reads correctly: Step 09 (Dashboard) reads the per-step state and report files that remain the source of truth; Step 10 (remote loop state) and Step 11 (S3 handoff) are unaffected by in-process step parallelism.

- [ ] **Clear and repopulate `docs/future-plans/next.md`** as the carry-over for Step 09 (Dashboard). Capture: that `runPipeline` now delegates per-pass scheduling to `schedulePass` in `src/pipeline-schedule.ts`, which overlaps independent steps up to `task.maxStepConcurrency` (default 1), runs any `allowSourceUpdate` step as an exclusive barrier, gates new dispatch on `countAllSpend` against the shared cap and drains in-flight work, and selects the surfaced stop result by canonical step order so results are deterministic under out-of-order completion; that `buildStepConfig` now threads a per-step `concurrency` override (within-step Step 04 lever, no top-level fallback) distinct from `maxStepConcurrency`; that per-step state files (`${name}-loop-state.json`) and report files (`${name}-report.jsonl`) remain the single source of truth for outcome counts and spend, read via `readStateData`/`statePathForStep`/`countAllOutcomes`/`countAllSpend`, which is what a dashboard should read rather than any in-memory pipeline state; and that `structuredOutput` is still deliberately not stored in loop-state (deferred in `conditional-routing-design.md`), so a dashboard wanting verdict history must read the report files, and adding it to loop-state later is the documented enhancement that would give the dashboard a second routing/inspection channel.

- [ ] **Final commit** of the roadmap and next.md updates with a `Docs:` message.

---

## As-built notes

The implementation shipped on `main` (commits `19656e6`, `4d69ac7`, `4713ae3`, `2fb152a`) follows this plan, with the deviations below. The runtime code (`src/pipeline-schedule.ts`, the `runPipeline`/`buildStepConfig` changes, `src/types.ts`, `src/pipeline-spec.ts`, the schema, and `bugfix.json`) matches the plan verbatim; all deviations are in the test files and are coverage- or toolchain-driven, not behavioural.

- Section 1: one extra test, `accepts a step-level concurrency of 1`, was added. The plan's `concurrency` cases all take the `concurrency > 1` true branch or throw before reaching it, leaving the `=== 1` false arm of that guard uncovered. The extra test restores 100% branch coverage; no behaviour changed.

- Section 2: three corrections to the test file. (a) A `// @module-tag local` first line was required; `vitest.config.ts` sets `tagsFilter: ['local']`, so without it every test in the file is silently skipped and no coverage is collected. (b) The `gates` `Record` accesses use bracket form (`gates['a']`), because the repo's tsconfig enables `noPropertyAccessFromIndexSignature` and the plan's dot-access did not compile (TS4111). (c) Two extra tests were added because the plan's verbatim set left three branches uncovered (the `index < stop.index` false arm, the `sourceActive` predicate's right arm, and the source-barrier `active.size > 0` wait): `holds a ready source step until the in-flight non-source step drains` (a source step depending on only one of two independent steps, so it becomes ready while the sibling is still in flight) and `keeps the earliest stop when a later step also stops afterwards` (an earlier-index failure followed by a later-index one, so the second `noteStop` is discarded). The scheduler module itself is unchanged from the plan and carries zero istanbul ignores.

- Section 3: the within-step concurrency proof uses real timers, not the `vi.useFakeTimers()` plus `runPipelineWithFakeTimers` helper the plan sketched. Under fake timers `advanceTimersByTimeAsync` fires the first invocation's `setTimeout` before the other pool workers reach `agent.invoke`, so the overlap is never observable and `maxActive` stays at 1 even when threading is correct; this is exactly why `src/__test__/loop.test.ts`'s own `OverlapAgent` overlap proof uses real timers. The test now runs `runPipeline` under real timers (the agent's real 10ms delay keeps invocations in flight) with the `expect(overlap.maxActive).toBe(3)` assertion unweakened, and the now-unused `runPipelineWithFakeTimers` helper and `LoopRunResult` import were dropped. Threading is genuinely confirmed: `maxActive` is 3, and would be 1 if `buildStepConfig` did not thread `concurrency`.

- Section 4: no deviation.
