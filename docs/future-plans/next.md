# Carry-over context for Step 05 (reader generators plus local handoff)

Steps 01 through 04 are complete on `main`. This records what Step 05 needs to know from Step 04's in-process concurrency work. The Step 04 design lives in `step-04-in-process-concurrency.md` and the as-built task breakdown in `step-04-in-process-concurrency-plans.md`; only the parts that touch Step 05 are repeated here.

## The loop body is now a worker-pool callback, not a `for await`

`loopImpl` in `src/loop.ts` no longer iterates the generator with a sequential `for await`. It drives `promptGenerator.generate(loopState)` through `runPool` (`src/util/run-pool.ts`), an in-process worker pool: N workers share one async iterator, and the per-prompt body is an `async (prompt) => 'continue' | 'stop'` callback. Stop conditions (`maxPrompts`, `maxBudgetUsd`, an error result, too many glitches) set a closed-over `stopResult` and return `'stop'`; the pool stops pulling, in-flight prompts drain, and `loopImpl` returns `stopResult ?? { status: 'completed' }`. At `concurrency === 1` this is byte-for-byte the old serial behaviour. Step 05 does not need to change the runner; it only adds new generators that the runner consumes the same way.

## PromptGenerator contract changed for concurrency, and Step 05's readers must honor it

The `PromptGenerator` interface doc in `src/prompt-generators.ts` now states: under `concurrency > 1`, multiple yielded items may be in flight at once; a generator must yield each id exactly once per run and must not rely on `isOutstanding` reflecting items yielded earlier in the same run (those items may not have completed yet). The Step 05 `jsonl` and `loop-state` readers already plan to gate emitted ids through the consuming step's own `loopState.isOutstanding(id)` once, at yield time, which satisfies this. Do not add any "wait until previously yielded items finish" logic; the pool owns in-flight tracking, and the loop state's `claim`/`complete` own arbitration.

## Reporter appends are serialized under concurrency, so JSONL stays well-formed

When `concurrency > 1` the runner wraps the reporter with `serializeReporter` (`src/util/serialize-reporter.ts`), which chains `append` calls so they never overlap. The `Reporter` interface doc now records that implementations may assume non-overlapping calls. This matters to Step 05's `jsonl` reader: a `jsonl-report` produced by a concurrent run is still one complete JSON object per line (no interleaved partial writes), so the line-by-line reader can trust the format. At `concurrency === 1` the reporter is used directly, unchanged.

## State shape and cost fields are unchanged

Step 04 did not touch `src/loop-states/` or the `CostInfo` / `LoopRunResult` / `LoopStateSnapshot` types. The strict v2 snapshot (`{ version: 2, results, claims, totalUsd }`) that Step 05's `loop-state` reader consumes, and the cost fields the readers pass through, are exactly as Steps 01 and 03 left them. Step 05's dependencies on Step 01 (state shape) and Step 03 (cost pass-through) hold as written.

## CLI config touch-points Step 05 extends

- `src/util/load-cli-config.ts`: `VALUE_FLAGS` is now a three-entry `ReadonlyMap<string, 'maxPrompts' | 'maxBudgetUsd' | 'concurrency'>` with a three-branch `if/else if/else` dispatch, each branch covered by tests. `--concurrency` parses like `--max-prompts` (integer, rejects `< 1` and non-integers). Step 05's `{{steps.<name>.report}}` / `{{steps.<name>.state}}` handoff substitution belongs in the config-normalization path (`normalizeCliConfig` / `normalizePromptGeneratorSpec`), not the flag parser, so it does not collide with this dispatch.
- `src/types.ts`: `LoopCliConfig` has optional `concurrency?: number`; `loop()` maps it to `LoopConfig.concurrency` with a default of `1`, and `loopImpl` destructures it and validates it as the first statements (`Invalid concurrency` for `< 1` or non-integer; rejects `concurrency > 1` with `allowSourceUpdate` or with a `BatchPromptGenerator` instance).
- `schema/loop-the-loop.schema.json`: top-level `concurrency` (`integer`, `minimum: 1`, `default: 1`) sits next to `maxBudgetUsd`. Step 05 adds `jsonlTask` and `loopStateTask` definitions modeled on `jsonTask`; leave the top-level `concurrency` intact.
- `src/examples/concurrency/` is the Step 04 example. The schema test validates every example under `src/examples/` automatically, so any Step 05 example must validate against the schema as it then stands.

## Testing note: observing real overlap needs real timers

The loop tests run under `vi.useFakeTimers()` by default. The one test that asserts agents actually overlap (`runs multiple prompts concurrently when concurrency > 1`) must use `vi.useRealTimers()` and call `loop(...)` directly. The reason: `FileLoopState.claim` performs real filesystem I/O, which does not interleave with a faked agent delay under fake timers, so invocations pipeline serially and never overlap. Stop-condition and serialization tests work fine under fake timers; only tests that need genuine wall-clock overlap need real timers. Keep this in mind for any Step 05 test that wants to observe concurrent reader/runner behaviour.
