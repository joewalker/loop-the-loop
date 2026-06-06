import type { Reporter } from '../reporters.js';

/**
 * Wrap a reporter so that `append` calls run one at a time on a promise
 * chain. `appendFile` and similar sinks are not safe under concurrent writes
 * from one process, so the loop inserts this wrapper when `concurrency > 1`.
 *
 * Each call returns the promise for its own append (so the caller still sees
 * an append failure), while the internal chain swallows rejections so one
 * failing append does not wedge the queue or surface as an unhandled
 * rejection. At `concurrency === 1` the loop uses the inner reporter directly,
 * leaving the serial path untouched.
 */
export function serializeReporter(inner: Reporter): Reporter {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(prompt, result) {
      const next = chain.then(() => inner.append(prompt, result));
      chain = next.catch(() => {});
      return next;
    },
  };
}
