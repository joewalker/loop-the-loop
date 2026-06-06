# Step 07 Pipeline-wide Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pipeline enforce a shared USD budget across all its steps. A top-level `maxBudgetUsd` becomes a pipeline-wide shared cap, checked against the aggregate spend across every step's state file before each step is scheduled. A step-level `maxBudgetUsd` override remains a stricter local cap, threaded into that step's own `loop()`. Step-level state stays the single source of persisted per-prompt cost, so the aggregate stop is deterministic on resume.

**Architecture:** Today `runPipeline` in `src/pipeline.ts` reads every step's `${name}-loop-state.json` to detect the fixed point (`countAllOutcomes`/`countOutcomes`). Step 07 adds a parallel `countAllSpend` that sums `totalUsd` from the same files, and consults it in the pass loop before scheduling each step. `buildStepConfig` does not thread `maxBudgetUsd` today (every step runs with `Infinity`); Step 07 threads only a step-level override, leaving the top-level cap to the aggregate check. No new pipeline-task field is needed: the shared cap is the existing top-level `LoopCliConfig.maxBudgetUsd`, and the local cap is a new optional `PipelineStep.maxBudgetUsd`.

**Tech Stack:** TypeScript (strict, ESM, `exactOptionalPropertyTypes`), vitest, ajv (schema test), pnpm. Coverage gate is 100% on non-ignored files; every new branch needs a test.

---

## Carry-over contract from Step 06

Read `docs/future-plans/next.md`, `docs/future-plans/step-06-sequential-pipelines.md`, and `docs/future-plans/step-07-pipeline-wide-budgets.md` before starting. The load-bearing facts and the decisions this plan locks in:

- `runPipeline(config)` is the only consumer of a pipeline; `cli.ts` dispatches `isPipelineSpec(config.promptGenerator) ? runPipeline(config) : loop(config)`. The single-loop path is untouched.
- Each step keeps its own append-only v2 loop-state, `{ version, results, claims, totalUsd }`. `totalUsd` is the lifetime total across resumes (Step 03), accumulated by `FileLoopState` whenever a result carries a `cost`. Rework uses attempt-scoped ids (`bug-1`, `bug-1#2`, ...), so summing `totalUsd` across steps counts every attempt including failed-and-retried work, which is exactly the true cost of rework.
- `runPipeline` already reads each step's state file to count outcomes for the fixed-point check (`countAllOutcomes` -> `countOutcomes`; a missing file is zero). Step 07's `countAllSpend` follows the identical shape over `totalUsd`.
- `buildStepConfig(config, task, key)` synthesises each step's `LoopCliConfig` by shallow-merging top-level defaults, the step's own fields, then the derived `name = ${config.name}-${key}`. It inherits exactly `agent`, `reporter`, `outputDir`, `allowSourceUpdate`, `maxPrompts`, `interPromptPause`, `logger`. It deliberately does NOT thread `maxBudgetUsd`. This is the seam Step 07 changes for the local-override case.
- The strict failure policy already stops the pipeline on any non-`completed` step result, annotated with the step name. A step-level `maxBudgetUsd` that trips inside `loop()` returns `{ status: 'stopped', reason: 'maxBudgetUsd' }` and therefore already stops the pipeline through this path once `buildStepConfig` threads the override.
- Pipeline tests (`src/__test__/pipeline.test.ts`) drive `runPipeline` with `test` agents and real seed/report files in a temp dir, building configs through `normalizeCliConfig`, and set top-level `interPromptPause: 0` (inherited by every step) so the real `setTimeout` pause in `loop()` does not fire. Step 07 tests do the same. The `test` agent returns its canned `InvokeResult` verbatim, and `SuccessfulInvocationResult.cost` is optional, so a response `{ status: 'success', output: 'ok', cost: { usd: 1, costSource: 'provider' } }` produces $1 of recorded spend per prompt.
- Coverage is enforced at 100% in `vitest.config.ts`. The existing pipeline files use a few deliberate `/* istanbul ignore */` markers on genuinely unreachable defensive branches (the non-completed-result message fallback, the non-ENOENT state-read re-throw, the CLI entry-point guard). Step 07 preserves the ENOENT marker by folding both reads into one helper.

## Design decisions locked in by this plan

1. **Two distinct caps with distinct mechanisms.** Top-level `LoopCliConfig.maxBudgetUsd` is the pipeline-wide shared cap, enforced only by the aggregate check in `runPipeline`. A new optional `PipelineStep.maxBudgetUsd` is a stricter local cap, threaded into that step's `loop()` by `buildStepConfig`. The top-level cap is never inherited into a step's `loop()` config (that would let each step independently spend up to the full cap). The two coexist: a step may carry a local override while the pipeline also enforces the shared cap.

2. **The aggregate is read from state files, never tracked in memory.** `countAllSpend` sums `totalUsd` across every step's v2 state file (missing file is zero), mirroring `countAllOutcomes`. Because resume re-runs every step to the fixed point and settled steps yield nothing new, re-reading the state files gives the same aggregate, so an aggregate budget stop is deterministic on resume. This satisfies the "deterministic on resume" done-criterion directly.

3. **The aggregate check runs at the top of each step iteration, before `buildStepConfig` and `loop()`.** This stops scheduling new steps the moment upstream spend reaches the cap, and because it also runs before the very first step of pass 1, a resumed pipeline whose persisted aggregate already exceeds the cap stops immediately before any step re-runs. A running step is governed only by its own (optional) local cap; the aggregate is re-checked after it completes, on the next iteration. This matches the Step 07 doc's "stop scheduling new steps when the aggregate total reaches the cap" and "for a currently running step, rely on the step's normal budget behavior and update the aggregate after it completes."

4. **A finite cap gates the read.** When the top-level `maxBudgetUsd` is omitted (`Infinity`), the aggregate check is skipped entirely, so every existing pipeline behaves byte-for-byte as today and pays no extra state reads. The `aggregateCap !== Infinity` branch's false side is covered by all existing pipeline tests; its true side by the new tests.

5. **Aggregate stop surfaces spend and reason.** The stop returns `{ status: 'stopped', reason: 'maxBudgetUsd', message: 'Pipeline budget reached before step "<name>": $<spend> >= $<cap>' }`. A step-level override that trips inside `loop()` instead surfaces through the existing strict-policy wrapper as `{ status: 'stopped', reason: 'maxBudgetUsd', message: 'Pipeline stopped at step "<name>": ...' }`.

6. **One shared state-file reader.** `countOutcomes` is replaced by `readStateData(statePath): { outcomes, totalUsd }`, parsed once, with a single ENOENT defensive branch. `countAllOutcomes` and `countAllSpend` both call it via a shared `statePathForStep` helper, so there is exactly one `/* istanbul ignore */` for the non-ENOENT re-throw rather than two.

## File structure

Modified:

- `src/types.ts` - add optional `maxBudgetUsd?: number` to `PipelineStep`.
- `src/pipeline-spec.ts` - accept and validate `maxBudgetUsd` in `assertStep`.
- `src/pipeline.ts` - `countAllSpend`, `readStateData` (replacing `countOutcomes`), `statePathForStep`; the aggregate check in the pass loop; thread `step.maxBudgetUsd` in `buildStepConfig`.
- `schema/loop-the-loop.schema.json` - add `maxBudgetUsd` to `pipelineStep`.
- `src/__test__/pipeline-spec.test.ts` - positive and negative `maxBudgetUsd` step cases.
- `src/__test__/pipeline.test.ts` - shared-cap, step-override, resume, and no-cost cases.
- `src/__test__/schema.test.ts` - a positive case carrying top-level and step-level `maxBudgetUsd`.
- `src/examples/pipeline/bugfix.json` - add a top-level shared cap and one step-level override, to make the feature discoverable (validated automatically by the schema test).
- `README.md` - a "Pipelines" budget paragraph.

No new files are created.

## Execution and commit protocol

Each section below is self-contained and ends with a commit. Sections are ordered so the build stays green (`pnpm tsc && pnpm test --coverage` clean, 100% coverage) after every commit. Dispatch one fresh sub-agent per section. Between sections the orchestrator runs the completion gate and reviews the diff before starting the next section.

Per AGENTS.md: stay on the `main` branch, do not open PRs, never run `git add`/`git mv`/`git rm` outside the commit step, use the default `~/.gitconfig` author, and do NOT add a `Co-Authored-By` trailer. Commit message tags follow recent history (`Feature:`, `Fix:`, `Docs:`). Before each commit run `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`. Do not pipe test output through `| tail`.

Section ordering rationale: Section 1 adds the step-level config surface (type, validation, schema) with nothing reading it yet, keeping the tree green and the schema in lockstep. Section 2 adds the runtime that consumes the new field plus the aggregate check over the existing top-level field. Section 3 documents the feature and updates the worked example once the runtime supports it end-to-end.

---

## Section 1: Step-level `maxBudgetUsd` config surface

Add the optional local-cap field to a pipeline step, validate it, and keep the schema in lockstep. No runtime wires it yet; the field is an inert optional until Section 2.

**Files:**

- Modify: `src/types.ts`, `src/pipeline-spec.ts`, `schema/loop-the-loop.schema.json`
- Test: `src/__test__/pipeline-spec.test.ts`, `src/__test__/schema.test.ts`

- [ ] **Step 1: Write the failing spec-module tests**

Add to the `describe('normalizePipelineTaskConfig', ...)` block in `src/__test__/pipeline-spec.test.ts`:

```ts
  it('accepts a step-level maxBudgetUsd', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: { promptGenerator: ['test', {}], maxBudgetUsd: 2.5 },
        },
      }),
    ).not.toThrow();
  });

  it('rejects a non-positive step maxBudgetUsd', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: { promptGenerator: ['test', {}], maxBudgetUsd: 0 },
        },
      }),
    ).toThrow('pipeline.steps.a.maxBudgetUsd must be a positive number');
  });

  it('rejects a non-number step maxBudgetUsd', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: { promptGenerator: ['test', {}], maxBudgetUsd: 'lots' },
        },
      }),
    ).toThrow('pipeline.steps.a.maxBudgetUsd must be a positive number');
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/__test__/pipeline-spec.test.ts`
Expected: FAIL - `maxBudgetUsd` is currently rejected as an unknown step property, and the positive case throws.

- [ ] **Step 3: Add `maxBudgetUsd` to `PipelineStep` in `src/types.ts`**

Add the field to the `PipelineStep` interface, next to `maxPrompts`:

```ts
  readonly maxPrompts?: number;

  /**
   * Stricter local USD budget for this step alone, passed into the step's
   * `loop()`. Independent of the pipeline-wide shared cap (a top-level
   * `maxBudgetUsd`), which is enforced across all steps by the orchestrator.
   */
  readonly maxBudgetUsd?: number;
```

- [ ] **Step 4: Accept and validate `maxBudgetUsd` in `assertStep` in `src/pipeline-spec.ts`**

Add `'maxBudgetUsd'` to the `assertKnownProperties` list (after `'maxPrompts'`):

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
      'interPromptPause',
      'logger',
      'dependsOn',
    ],
    `pipeline.steps.${key}`,
  );
```

Add a validation block after the `dependsOn` validation (still inside `assertStep`):

```ts
  if ('maxBudgetUsd' in step) {
    const maxBudgetUsd = step['maxBudgetUsd'];
    if (typeof maxBudgetUsd !== 'number' || !(maxBudgetUsd > 0)) {
      throw new Error(
        `pipeline.steps.${key}.maxBudgetUsd must be a positive number`,
      );
    }
  }
```

(The `!(x > 0)` form rejects `0`, negatives, and `NaN` in one predicate.)

- [ ] **Step 5: Add `maxBudgetUsd` to the schema**

In `schema/loop-the-loop.schema.json`, add to the `pipelineStep` `properties` block (after `maxPrompts`), mirroring the top-level `maxBudgetUsd` constraints:

```json
        "maxPrompts": { "type": "integer", "minimum": 0 },
        "maxBudgetUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "description": "Stricter local USD budget for this step alone. Independent of the pipeline-wide shared cap set by a top-level maxBudgetUsd."
        },
```

- [ ] **Step 6: Add a schema positive case in `src/__test__/schema.test.ts`**

Add to the positive-cases array a pipeline carrying both a top-level shared cap and a step-level override:

```ts
      [
        'pipeline with shared and step-level budgets',
        {
          name: 'budgeted',
          agent: 'claude-sdk',
          reporter: 'jsonl-report',
          maxBudgetUsd: 10,
          promptGenerator: [
            'pipeline',
            {
              output: 'verify',
              steps: {
                fix: {
                  maxBudgetUsd: 4,
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
Expected: all green; `pipeline-spec.ts` at 100% (both the accept and the two reject branches of the new validation are exercised).

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/pipeline-spec.ts schema/loop-the-loop.schema.json src/__test__/pipeline-spec.test.ts src/__test__/schema.test.ts
git commit -m "Feature: Add step-level maxBudgetUsd to the pipeline step config surface"
```

---

## Section 2: Pipeline-wide aggregate budget runtime

Wire the two caps into `runPipeline`: thread the step-level override into `buildStepConfig`, fold the state read into one helper, add `countAllSpend`, and check the aggregate against the top-level shared cap before scheduling each step.

**Files:**

- Modify: `src/pipeline.ts`
- Test: `src/__test__/pipeline.test.ts`

- [ ] **Step 1: Write the failing runtime tests**

Add to `src/__test__/pipeline.test.ts`. First add a costed agent constant near the existing `successAgent`/`reworkAgent` declarations:

```ts
  const costAgent = [
    'test',
    {
      responses: [
        {
          status: 'success',
          output: 'ok',
          cost: { usd: 1, costSource: 'provider' },
        },
      ],
      repeat: 'cycle',
    },
  ];
```

Then add these cases inside the `describe('runPipeline', ...)` block:

```ts
  it('stops before a downstream step when the shared cap is reached', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'cap',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      maxBudgetUsd: 1,
      promptGenerator: [
        'pipeline',
        {
          output: 'fix',
          steps: {
            review: {
              agent: costAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
              ],
            },
            fix: {
              agent: costAgent,
              dependsOn: ['review'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'fix {{id}}',
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
    expect(result.message).toMatch(/Pipeline budget reached before step "cap-fix"/u);
    // review ran and spent $1; fix never ran.
    expect(await readReportIds('cap-review')).toEqual(['bug-1']);
    expect(await readReportIds('cap-fix')).toEqual([]);
  });

  it('honours a stricter step-level maxBudgetUsd via the step loop', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n${JSON.stringify({
        id: 'b',
        status: 'success',
      })}\n`,
    );
    const config = await normalize({
      name: 'local',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              agent: costAgent,
              maxBudgetUsd: 1,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    // The step's own loop stopped after the first $1 prompt; the strict policy
    // surfaces it annotated with the step name. Without buildStepConfig
    // threading the override the step would run with Infinity and complete.
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('maxBudgetUsd');
    expect(result.message).toMatch(/Pipeline stopped at step "local-only"/u);
    expect(await readReportIds('local-only')).toEqual(['a']);
  });

  it('is deterministic on resume after a shared-cap stop', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const make = async (): Promise<LoopCliConfig> =>
      normalize({
        name: 'res',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        interPromptPause: 0,
        maxBudgetUsd: 1,
        promptGenerator: [
          'pipeline',
          {
            output: 'fix',
            steps: {
              review: {
                agent: costAgent,
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
                ],
              },
              fix: {
                agent: costAgent,
                dependsOn: ['review'],
                promptGenerator: [
                  'jsonl',
                  {
                    dataFile: '{{steps.review.report}}',
                    promptTemplate: 'fix {{id}}',
                  },
                ],
              },
            },
          },
        ],
      } as unknown as LoopCliConfig);

    const first = await runPipeline(await make());
    expect(first.reason).toBe('maxBudgetUsd');
    const reviewIds = await readReportIds('res-review');

    // Resume: the persisted aggregate ($1) already meets the cap, so the
    // pipeline stops before review even re-runs, deterministically.
    const second = await runPipeline(await make());
    expect(second.status).toBe('stopped');
    expect(second.reason).toBe('maxBudgetUsd');
    expect(second.message).toMatch(/before step "res-review"/u);
    expect(await readReportIds('res-review')).toEqual(reviewIds);
    expect(await readReportIds('res-fix')).toEqual([]);
  });

  it('completes under a shared cap when results carry no cost', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'free',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      maxBudgetUsd: 5,
      promptGenerator: [
        'pipeline',
        {
          output: 'fix',
          steps: {
            review: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
              ],
            },
            fix: {
              agent: successAgent,
              dependsOn: ['review'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'fix {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    // No cost recorded, so the aggregate stays $0 and the finite cap never
    // trips; the pipeline runs to its normal fixed point.
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('free-review')).toEqual(['x']);
    expect(await readReportIds('free-fix')).toEqual(['x']);
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/__test__/pipeline.test.ts`
Expected: FAIL - the shared cap is not enforced (the pipeline completes instead of stopping), and the step-level override is not threaded (the step completes both prompts).

- [ ] **Step 3: Thread the step-level override in `buildStepConfig`**

In `src/pipeline.ts`, inside `buildStepConfig`, read the override and include it in the returned config (mirroring `maxPrompts`):

```ts
  const maxPrompts = step.maxPrompts ?? config.maxPrompts;
  const maxBudgetUsd = step.maxBudgetUsd;
  const interPromptPause = step.interPromptPause ?? config.interPromptPause;
```

```ts
    ...(maxPrompts !== undefined ? { maxPrompts } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(interPromptPause !== undefined ? { interPromptPause } : {}),
```

Note: there is no `?? config.maxBudgetUsd` fallback. The top-level cap is the shared aggregate cap, not a per-step default, so only an explicit step override flows into a step's `loop()`.

- [ ] **Step 4: Fold the state read into one helper and add `countAllSpend`**

Replace `countOutcomes` with a `readStateData` helper that parses each state file once and returns both numbers, add a `statePathForStep` helper, and rewrite `countAllOutcomes` to use them. Add `countAllSpend` alongside.

Replace the existing `countAllOutcomes` and `countOutcomes` functions with:

```ts
/**
 * The on-disk state path for one step, derived the same way `loop()` derives
 * it from the synthesised step config.
 */
function statePathForStep(
  config: LoopCliConfig,
  task: PipelineTask,
  key: string,
): string {
  const stepConfig = buildStepConfig(config, task, key);
  const dir = stepConfig.outputDir ?? process.cwd();
  return resolve(dir, `${stepConfig.name}-loop-state.json`);
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
    total += (await readStateData(statePathForStep(config, task, key))).outcomes;
  }
  return total;
}

/**
 * Total USD spend recorded across all steps' state files. Summing each step's
 * lifetime `totalUsd` gives the pipeline-wide aggregate the shared budget cap
 * is checked against. Read from disk so the result is deterministic on resume.
 */
async function countAllSpend(
  config: LoopCliConfig,
  task: PipelineTask,
  stepKeys: ReadonlyArray<string>,
): Promise<number> {
  let total = 0;
  for (const key of stepKeys) {
    total += (await readStateData(statePathForStep(config, task, key))).totalUsd;
  }
  return total;
}

/**
 * Read one v2 state file once, returning both its outcome count and its
 * lifetime `totalUsd`. A missing file is zero on both (the step has not run,
 * or produced nothing).
 */
async function readStateData(
  statePath: string,
): Promise<{ outcomes: number; totalUsd: number }> {
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf-8');
  } catch (err) {
    /* istanbul ignore if -- a missing state file is the only read error
       exercised; other read errors are defensive re-throws. */
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
      throw err;
    }
    return { outcomes: 0, totalUsd: 0 };
  }
  const data = JSON.parse(raw) as {
    results?: Record<string, unknown>;
    totalUsd?: number;
  };
  return {
    outcomes: data.results ? Object.keys(data.results).length : 0,
    totalUsd: typeof data.totalUsd === 'number' ? data.totalUsd : 0,
  };
}
```

- [ ] **Step 5: Add the aggregate check to the pass loop in `runPipeline`**

After computing `maxPasses`, derive the cap once:

```ts
  const stepKeys = orderStepKeys(task);
  const maxPasses = task.maxPasses ?? DEFAULT_MAX_PASSES;
  const aggregateCap = config.maxBudgetUsd ?? Infinity;
```

At the top of the inner `for (const key of stepKeys)` loop, before `buildStepConfig`, add the check:

```ts
    for (const key of stepKeys) {
      if (aggregateCap !== Infinity) {
        const spend = await countAllSpend(config, task, stepKeys);
        if (spend >= aggregateCap) {
          const name = `${config.name}-${key}`;
          const message = `Pipeline budget reached before step "${name}": $${spend.toFixed(
            4,
          )} >= $${aggregateCap}`;
          return { status: 'stopped', reason: 'maxBudgetUsd', message };
        }
      }
      const stepConfig = buildStepConfig(config, task, key);
      const result = await loop(stepConfig);
      // ... existing non-completed handling unchanged ...
    }
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm test src/__test__/pipeline.test.ts`
Expected: PASS - shared-cap stop, step-override stop, deterministic resume, and no-cost completion all hold.

- [ ] **Step 7: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; `pipeline.ts` at 100%. Branch coverage to confirm:
- `aggregateCap !== Infinity` true (new tests) and false (all existing pipeline tests).
- `spend >= aggregateCap` true (shared-cap and resume tests) and false (no-cost test, and the review iteration of the shared-cap test).
- `buildStepConfig` `maxBudgetUsd !== undefined` true (step-override test) and false (everything else).
- `readStateData` `data.results ? ...` and `typeof data.totalUsd === 'number' ? ...` both sides: true sides from costed/outcome-bearing files, false sides from the existing `{ version: 2 }` pre-seed test.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline.ts src/__test__/pipeline.test.ts
git commit -m "Feature: Enforce a pipeline-wide shared budget with step-level overrides"
```

---

## Section 3: Documentation and worked example

Document both caps and update the worked example so the feature is discoverable. The schema test validates the example automatically.

**Files:**

- Modify: `README.md`, `src/examples/pipeline/bugfix.json`

- [ ] **Step 1: Add a budget paragraph to the README "Pipelines" section**

In `README.md`, after the fixed-point/resume paragraph (the one ending "a settled pipeline fast-forwards and adds nothing.") and before the `See src/examples/pipeline/bugfix.json` line, add:

```markdown
A pipeline can also cap spend. A top-level `maxBudgetUsd` is a pipeline-wide shared budget: before scheduling each step the orchestrator sums the lifetime `totalUsd` across every step's state file, and once that aggregate reaches the cap it stops scheduling new steps and returns a stopped result whose message carries the aggregate spend. A running step is governed only by its own budget, so the aggregate is re-checked after it completes rather than mid-step. A step may set its own stricter `maxBudgetUsd` as a local cap, which is enforced inside that step's loop and, when it trips, stops the pipeline under the strict policy. Because the aggregate is read from the per-step state files rather than tracked in memory, a resumed pipeline whose persisted spend already crosses the cap stops deterministically before any step re-runs.
```

- [ ] **Step 2: Add budgets to the worked example `src/examples/pipeline/bugfix.json`**

Add a top-level shared cap next to the existing top-level fields, and a stricter local cap on the source-touching `commit` step. Add `"maxBudgetUsd": 20,` after the `"reporter": "jsonl-report",` line:

```json
  "name": "bugfix",
  "agent": "claude-sdk",
  "reporter": "jsonl-report",
  "maxBudgetUsd": 20,
```

And add `"maxBudgetUsd": 5,` to the `commit` step, next to its `allowSourceUpdate`:

```json
        "commit": {
          "allowSourceUpdate": true,
          "maxBudgetUsd": 5,
          "dependsOn": ["verify"],
```

(The schema test in `src/__test__/schema.test.ts` validates every example under `src/examples`, so this exercises the new schema field against a real config.)

- [ ] **Step 3: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; the example validates against the schema.

- [ ] **Step 4: Commit**

```bash
git add README.md src/examples/pipeline/bugfix.json
git commit -m "Docs: Document pipeline-wide and step-level budgets with a worked example"
```

---

## After all sections: roadmap, carry-over, and final commit

These are performed by the orchestrator once Sections 1-3 are committed and the full completion gate is green.

- [ ] **Update `docs/future-plans/roadmap.md`:** mark Step 07 complete in the Sequence list (matching the `- completed` style of steps 1-6), update the "Steps 1 through 6 are complete" sentence to "Steps 1 through 7", and add a link to this as-built plan (`step-07-pipeline-wide-budgets-plans.md`) alongside the other as-built links. Confirm the rest of the sequence (Steps 08-11) still reads correctly given the as-built topology (more, smaller steps per pipeline; aggregate budget read from state files).

- [ ] **Clear and repopulate `docs/future-plans/next.md`** as the carry-over for Step 08 (cross-branch pipeline parallelism). Capture: that `runPipeline` runs steps strictly sequentially within a pass today and the aggregate budget check sits between steps; that `buildStepConfig` still does not thread `concurrency` (Step 08's seam, exactly as Step 07 left `maxBudgetUsd`); that the aggregate spend / fixed-point counts are read from per-step state files via `readStateData`/`statePathForStep`/`countAllSpend`/`countAllOutcomes`, which a parallel scheduler must keep correct; that the strict failure policy stops on the first non-`completed` step and how that interacts with concurrently running branches; and that pipelines now tend to have more, smaller steps (Step 06 fan-in note).

- [ ] **Final commit** of the roadmap and next.md updates with a `Docs:` message.
