# Step 04: In-process concurrency

## Goal

Allow one loop process to run multiple prompts concurrently while preserving claim ownership, reporter integrity, budget behavior, and clear stop semantics.

## Work

- Add `concurrency` to config, CLI parsing, and schema.
- Add a small tested worker-pool helper.
- Convert the loop body into a work callback that can run in the pool.
- Reject `concurrency > 1` with `allowSourceUpdate: true`.
- Reject `concurrency > 1` with the batch prompt generator.
- Serialize reporter appends when concurrency is greater than 1.
- Treat `maxPrompts`, `maxBudgetUsd`, errors, and too many glitches as completion-order stop conditions with in-flight work allowed to drain.
- Keep `interPromptPause` as a per-worker pause: each in-flight slot pauses after its prompt before pulling the next.
- Stagger worker startup so the initial burst is spread across the pause window: worker k delays roughly `k * (interPromptPause / concurrency)` before its first pull, only when `interPromptPause > 0` and `concurrency > 1`.

## Design

A single new top-level `concurrency` field (default `1`, matching today's behaviour byte-for-byte) plus a `--concurrency N` flag. When `concurrency > 1`, up to N prompts are in flight at once. All workers share one `runId` and claim multiple prompt ids under that run, so the v2 state shape (Step 01) is unchanged.

Startup validation in `loopImpl`, before anything else:

- `concurrency < 1` or non-integer throws `Invalid concurrency: ${value}`.
- `concurrency > 1` with `allowSourceUpdate: true` throws, because git commits cannot safely interleave.
- `concurrency > 1` with the batch generator throws, because summary prompts read the report file and would race with in-flight batch items. Detect via `instanceof BatchPromptGenerator`.

All other generators yield each id exactly once per run, so they are safe with concurrent consumption.

## Worker pool

New dependency-free helper `src/util/run-pool.ts`:

```ts
export async function runPool<T>(
  source: AsyncIterable<T>,
  concurrency: number,
  work: (item: T, workerIndex: number) => Promise<'continue' | 'stop'>,
  options?: { staggerSeconds?: number },
): Promise<void>;
```

It obtains one shared `AsyncIterator` from `source[Symbol.asyncIterator]()`; N workers each loop `while (!stop) { const { done, value } = await iter.next(); if (done || stop) return; ... }`. JavaScript queues concurrent `.next()` calls on a single generator instance, so source items are produced serially and consumed by whichever worker is free. `stop` is a closed-over boolean set when `work` returns `'stop'`. Keeping it separate lets the pool be unit-tested without agents, reporters, or state.

## Reporter serialization

`appendFile` is not safe under concurrent writes from one process. When `concurrency > 1`, the runner wraps the reporter so appends run on a promise chain:

```ts
function serializeReporter(inner: Reporter): Reporter {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(prompt, result) {
      const next = chain.then(() => inner.append(prompt, result));
      chain = next.catch(() => {});
      return next;
    },
  };
}
```

At `concurrency === 1` the reporter is used directly so the serial path is unchanged. The wrapper protects custom user reporters too.

## Stop semantics

`maxPrompts`, `maxBudgetUsd`, an error result, and too many glitches are completion-order stop conditions: set `stop`, let in-flight prompts drain, then surface the structured `LoopRunResult` (Step 01). The glitch counter is a single shared counter; "consecutive" under concurrency means in completion order, not dispatch order, and a one-line code comment should say so.

## CLI and schema

`--concurrency N` parses like `--max-prompts` but rejects `n < 1` (`0` would deadlock the pool). Schema: `concurrency` is an `integer`, `minimum: 1`, `default: 1`.

## Interface docs

- `PromptGenerator`: under `concurrency > 1`, multiple yielded items may be in flight at once; generators must yield each id once per run and must not rely on `isOutstanding` reflecting items yielded earlier in the same run.
- `Reporter`: appends are serialized when `concurrency > 1`, so implementations may assume non-overlapping calls.

## Dependencies

- Step 01, for claim and completion semantics plus structured loop results.
- Step 03, so cost and budget stop behavior is designed once for concurrent completion.

## Done when

- `concurrency: 1` preserves current serial behavior.
- Concurrent runs prove multiple agent invocations can overlap.
- Reporter writes are not interleaved or corrupted.
- Stop conditions prevent new pulls while allowing in-flight prompts to finish.
- State snapshots have no lost claims, completions, or cost totals.

## Known limitations

- `interPromptPause` is per worker, not a global rate limit. N workers each pausing independently is not equivalent to a token-bucket limit across the whole run, so the effective request rate rises with concurrency. True global rate limiting is out of scope; users who need a real rate limit should configure it on the agent.
- Claim cleanup on interruption is best-effort. A hard crash or `kill -9` can leave the run's `claims` entries behind, and a stale claim blocks a later run from re-claiming that prompt id. Lease or TTL pruning is deferred, so recovery is manual operator cleanup for now. Step 10 owns the release lifecycle and carries this caveat in full.

## Out of scope

- Global rate limiting (a token bucket across workers). Future change.
- Parallelizing inside the batch generator (fork-join over a batch's items, with the summary as a barrier). Future change if needed.
- Cross-process or `worker_threads` concurrency. The pool is in-process async; cross-process coordination is Step 10 via shared state.

## Tests

- `src/util/__test__/run-pool.test.ts`: single worker behaves like serial; multiple workers overlap; `stop` halts new pulls; drain completes in-flight items; errors from `work` propagate.
- `loop.test.ts`: `concurrency: 3` shows overlap; `concurrency: 2` with `allowSourceUpdate` and with the batch generator each reject at startup; a sleeping reporter shows no interleaved `append`; the glitch counter aborts after the cap in completion order; error-then-drain returns the error result; the new cases drive real timers with `interPromptPause: 0`.
- `load-cli-config.test.ts`: `--concurrency` parsing including the `0` and negative rejections.
- `schema.test.ts`: `concurrency: 4` validates; `0` and `-1` fail.

## Files

- `src/types.ts` (`concurrency` on `LoopCliConfig` / `LoopConfig`), `src/util/run-pool.ts` (new), `src/loop.ts` (validation, pool driver, reporter serialization, shared counters, stagger), `src/util/load-cli-config.ts` (`--concurrency`), `src/cli.ts` (usage), the `PromptGenerator` and `Reporter` interface doc notes, and `schema/loop-the-loop.schema.json`.
