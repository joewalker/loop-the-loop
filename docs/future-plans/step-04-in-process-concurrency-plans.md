# Step 04 In-process Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one loop process run up to `concurrency` prompts at once while preserving claim ownership, reporter integrity, budget and stop semantics, and byte-for-byte serial behaviour at `concurrency: 1`.

**Architecture:** A dependency-free worker pool (`runPool`) drives N workers off one shared async iterator of the prompt generator. The loop body becomes a `work` callback returning `'continue' | 'stop'`; stop conditions (`maxPrompts`, `maxBudgetUsd`, an error result, too many glitches) set the shared `stop`, let in-flight prompts drain, and the recorded `LoopRunResult` is returned afterwards. A small `serializeReporter` wrapper chains `append` calls when `concurrency > 1`. Startup validation rejects `concurrency > 1` with `allowSourceUpdate` or the batch generator.

**Tech Stack:** TypeScript (strict, ESM), vitest, ajv (schema test), pnpm. Coverage gate is 100% on non-ignored files. `src/util/run-pool.ts`, `src/util/serialize-reporter.ts`, `src/loop.ts`, and `src/util/load-cli-config.ts` are all coverage-measured, so every new branch must be exercised by a test.

## Carry-over contract from Step 03

Read `docs/future-plans/next.md` before starting. The load-bearing facts:

- Budget enforcement is already completion-friendly in shape: `loopImpl` has a startup budget stop (after loop state load) and a post-completion budget stop (after the success/glitch/error block, before `completed++`). Both re-read `(await loopState.getSnapshot()).totalUsd`. When the loop body moves into the `work` callback the post-completion check and the `Cost:` log move with it, and crossing the cap must make `work` set the shared stop result and return `'stop'` rather than returning from a sequential loop. Budget is checked before `maxPrompts`; preserve that order with a comment.
- Cost totals are already concurrency-safe: `FileLoopState.complete()`/`#addCost` serialise through an internal save chain and `getSnapshot().totalUsd` reflects every completion recorded so far. Step 04 does not touch `src/loop-states/file.ts`.
- `formatCost(cost: CostInfo)` already exists at the bottom of `src/loop.ts`; keep calling it on each completion.
- CLI/schema touch-points are in a known state: `VALUE_FLAGS` is a `ReadonlyMap<string, 'maxPrompts' | 'maxBudgetUsd'>` with a real two-branch dispatch, `ParsedArgs` carries `maxBudgetUsd?`, `loadCliConfig` merges it (tested, no istanbul-ignore), `USAGE` lists `[--max-budget-usd N]`, `LoopCliConfig` has `maxBudgetUsd?: number`, `loop()` maps it with a default of `Infinity`, and the schema has a top-level `maxBudgetUsd`. Add `concurrency` alongside each, following the `maxBudgetUsd` precedent.
- The reporter outputs (YAML `cost:` block, JSONL `result` spread) must be unchanged at `concurrency === 1`. The serializer wrapper is only inserted when `concurrency > 1`.

## File structure

Created:

- `src/util/run-pool.ts` - the `runPool` worker-pool helper. No I/O, no domain types.
- `src/util/__test__/run-pool.test.ts` - unit tests for `runPool`.
- `src/util/serialize-reporter.ts` - `serializeReporter(inner: Reporter): Reporter`, a promise-chain append serializer.
- `src/util/__test__/serialize-reporter.test.ts` - unit tests for the serializer.
- `src/examples/concurrency/concurrency.json` - example config exercising `concurrency` (validated by `src/__test__/schema.test.ts`).
- `src/examples/concurrency/README.md` - short note describing the example.

Modified:

- `src/types.ts` - add optional `concurrency` to `LoopCliConfig`.
- `src/loop.ts` - add `concurrency` to `LoopConfig`, map it in `loop()`, validate it in `loopImpl`, drive the body through `runPool`, wrap the reporter, share the glitch/completed counters, and stagger startup.
- `src/util/load-cli-config.ts` - `--concurrency` parsing and merge; usage string.
- `src/cli.ts` - mention `--concurrency` in help text.
- `src/prompt-generators.ts` - `PromptGenerator` interface doc note for concurrency.
- `src/reporters.ts` - `Reporter` interface doc note for serialized appends.
- `schema/loop-the-loop.schema.json` - top-level `concurrency`.
- `src/__test__/schema.test.ts` - positive (`concurrency: 4`) and negative (`0`, `-1`) cases.
- `src/util/__test__/load-cli-config.test.ts` - `--concurrency` parse and merge tests.
- `src/__test__/loop.test.ts` - validation, overlap, reporter-serialization, glitch-cap, error-then-drain, and stagger tests.
- `README.md` - "Concurrency" section.

## Execution and commit protocol

Each section below is self-contained and ends with a commit. Sections are ordered so the build stays green (`pnpm tsc && pnpm test --coverage` clean, 100% coverage) after every commit. Dispatch one fresh sub-agent per section. Between sections the orchestrator runs the completion gate and reviews the diff before starting the next section.

Per AGENTS.md: stay on the `main` branch, do not open PRs, never run `git add`/`git mv`/`git rm` outside the commit step, use the default `~/.gitconfig` author, and do NOT add a `Co-Authored-By` trailer. Commit message tags follow recent history (`Feature:`, `Fix:`, `Docs:`). Before each commit run `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`.

A note for the sub-agent running Section 3: after that commit, a `concurrency: 2` run with an ordinary generator passes validation but still runs serially (the loop body is converted in Section 4). That intermediate state is correct, just not yet concurrent. Do not add an overlap test in Section 3.

---

## Section 1: The `runPool` worker pool

A pure, dependency-free helper built and committed first so the loop can import it.

**Files:**

- Create: `src/util/run-pool.ts`
- Test: `src/util/__test__/run-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/util/__test__/run-pool.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/util/__test__/run-pool.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/util/run-pool`.

- [ ] **Step 3: Implement `src/util/run-pool.ts`**

```ts
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/util/__test__/run-pool.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, no format diff, `run-pool.ts` at 100%.

- [ ] **Step 6: Commit**

```bash
git add src/util/run-pool.ts src/util/__test__/run-pool.test.ts
git commit -m "Feature: Add dependency-free runPool worker pool"
```

---

## Section 2: The `serializeReporter` wrapper

A tiny wrapper that serialises `append` onto a promise chain so concurrent workers cannot interleave or corrupt a reporter's output. Built standalone so its rejection-swallow path is unit-tested directly.

**Files:**

- Create: `src/util/serialize-reporter.ts`
- Test: `src/util/__test__/serialize-reporter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/util/__test__/serialize-reporter.test.ts`:

```ts
// @module-tag local

import type { Prompt } from 'loop-the-loop/prompt-generators';
import type { Reporter } from 'loop-the-loop/reporters';
import type { InvokeResult } from 'loop-the-loop/types';
import { serializeReporter } from 'loop-the-loop/util/serialize-reporter';
import { describe, expect, it, vi } from 'vitest';

const PROMPT = (id: string): Prompt => ({ id, prompt: 'p' });
const OK: InvokeResult = { status: 'success', output: '' };

describe('serializeReporter', () => {
  it('runs appends one at a time in call order even if earlier ones are slower', async () => {
    const order: Array<string> = [];
    const inner: Reporter = {
      append: async prompt => {
        await new Promise<void>(resolve => {
          setTimeout(resolve, prompt.id === 'a' ? 20 : 5);
        });
        order.push(prompt.id);
      },
    };
    const reporter = serializeReporter(inner);
    await Promise.all([
      reporter.append(PROMPT('a'), OK),
      reporter.append(PROMPT('b'), OK),
    ]);
    expect(order).toEqual(['a', 'b']);
  });

  it('swallows a rejection on the chain so a later append still runs', async () => {
    const append = vi
      .fn<Reporter['append']>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const reporter = serializeReporter({ append });

    const first = reporter.append(PROMPT('a'), OK);
    const second = reporter.append(PROMPT('b'), OK);

    await expect(first).rejects.toThrow('disk full');
    await expect(second).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/util/__test__/serialize-reporter.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/util/serialize-reporter`.

- [ ] **Step 3: Implement `src/util/serialize-reporter.ts`**

```ts
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/util/__test__/serialize-reporter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, `serialize-reporter.ts` at 100%.

- [ ] **Step 6: Commit**

```bash
git add src/util/serialize-reporter.ts src/util/__test__/serialize-reporter.test.ts
git commit -m "Feature: Add serializeReporter append serializer"
```

---

## Section 3: `concurrency` config, CLI, schema, validation, docs

Add the `concurrency` config surface end to end and the startup validation, leaving the loop body serial (Section 4 converts it).

**Files:**

- Modify: `src/types.ts`, `src/loop.ts`, `src/util/load-cli-config.ts`, `src/cli.ts`, `schema/loop-the-loop.schema.json`, `README.md`
- Create: `src/examples/concurrency/concurrency.json`, `src/examples/concurrency/README.md`
- Test: `src/util/__test__/load-cli-config.test.ts`, `src/__test__/schema.test.ts`, `src/__test__/loop.test.ts`

- [ ] **Step 1: Add the config field to `src/types.ts`**

In `LoopCliConfig`, after the `maxBudgetUsd` field:

```ts
  /**
   * Number of prompts to run concurrently in one process. Defaults to 1
   * (serial, byte-for-byte the previous behaviour). Values greater than 1 are
   * rejected together with `allowSourceUpdate` (git commits cannot safely
   * interleave) or the batch prompt generator (summary prompts would race
   * with in-flight batch items).
   */
  readonly concurrency?: number;
```

- [ ] **Step 2: Write the failing CLI parse and merge tests**

Add to `src/util/__test__/load-cli-config.test.ts`, after the `describe('--max-budget-usd', ...)` block (around line 294, inside the same parent `describe`):

```ts
  describe('--concurrency', () => {
    it('parses an integer value', () => {
      expect(parseArgs(['--concurrency', '4', 'c.json']).concurrency).toBe(4);
    });

    it('parses the inline form', () => {
      expect(parseArgs(['--concurrency=3', 'c.json']).concurrency).toBe(3);
    });

    it.each(['0', '-1', '1.5', 'abc', 'NaN', ''])('rejects %s', value => {
      expect(() => parseArgs([`--concurrency=${value}`, 'c.json'])).toThrow(
        /Invalid --concurrency value/u,
      );
    });

    it('is undefined when not passed', () => {
      expect(parseArgs(['c.json']).concurrency).toBeUndefined();
    });
  });
```

And a merge test next to the `merges maxBudgetUsd` test (around line 1768), inside the `describe('loadCliConfig', ...)` block:

```ts
  it('merges concurrency from the CLI flag into the config', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        name: 'concurrent',
        agent: 'claude-sdk',
        promptGenerator: [
          'per-file',
          { filePattern: 'src/**/*.ts', promptTemplate: 'Review {{file}}' },
        ],
      })}\n`,
    );

    const config = await loadCliConfig({ configPath, concurrency: 4 });
    expect(config.concurrency).toBe(4);
  });
```

- [ ] **Step 3: Run the parse/merge tests and verify they fail**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: FAIL - `concurrency` not parsed or merged.

- [ ] **Step 4: Implement `--concurrency` in `src/util/load-cli-config.ts`**

Add `concurrency?: number` to `ParsedArgs`, after `maxBudgetUsd`:

```ts
  readonly concurrency?: number | undefined;
```

Widen `VALUE_FLAGS` to three entries:

```ts
const VALUE_FLAGS: ReadonlyMap<
  string,
  'maxPrompts' | 'maxBudgetUsd' | 'concurrency'
> = new Map([
  ['maxprompts', 'maxPrompts'],
  ['maxbudgetusd', 'maxBudgetUsd'],
  ['concurrency', 'concurrency'],
]);
```

Add a `let concurrency: number | undefined;` next to `maxBudgetUsd` (around line 83), then replace the existing two-branch value-flag dispatch (the `if (valueField === 'maxPrompts') { ... } else { ... }` block) with a three-branch dispatch:

```ts
    if (valueField === 'maxPrompts') {
      const n = /^\d+$/u.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid --${rawKey} value: ${value}`);
      }
      maxPrompts = n;
    } else if (valueField === 'maxBudgetUsd') {
      const n = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --${rawKey} value: ${value}`);
      }
      maxBudgetUsd = n;
    } else {
      const n = /^\d+$/u.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --${rawKey} value: ${value}`);
      }
      concurrency = n;
    }
```

Add `concurrency` to BOTH `return` objects (the help/version short-circuit return and the main return), alongside `maxBudgetUsd`.

Update `USAGE` to include the flag:

```ts
export const USAGE =
  'Usage: loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--doctor] [--max-prompts N] [--max-budget-usd N] [--concurrency N] <config.json>';
```

In `loadCliConfig`, destructure `concurrency` from `parsedArgs` and merge it next to the `maxBudgetUsd` merge (no istanbul-ignore, the merge test covers it):

```ts
    ...(concurrency !== undefined ? { concurrency } : {}),
```

- [ ] **Step 5: Add `--concurrency` to `src/cli.ts` help text**

`cli.ts` is untested by design; keep the change to text only. Add `--concurrency N` to the three usage example lines in the file's leading doc comment (lines 16-18), mirroring the existing `--max-budget-usd N` placement, e.g.:

```
 *   npx loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] [--max-budget-usd N] [--concurrency N] <config.json>
```

- [ ] **Step 6: Run the parse/merge tests and verify they pass**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: PASS (both value-flag branches and the merge covered).

- [ ] **Step 7: Write the failing schema cases**

Add to `src/__test__/schema.test.ts` a positive case (in the `positive cases` array, around line 84):

```ts
      [
        'top-level concurrency',
        {
          name: 'concurrent',
          concurrency: 4,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
```

And two negative cases (in the `negative cases` array, around line 432):

```ts
      [
        'rejects a zero concurrency',
        {
          name: 'concurrent',
          concurrency: 0,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
      [
        'rejects a negative concurrency',
        {
          name: 'concurrent',
          concurrency: -1,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
```

- [ ] **Step 8: Run the schema test and verify the new cases fail**

Run: `pnpm test src/__test__/schema.test.ts`
Expected: FAIL - `concurrency` is not yet in the schema, so the positive case is rejected and the negatives validate when they should not.

- [ ] **Step 9: Edit `schema/loop-the-loop.schema.json`**

Add the top-level property, immediately after the `maxBudgetUsd` property (around line 41):

```json
    "concurrency": {
      "type": "integer",
      "minimum": 1,
      "default": 1,
      "description": "Number of prompts to run concurrently in one process. Defaults to 1 (serial). Not supported with allowSourceUpdate or the batch prompt generator."
    },
```

- [ ] **Step 10: Create the example config and its README**

`src/examples/concurrency/concurrency.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/joewalker/loop-the-loop/refs/heads/main/schema/loop-the-loop.schema.json",
  "name": "concurrency",
  "concurrency": 4,
  "interPromptPause": 2,
  "agent": "claude-sdk",
  "promptGenerator": [
    "per-file",
    {
      "filePattern": "src/**/*.ts",
      "excludePatterns": ["**/__test__/**", "**/*.test.ts"],
      "promptTemplate": "Summarise the responsibilities of {{file}} in two sentences."
    }
  ]
}
```

`src/examples/concurrency/README.md`:

```markdown
# concurrency example

Runs up to four prompts at once in a single process.

- `concurrency` controls how many prompts are in flight together. The default
  is 1 (serial), which behaves exactly as before.
- `interPromptPause` stays a per-worker pause: each slot pauses after its own
  prompt before pulling the next, and the initial burst is staggered across the
  pause window so the workers do not all fire at the same instant.

Concurrency greater than 1 is rejected with `allowSourceUpdate` (git commits
cannot safely interleave) and with the batch prompt generator (its summary
prompts read the report file and would race with in-flight batch items).
```

- [ ] **Step 11: Add the README section**

Add a "Concurrency" section to `README.md`, immediately after the "Cost accounting and budgets" section. Prose only, one line per paragraph, no bold (per AGENTS.md):

```markdown
## Concurrency

By default a loop runs one prompt at a time. Set a top-level `concurrency`, or pass `--concurrency N`, to run up to N prompts at once in a single process. All workers share one run and claim prompt ids independently, so state, cost totals, and resume behaviour are unchanged; `concurrency: 1` is byte-for-byte the serial behaviour.

Stop conditions are completion-order: when `maxPrompts`, `maxBudgetUsd`, an error result, or too many consecutive glitches is reached, the loop stops pulling new prompts and lets the in-flight ones finish before returning. `interPromptPause` stays a per-worker pause, and the initial burst is staggered across the pause window so the workers do not all start at the same instant. Reporter writes are serialized when `concurrency > 1`, so report output is never interleaved.

Concurrency greater than 1 is rejected with `allowSourceUpdate` (git commits cannot safely interleave) and with the batch prompt generator (its summary prompts read the report file and would race with in-flight batch items). The per-worker pause is not a global rate limit: the effective request rate rises with concurrency, so configure a real rate limit on the agent if you need one.
```

- [ ] **Step 12: Write the failing validation tests**

Add to `src/__test__/loop.test.ts`. First add the import near the other imports at the top of the file:

```ts
import { BatchPromptGenerator } from 'loop-the-loop/prompt-generators/batch';
```

Then add these tests inside the `describe('main', ...)` block:

```ts
  it('rejects a non-integer concurrency', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);
    await expect(
      loop({ name: 'bad-conc', agent, promptGenerator, concurrency: 1.5 }),
    ).rejects.toThrow('Invalid concurrency: 1.5');
  });

  it('rejects a concurrency below 1', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);
    await expect(
      loop({ name: 'zero-conc', agent, promptGenerator, concurrency: 0 }),
    ).rejects.toThrow('Invalid concurrency: 0');
  });

  it('rejects concurrency > 1 with allowSourceUpdate', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);
    await expect(
      loop({
        name: 'conc-source',
        agent,
        promptGenerator,
        concurrency: 2,
        allowSourceUpdate: true,
      }),
    ).rejects.toThrow(/allowSourceUpdate/u);
  });

  it('rejects concurrency > 1 with the batch prompt generator', async () => {
    const agent = new TestAgent();
    const inner = new FixedPromptGenerator([{ id: 'a', prompt: 'a' }]);
    const promptGenerator = new BatchPromptGenerator(
      { source: inner, summaryPromptTemplate: 'Summary', reportFile: 'r.yaml' },
      inner,
    );
    await expect(
      loop({ name: 'conc-batch', agent, promptGenerator, concurrency: 2 }),
    ).rejects.toThrow(/batch/u);
  });
```

These call `loop(...)` directly (not `runMainWithFakeTimers`) because the validation throws before any timer is scheduled.

- [ ] **Step 13: Run the validation tests and verify they fail**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: FAIL - no concurrency validation yet.

- [ ] **Step 14: Implement the config plumbing and validation in `src/loop.ts`**

Add the import near the other generator import:

```ts
import { BatchPromptGenerator } from './prompt-generators/batch.js';
```

In `loop()`, add the mapping next to the other defaults (after the `maxBudgetUsd` line):

```ts
    concurrency: config.concurrency ?? 1,
```

Add to the `LoopConfig` interface (after `maxBudgetUsd`):

```ts
  readonly concurrency: number;
```

Destructure `concurrency` in `loopImpl` (add it to the existing destructuring block), then add the validation as the very first statements in `loopImpl`, before `const git = ...`:

```ts
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency: ${concurrency}`);
  }
  if (concurrency > 1 && allowSourceUpdate) {
    throw new Error(
      'concurrency > 1 is not supported with allowSourceUpdate: git commits cannot safely interleave',
    );
  }
  if (concurrency > 1 && promptGenerator instanceof BatchPromptGenerator) {
    throw new Error(
      'concurrency > 1 is not supported with the batch prompt generator: summary prompts would race with in-flight batch items',
    );
  }
```

Leave the loop body (the `for await` block) unchanged in this section.

- [ ] **Step 15: Run the tests and verify they pass**

Run: `pnpm test src/__test__/loop.test.ts src/__test__/schema.test.ts`
Expected: PASS - validation throws as asserted, the schema positive case validates and both negatives are rejected.

- [ ] **Step 16: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, coverage 100% (every new branch in `load-cli-config.ts` and `loop.ts` exercised).

- [ ] **Step 17: Commit**

```bash
git add src/types.ts src/loop.ts src/util/load-cli-config.ts src/cli.ts schema/loop-the-loop.schema.json src/__test__/schema.test.ts src/util/__test__/load-cli-config.test.ts src/__test__/loop.test.ts src/examples/concurrency README.md
git commit -m "Feature: Add concurrency config, CLI flag, schema, and validation"
```

---

## Section 4: Drive the loop body through `runPool`

Convert the sequential `for await` body into a `runPool` work callback, wrap the reporter when concurrent, share the counters, and stagger startup. Behaviour at `concurrency: 1` is unchanged.

**Files:**

- Modify: `src/loop.ts`, `src/prompt-generators.ts`, `src/reporters.ts`
- Test: `src/__test__/loop.test.ts`

- [ ] **Step 1: Write the failing concurrency behaviour tests**

Add to `src/__test__/loop.test.ts`. First add an overlap-observing agent and a serialization-observing reporter near the existing `RecordingAgent` helper at the top of the file:

```ts
/**
 * An agent that records the peak number of overlapping invocations, using a
 * fake-timer delay so the loop's pool keeps several invocations in flight.
 */
class OverlapAgent implements Agent {
  active = 0;
  maxActive = 0;
  async invoke(): Promise<InvokeResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>(resolve => {
      setTimeout(resolve, 10);
    });
    this.active -= 1;
    return { status: 'success', output: 'ok' };
  }
}

/**
 * A reporter that records the peak number of overlapping append calls, to
 * prove serialization under concurrency.
 */
class SleepingReporter implements Reporter {
  active = 0;
  maxActive = 0;
  readonly appended: Array<string> = [];
  async append(prompt: Prompt): Promise<void> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    });
    this.appended.push(prompt.id);
    this.active -= 1;
  }
}
```

Add `Reporter` to the type import from `loop-the-loop` at the top of the file (it already imports `Agent`, `InvokeOptions`, `Prompt`, `PromptGenerator`, etc.).

Then add these tests inside `describe('main', ...)`:

```ts
  it('runs multiple prompts concurrently when concurrency > 1', async () => {
    const agent = new OverlapAgent();
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b' },
      { id: 'c', prompt: 'c' },
      { id: 'd', prompt: 'd' },
      { id: 'e', prompt: 'e' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'overlap',
      agent,
      outputDir: repoPath,
      promptGenerator,
      concurrency: 3,
      interPromptPause: 0,
    });

    expect(result).toEqual({ status: 'completed' });
    expect(agent.maxActive).toBeGreaterThan(1);
  });

  it('does not interleave reporter appends when concurrency > 1', async () => {
    const agent = new TestAgent({
      responses: [{ status: 'success', output: 'ok' }],
      repeat: 'cycle',
    });
    const reporter = new SleepingReporter();
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b' },
      { id: 'c', prompt: 'c' },
      { id: 'd', prompt: 'd' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'serial-reporter',
      agent,
      outputDir: repoPath,
      promptGenerator,
      reporter,
      concurrency: 3,
      interPromptPause: 0,
    });

    expect(result).toEqual({ status: 'completed' });
    expect(reporter.maxActive).toBe(1);
    expect([...reporter.appended].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('aborts on too many glitches in completion order under concurrency', async () => {
    const agent = new TestAgent({
      responses: [
        { status: 'glitch', reason: 'rate limit' },
        { status: 'glitch', reason: 'rate limit' },
        { status: 'glitch', reason: 'rate limit' },
        { status: 'glitch', reason: 'rate limit' },
        { status: 'glitch', reason: 'rate limit' },
        { status: 'glitch', reason: 'rate limit' },
      ],
    });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b' },
      { id: 'c', prompt: 'c' },
      { id: 'd', prompt: 'd' },
      { id: 'e', prompt: 'e' },
      { id: 'f', prompt: 'f' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'conc-glitches',
      agent,
      outputDir: repoPath,
      promptGenerator,
      concurrency: 2,
      interPromptPause: 0,
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'tooManyGlitches',
      message: expect.stringContaining('Aborting after 5 consecutive glitches'),
    });
  });

  it('returns the error result and drains in-flight prompts under concurrency', async () => {
    const agent = new TestAgent({
      responses: [
        { status: 'error', reason: 'bad prompt' },
        { status: 'success', output: 'ok' },
      ],
    });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'conc-error',
      agent,
      outputDir: repoPath,
      promptGenerator,
      concurrency: 2,
      interPromptPause: 0,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('errorResult');
  });

  it('staggers worker startup when interPromptPause and concurrency are both set', async () => {
    const agent = new TestAgent({
      responses: [{ status: 'success', output: 'ok' }],
      repeat: 'cycle',
    });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b' },
      { id: 'c', prompt: 'c' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'conc-stagger',
      agent,
      outputDir: repoPath,
      promptGenerator,
      concurrency: 2,
      interPromptPause: 2,
    });

    expect(result).toEqual({ status: 'completed' });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: FAIL - the overlap test sees `maxActive` of 1 and the serialization test is unprotected, because the body is still serial.

- [ ] **Step 3: Convert the loop body in `src/loop.ts`**

Add the two imports near the other util imports:

```ts
import { runPool } from './util/run-pool.js';
import { serializeReporter } from './util/serialize-reporter.js';
```

Replace the entire block from `let completed = 0;` through the `return { status: 'completed' };` at the end of `loopImpl` (the current lines 128-209) with:

```ts
  let completed = 0;
  let glitchCount = 0;
  let stopResult: LoopRunResult | undefined;

  // Serialize report appends and stagger worker startup only when running
  // concurrently; at concurrency 1 both are no-ops and the serial path is
  // unchanged.
  const activeReporter =
    concurrency > 1 ? serializeReporter(reporter) : reporter;
  const staggerSeconds =
    interPromptPause > 0 && concurrency > 1
      ? interPromptPause / concurrency
      : 0;

  try {
    await runPool(
      promptGenerator.generate(loopState),
      concurrency,
      async (prompt): Promise<'continue' | 'stop'> => {
        if (!(await loopState.claim(runId, prompt.id))) {
          logger.state(`Skip (claimed elsewhere): ${prompt.id}`);
          return 'continue';
        }

        console.log(`Processing: ${prompt.id}`);
        logger.state(`Begin: ${prompt.id}`);
        logger.system(`Prompt:\n${prompt.prompt}`);

        const result = await agent.invoke(prompt.prompt, {
          logger,
          allowSourceUpdate,
        });
        await activeReporter.append(prompt, result);
        await loopState.complete(runId, prompt.id, result);
        logger.state(`End: ${prompt.id} (${result.status})`);

        if (result.status === 'success') {
          const message = `Loop: ${config.name} / ${prompt.id}\n\n${result.output}`;
          // istanbul ignore if
          if (git) {
            logger.info(`Committing changes for ${prompt.id}`);
            await git.maybeCommitAll(message);
          }
          console.log(message);
          logger.success(`${prompt.id}: ${result.output.slice(0, 120)}`);
          glitchCount = 0;
        } else if (result.status === 'glitch') {
          // "Consecutive" under concurrency means in completion order, not
          // dispatch order: workers complete in whatever order their agents
          // return, and the counter is shared across them.
          glitchCount++;
          if (glitchCount >= MAX_CONSECUTIVE_GLITCHES) {
            const message = `Aborting after ${MAX_CONSECUTIVE_GLITCHES} consecutive glitches. Last: ${result.reason}`;
            logger.error(message);
            stopResult = {
              status: 'failed',
              reason: 'tooManyGlitches',
              message,
            };
            return 'stop';
          }
          console.log(
            `Glitch ${glitchCount}/${MAX_CONSECUTIVE_GLITCHES} on ${prompt.id}: ${result.reason}`,
          );
          logger.error(`Glitch on ${prompt.id}: ${result.reason}`);
        } else {
          const message = `Error on ${prompt.id}: ${result.reason}`;
          logger.error(message);
          stopResult = { status: 'failed', reason: 'errorResult', message };
          return 'stop';
        }

        if (result.cost !== undefined) {
          logger.state(`Cost: ${formatCost(result.cost)}`);
        }
        // Budget is checked before maxPrompts so a prompt crossing both caps
        // stops with reason 'maxBudgetUsd'.
        const runningTotal = (await loopState.getSnapshot()).totalUsd;
        if (runningTotal >= maxBudgetUsd) {
          const message = `Budget reached after ${prompt.id}: $${runningTotal.toFixed(4)} >= $${maxBudgetUsd}`;
          logger.state(message);
          stopResult = { status: 'stopped', reason: 'maxBudgetUsd', message };
          return 'stop';
        }

        completed++;
        if (completed >= maxPrompts) {
          logger.state(`Reached limit of ${maxPrompts} prompts`);
          stopResult = {
            status: 'stopped',
            reason: 'maxPrompts',
            message: `Reached limit of ${maxPrompts} prompts`,
          };
          return 'stop';
        }

        if (interPromptPause !== 0) {
          logger.info(`Pausing ${interPromptPause}s before next prompt`);
          console.log(
            `Pause (${interPromptPause}s) before starting next prompt`,
          );
          await new Promise(resolve => {
            setTimeout(resolve, interPromptPause * 1_000);
          });
        }
        return 'continue';
      },
      { staggerSeconds },
    );
  } finally {
    await loopState.release(runId);
  }

  return stopResult ?? { status: 'completed' };
```

Notes for the implementer:

- The old `// istanbul ignore else` on the `interPromptPause !== 0` check is gone on purpose: the existing tests use the default non-zero pause (true branch) and the new concurrency tests use `interPromptPause: 0` (false branch), so both are covered now.
- `formatCost` and `MAX_CONSECUTIVE_GLITCHES` are unchanged and stay where they are.
- The error branch sets `stopResult` and returns `'stop'` instead of returning directly; the final `return stopResult ?? { status: 'completed' }` surfaces it after the pool drains.

- [ ] **Step 4: Add the interface doc notes**

In `src/prompt-generators.ts`, extend the `PromptGenerator` interface doc comment (the block above `export interface PromptGenerator`) with a concurrency note, for example appending this paragraph:

```
 * Under `concurrency > 1`, multiple yielded items may be in flight at once.
 * Generators must yield each id exactly once per run and must not rely on
 * `isOutstanding` reflecting items yielded earlier in the same run.
```

In `src/reporters.ts`, extend the `Reporter` interface doc comment (the block above `export interface Reporter`) with:

```
 * When the loop runs with `concurrency > 1`, appends are serialized so
 * implementations may assume calls do not overlap.
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: PASS - overlap test sees `maxActive > 1`, the reporter test sees `maxActive === 1`, the glitch and error tests stop as asserted, and all existing serial tests still pass.

- [ ] **Step 6: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, `loop.ts` at 100% (both `staggerSeconds` ternary outcomes, both reporter-selection outcomes, both `interPromptPause` outcomes, and the `stopResult ?? ...` fallback all covered).

- [ ] **Step 7: Commit**

```bash
git add src/loop.ts src/prompt-generators.ts src/reporters.ts src/__test__/loop.test.ts
git commit -m "Feature: Run the loop body through the concurrency pool"
```

---

## Self-review checklist (run after all sections)

1. Spec coverage against `step-04-in-process-concurrency.md` "Work" and "Done when":
   - `concurrency` in config, CLI, schema - Section 3.
   - Tested worker-pool helper - Section 1.
   - Loop body as a pool work callback - Section 4.
   - Reject `concurrency > 1` with `allowSourceUpdate` and with the batch generator - Section 3 (validation) + tests.
   - Reporter appends serialized when `concurrency > 1` - Section 2 + Section 4 wiring + no-interleave test.
   - `maxPrompts`, `maxBudgetUsd`, errors, too many glitches as completion-order stops with drain - Section 4.
   - `interPromptPause` per worker; staggered startup - Section 4 (`staggerSeconds`).
   - `concurrency: 1` preserves serial behaviour - all existing loop tests still green at concurrency 1.
2. Type consistency: `runPool` and `serializeReporter` signatures match their call sites in `loop.ts`; `LoopConfig.concurrency` is `number` (defaulted in `loop()`), `LoopCliConfig.concurrency` is `number | undefined`; `ParsedArgs.concurrency` is `number | undefined`.
3. Final full gate: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format` clean with coverage at 100%.

## Out of scope (do not implement)

Per the step doc: global rate limiting (a token bucket across workers), parallelizing inside the batch generator, and cross-process or `worker_threads` concurrency. Claim cleanup on a hard crash stays best-effort (Step 10 owns the release lifecycle).
