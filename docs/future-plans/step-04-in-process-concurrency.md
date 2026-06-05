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

## Related plans

- [Optional parallel prompt execution](concurrency.md)
