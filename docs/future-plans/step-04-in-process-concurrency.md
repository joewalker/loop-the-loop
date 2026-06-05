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
- Keep `interPromptPause` as a per-worker pause.

## Dependencies

- Step 01, for claim and completion semantics plus structured loop results.
- Step 03, so cost and budget stop behavior is designed once for concurrent completion.

## Done when

- `concurrency: 1` preserves current serial behavior.
- Concurrent runs prove multiple agent invocations can overlap.
- Reporter writes are not interleaved or corrupted.
- Stop conditions prevent new pulls while allowing in-flight prompts to finish.
- State snapshots have no lost claims, completions, or cost totals.

## Related plans

- [Optional parallel prompt execution](concurrency.md)
