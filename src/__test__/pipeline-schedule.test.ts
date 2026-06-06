// @module-tag local
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
    gates['a'].resolve();
    await tick();
    expect(order).toEqual(['a', 'b']);
    gates['b'].resolve();
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
    gates['a'].resolve();
    gates['b'].resolve();
    await tick();
    expect(sourceSawActive).toBe(1); // s ran alone
    gates['s'].resolve();
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
    gates['s'].resolve();
    await tick();
    expect(order).toEqual(['s', 't']);
    gates['t'].resolve();
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
      return {
        status: 'failed',
        reason: 'errorResult',
        message: `boom-${step.key}`,
      };
    };
    const promise = schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    gates['b'].resolve(); // b fails first (later in order)
    await tick();
    gates['a'].resolve(); // a fails second (earlier in order)
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
    expect(reasonOnly?.message).toBe(
      'Pipeline stopped at step "p-a": maxPrompts',
    );

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

  it('holds a ready source step until the in-flight non-source step drains', async () => {
    // s depends only on a, so s becomes ready while the independent b is still
    // in flight. This exercises the source-barrier wait branch (`active.size >
    // 0` true before the barrier launches) and the `sourceActive` predicate's
    // right arm (`active.has(b) && b.isSource === false`).
    const order: Array<string> = [];
    let sourceSawActive = -1;
    let active = 0;
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
      s: deferred(),
    };
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      order.push(step.key);
      active += 1;
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
        { key: 's', deps: ['a'], source: true },
      ]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    // a and b launch; s is ready once a finishes but must wait for b to drain.
    expect(order).toEqual(['a', 'b']);
    gates['a'].resolve();
    await tick();
    // a is done and s is ready, but b is still in flight so s is held back.
    expect(order).toEqual(['a', 'b']);
    gates['b'].resolve();
    await tick();
    expect(order).toEqual(['a', 'b', 's']);
    expect(sourceSawActive).toBe(1); // s only started once b had drained
    gates['s'].resolve();
    expect(await promise).toBeUndefined();
  });

  it('keeps the earliest stop when a later step also stops afterwards', async () => {
    // a fails first (smaller index), then b fails second (larger index). The
    // second `noteStop` must be discarded, exercising the `index < stop.index`
    // false arm so the earliest-in-order stop is retained.
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
    };
    const runStep = async (step: PassStep): Promise<LoopRunResult> => {
      await gates[step.key].promise;
      return {
        status: 'failed',
        reason: 'errorResult',
        message: `boom-${step.key}`,
      };
    };
    const promise = schedulePass({
      steps: steps([{ key: 'a' }, { key: 'b' }]),
      maxStepConcurrency: 2,
      aggregateCap: Infinity,
      runStep,
      readSpend: async () => 0,
    });
    gates['a'].resolve(); // a fails first (earlier in order)
    await tick();
    gates['b'].resolve(); // b fails second (later in order, must not replace a)
    const result = await promise;
    expect(result).toEqual({
      status: 'failed',
      reason: 'errorResult',
      message: 'Pipeline stopped at step "p-a": boom-a',
    });
  });
});
