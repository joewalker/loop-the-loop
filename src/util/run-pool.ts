/**
 * A dependency-free worker pool that runs an async `work` callback over the
 * items of an async iterable with bounded concurrency.
 *
 * `concurrency` workers share a single iterator obtained from `source`.
 * JavaScript serialises concurrent `.next()` calls on one async generator, so
 * items are produced one at a time and consumed by whichever worker is free.
 *
 * When `work` returns `'stop'`, the shared `stop` flag is set: no worker pulls
 * a new item, but any worker already running `work` is allowed to finish (the
 * in-flight prompts drain). A worker blocked inside `iterator.next()` when
 * `stop` is set discards the item it receives; that item was never claimed, so
 * a later run re-yields it.
 *
 * The helper is intentionally free of agents, reporters, and loop state so it
 * can be unit-tested in isolation.
 */
export async function runPool<T>(
  source: AsyncIterable<T>,
  concurrency: number,
  work: (item: T, workerIndex: number) => Promise<'continue' | 'stop'>,
  options?: { readonly staggerSeconds?: number },
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  const staggerSeconds = options?.staggerSeconds ?? 0;
  let stop = false;

  async function worker(workerIndex: number): Promise<void> {
    if (staggerSeconds > 0 && workerIndex > 0) {
      await delay(workerIndex * staggerSeconds * 1_000);
    }
    while (!stop) {
      const { done, value } = await iterator.next();
      if (done === true || stop) {
        return;
      }
      const outcome = await work(value, workerIndex);
      if (outcome === 'stop') {
        stop = true;
        return;
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < concurrency; index += 1) {
    workers.push(worker(index));
  }
  await Promise.all(workers);
}

/**
 * Resolve after `ms` milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}
