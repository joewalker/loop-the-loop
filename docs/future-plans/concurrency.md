# Plan: optional parallel prompt execution

## Context

Today `loopImpl` in [src/loop.ts](../../src/loop.ts) runs prompts strictly serially: a single `for await` over the prompt generator that does `begin → invoke → reporter.append → end → optional git commit → pause` for each prompt. The user wants an opt-in way to run prompts in parallel, primarily to shorten wall-clock time for runs where each prompt takes minutes (Claude/OpenAI/Codex coding agents).

We add a single new top-level config field, `concurrency` (default `1`, matching today's behavior byte-for-byte), with a matching `--concurrency N` CLI flag. When `concurrency > 1`, up to N prompts may be in flight at once. We explicitly refuse the combination with `allowSourceUpdate` (git commits cannot safely interleave) and with the `batch` prompt generator (summary prompts read the report file and would race with in-flight batch items). All other generators yield each id exactly once per run, so they are safe with concurrent consumption.

The reporter file (`yaml-report` / `jsonl-report`) is append-only via `fs/promises.appendFile`, which is not safe under concurrent writes from the same process. We serialize reporter writes with a small wrapper that the runner applies only when `concurrency > 1`, so custom user-supplied reporters get the same protection automatically. `LoopState` already saves on every `begin`/`end`, so it gets a small internal save-serialization mutex and `inProgress` changes from a single string to an array (with a backwards-compat load path for old state files).

User-confirmed design decisions:

- Field name: `concurrency` (default `1`).
- `allowSourceUpdate=true` + `concurrency > 1` → reject at startup.
- `interPromptPause` is per worker: each in-flight slot pauses after its prompt before pulling the next.

## Files to modify

### 1. Config type — [src/types.ts](../../src/types.ts)

Add to `LoopCliConfig` (after `interPromptPause`, before `allowSourceUpdate`):

```ts
/**
 * Maximum number of prompts to process concurrently. Defaults to 1
 * (strictly serial). When set above 1, the loop maintains up to N
 * in-flight prompts pulled from the prompt generator.
 *
 * Cannot be combined with `allowSourceUpdate: true` or the `batch`
 * prompt generator - both require strict ordering.
 */
readonly concurrency?: number;
```

### 2. JSON schema — [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json)

Add property next to `interPromptPause`:

```json
"concurrency": {
  "type": "integer",
  "minimum": 1,
  "default": 1,
  "description": "Maximum number of prompts to run concurrently. Defaults to 1 (serial). Cannot be combined with allowSourceUpdate=true or the batch prompt generator."
}
```

### 3. Runtime — [src/loop.ts](../../src/loop.ts)

Changes inside `loop()` and `loopImpl()`:

- `LoopConfig` interface: add `readonly concurrency: number`.
- `loop()`: resolve `concurrency = config.concurrency ?? 1` and pass through.
- `loopImpl()` validation, before doing anything else:
  - If `concurrency < 1` or not an integer → throw `Invalid concurrency: ${value}`.
  - If `concurrency > 1 && allowSourceUpdate` → throw `concurrency > 1 cannot be combined with allowSourceUpdate=true (git commits cannot safely interleave)`.
  - If `concurrency > 1` and the prompt generator is the batch generator → throw `concurrency > 1 cannot be combined with the batch prompt generator (summary prompts depend on completed batch items)`. Detect via `instanceof BatchPromptGenerator` (already exported from [src/prompt-generators/batch.ts](../../src/prompt-generators/batch.ts)).
- Replace the body of `for await (const prompt of promptGenerator.generate(loopState)) { … }` with a call to the new `runPool` helper (see step 4). The current loop body becomes the `work` callback that returns `'continue' | 'stop'`.
- Wrap the reporter with `serializeReporter(reporter)` when `concurrency > 1` (see step 5). At `concurrency === 1` use the reporter directly so the existing serial code path is unchanged.
- Glitch counter: keep the existing `glitchCount` as a single shared counter visible to the work callback. Reset on success, increment on glitch, set `stop = true` once it reaches `MAX_CONSECUTIVE_GLITCHES`. Document in a single-line code comment that "consecutive" under concurrency means "in completion order, which is not the same as dispatch order."
- Error result: return `'stop'` from `work`; pending workers drain naturally. After `runPool` returns, if any worker recorded a fatal error, return that message string (preserve today's return-string contract).
- `maxPrompts`: increment a shared `completed` counter on each completion; when it reaches `maxPrompts`, return `'stop'`.
- Stagger startup: worker k delays `k * (interPromptPause / concurrency)` seconds before its first pull, so the initial burst is spread across the pause window. Only when `interPromptPause > 0 && concurrency > 1`.

### 4. New helper — `src/util/run-pool.ts`

Small, dependency-free worker-pool driver. Signature:

```ts
export async function runPool<T>(
  source: AsyncIterable<T>,
  concurrency: number,
  work: (item: T, workerIndex: number) => Promise<'continue' | 'stop'>,
  options?: { staggerSeconds?: number },
): Promise<void>;
```

Implementation: one shared `AsyncIterator` obtained from `source[Symbol.asyncIterator]()`; N concurrent workers each loop `while (!stop) { const { done, value } = await iter.next(); if (done || stop) return; … }`. Stop is a closed-over boolean set when `work` returns `'stop'`. JavaScript queues concurrent `.next()` calls on a single generator instance, so source items are produced serially and consumed by whichever worker calls `.next()` first.

Why a separate helper: keeps the loop body readable; lets us unit-test the pool independently of agents/reporters/state.

### 5. Reporter serialization — [src/loop.ts](../../src/loop.ts) (local helper)

Small inline (or co-located in [src/reporters.ts](../../src/reporters.ts)) function:

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

Applied only when `concurrency > 1`. Works for custom user reporters too (the existing test in [src/__test__/loop.test.ts](../../src/__test__/loop.test.ts) passes a bare `{ append: vi.fn() }`).

### 6. LoopState — [src/util/loop-state.ts](../../src/util/loop-state.ts)

- Change `#inProgress?: string | undefined` → `#inProgress: Array<string>` (initialized to `[]`).
- Persist as `inProgress: Array<string>` (the JSON shape changes from string to array - there is no published version of this tool yet, but we still handle older local state files for users who upgrade mid-run).
- `PersistedLoopState`: change `inProgress?: string` to `inProgress?: string | Array<string>`.
- `create()` migration on load: if `data.inProgress` is a string, treat as `[data.inProgress]`; if absent, `[]`.
- `begin(id)`: push id, save.
- `end(id, result)`: remove id from `#inProgress`, then push to `#completed` or `#failed` per result, save.
- Internal save serialization: add a `#saveChain: Promise<void> = Promise.resolve()` and route `save()` through it so concurrent `begin`/`end` calls do not race on `writeFile`. Keep `save()` public signature unchanged.

### 7. CLI plumbing — [src/util/load-cli-config.ts](../../src/util/load-cli-config.ts)

- Add `concurrency?: number` to `ParsedArgs`.
- Add `['concurrency', 'concurrency']` to `VALUE_FLAGS` (extend its value-field type union).
- `parseArgs`: same validation as `maxPrompts` but with `n < 1` rejected (concurrency=0 would deadlock the pool). Error message: `Invalid --${rawKey} value: ${value}`.
- `loadCliConfig`: propagate `concurrency` into the returned config the same way `maxPrompts` is propagated (only if CLI flag provided).
- `USAGE` string: add `[--concurrency N]`.

### 8. CLI entry — [src/cli.ts](../../src/cli.ts)

Update the JSDoc usage block to include `[--concurrency N]`. No other changes (the actual flag is handled in `loadCliConfig`).

### 9. Interface doc updates

- `PromptGenerator` interface in [src/prompt-generators.ts](../../src/prompt-generators.ts): update the JSDoc to note that under `concurrency > 1`, multiple yielded items may be in flight simultaneously; generators must yield each id exactly once per run and must not rely on `loopState.isOutstanding(id)` reflecting items yielded earlier in the same run.
- `Reporter` interface in [src/reporters.ts](../../src/reporters.ts): update JSDoc to note that the loop runner serializes `append` calls when `concurrency > 1`, so reporter implementations may assume non-overlapping calls.

## Tests

Existing tests that must be updated:

- [src/__test__/loop.test.ts](../../src/__test__/loop.test.ts) at lines ~332-362 (the "keep the prompt outstanding if writing the report fails" test asserts `inProgress: 'a.ts'` as a string - change to `['a.ts']`).
- [src/util/__test__/loop-state.test.ts](../../src/util/__test__/loop-state.test.ts) at lines ~115-124 (`data.inProgress === 'active-item'` → `['active-item']`) and any other tests asserting the string shape.

New tests to add:

- `loop-state.test.ts`:
  - Backwards-compat: load a state file with `inProgress: "old-id"` (string) and verify it round-trips as `["old-id"]`.
  - Multiple in-flight: `begin('a')` + `begin('b')` then `end('a', success)` leaves `inProgress: ['b']` and `completed: ['a']`.
  - Concurrent save: launch many `begin`/`end` calls in parallel and verify the final file matches the in-memory state (no lost writes).

- `loop.test.ts`:
  - `concurrency: 3` with a test agent that records timestamps → assert overlap (>1 invocation in flight at some point).
  - `concurrency: 2` + `allowSourceUpdate: true` → rejects at startup with the expected error message.
  - `concurrency: 2` + batch prompt generator → rejects at startup with the expected error message.
  - `concurrency: 2` with a reporter that records call order → assert no interleaved `append` calls (use a reporter that sleeps inside `append` to expose the race if serialization were missing).
  - Glitch counter under parallel: agent returns glitches in completion order, verify abort after `MAX_CONSECUTIVE_GLITCHES`.
  - Error-then-drain: agent returns an error on one prompt; verify in-flight prompts complete and the error message is returned.
  - `--concurrency` CLI flag: in `load-cli-config.test.ts`, add cases mirroring the `--max-prompts` tests, including the `0` and negative-value rejections.

- `schema.test.ts`: a `concurrency: 4` config validates; `concurrency: 0` and `concurrency: -1` fail validation.

- New `src/util/__test__/run-pool.test.ts`: pool helper in isolation - single worker behaves like serial, multiple workers actually overlap, `stop` halts new pulls, drain completes in-flight items, errors thrown from `work` propagate.

The existing `runMainWithFakeTimers` test helper at the top of `loop.test.ts` assumes serial timer advancement; the new concurrency tests should drive real (non-fake) timers with `interPromptPause: 0` so they do not fight the helper.

## Out of scope

- True global rate limiting (token bucket across workers). Document in the JSDoc that per-worker pause is not equivalent to global rate limit; users who need that should configure it on the agent. Future change.
- Parallelizing inside the batch generator (fork-join over a batch's items, with the summary as a barrier). Future change if needed.
- Cross-process or worker_threads concurrency. The pool is in-process async.

## Verification

After implementing:

1. `pnpm tsc && pnpm test` - all tests pass.
2. `pnpm lint` - clean.
3. `pnpm format` - no diff.
4. Manual smoke with a small `test-config.json` using the `test` agent and `json` prompt generator (10 prompts):
   - `--concurrency 1` (or omitted) → serial, identical wall-clock to today.
   - `--concurrency 4` → wall-clock ~1/4 (with `interPromptPause: 0`), report file is a valid YAML multi-document stream with one document per prompt and no corruption.
   - `--concurrency 4` with `allowSourceUpdate: true` in the config → fails at startup with the rejection error.
   - `--concurrency 4` against a batch generator config → fails at startup with the rejection error.
   - Kill the run mid-flight (Ctrl-C) at `--concurrency 4`, then re-run → state file shows the killed prompts back in `inProgress`/outstanding, and the rerun completes them without duplicating already-completed work.
5. Confirm the JSON schema validates the new field by running `schema.test.ts` and by opening a config that sets `concurrency` in an editor with schema validation enabled.
