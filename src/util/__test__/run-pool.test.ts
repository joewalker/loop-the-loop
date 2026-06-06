// @module-tag local

import { runPool } from 'loop-the-loop/util/run-pool';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A plain async iterable over a fixed list, yielding each item on a
 * microtask (no timers).
 */
async function* toAsync<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * An async iterable that waits `ms` (real timer) before each yield, so a
 * worker can be observed blocked inside `iterator.next()`.
 */
async function* slowAsync<T>(
  items: ReadonlyArray<T>,
  ms: number,
): AsyncIterable<T> {
  for (const item of items) {
    await new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
    yield item;
  }
}

const realDelay = (ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

describe('runPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with concurrency 1 processes every item in order', async () => {
    const seen: Array<number> = [];
    await runPool(toAsync([1, 2, 3]), 1, async item => {
      seen.push(item);
      return 'continue';
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('runs more than one work callback at a time when concurrency > 1', async () => {
    let active = 0;
    let maxActive = 0;
    const processed: Array<number> = [];
    await runPool(toAsync([1, 2, 3, 4]), 2, async item => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await realDelay(10);
      processed.push(item);
      active -= 1;
      return 'continue';
    });
    expect(maxActive).toBe(2);
    expect([...processed].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('lets in-flight work drain after one returns stop, then stops pulling', async () => {
    const processed: Array<number> = [];
    await runPool(toAsync([1, 2, 3, 4, 5, 6]), 2, async item => {
      processed.push(item);
      await realDelay(5);
      return item === 1 ? 'stop' : 'continue';
    });
    // Workers 0 and 1 pull 1 and 2 concurrently. Worker 0 returns stop; the
    // in-flight item 2 still finishes, but no item past 2 is pulled.
    expect(processed).toEqual([1, 2]);
  });

  it('discards an item pulled by a worker that wakes to find stop set', async () => {
    const processed: Array<number> = [];
    await runPool(slowAsync([1, 2, 3], 5), 2, async item => {
      processed.push(item);
      return item === 1 ? 'stop' : 'continue';
    });
    // The shared iterator serialises next(): worker 0 gets item 1 first and
    // returns stop. Worker 1's next() then resolves with item 2, but it sees
    // stop set and returns without calling work.
    expect(processed).toEqual([1]);
  });

  it('propagates an error thrown by work', async () => {
    await expect(
      runPool(toAsync([1, 2]), 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('delays workers after the first by staggerSeconds before their first pull', async () => {
    vi.useFakeTimers();
    const seen: Array<number> = [];
    const done = runPool(
      toAsync([1, 2, 3, 4]),
      2,
      async item => {
        seen.push(item);
        return 'continue';
      },
      { staggerSeconds: 1 },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});
