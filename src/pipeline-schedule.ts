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
