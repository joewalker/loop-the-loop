# Step 01: Runtime Contracts and State Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the loop's status-string return with a structured `LoopRunResult`, make the v2 loop-state file the only supported persisted format with atomic writes, and move the filesystem backend behind a `createLoopState` factory shaped like `createReporter`.

**Architecture:** Three independent sub-sections, each landing in its own commit and each leaving `pnpm tsc && pnpm test --coverage` green. Section 1 changes the loop's return contract (no state-file changes). Section 2 hardens the existing filesystem backend in place (strict v2 load, atomic tmp+rename write, drop legacy migration). Section 3 moves that backend to `src/loop-states/file.ts` and reshapes `createLoopState` to a backend-constructor map so Step 10 can register an `s3` backend without touching callers.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (v8 coverage, 100% thresholds, `local` tag filter), pnpm, oxlint, oxfmt.

---

## Background and key facts

These were verified against the current tree before writing the plan. Read them before starting; they prevent wrong turns.

- `loop()` and the inner `loopImpl()` currently return `Promise<string>` (`"Done"`, `"Error on …"`, `"Aborting after 5 consecutive glitches…"`, `"Done (reached limit of N prompts)"`). The only consumer is [src/cli.ts:31](../../../src/cli.ts#L31), which `console.log`s the string.
- The `LoopState` interface, the persisted-shape types (`PromptOutcome`, `PromptClaim`, `LoopStateSnapshot`), and `createLoopState(path)` live in [src/loop-states.ts](../../../src/loop-states.ts). `createLoopState` simply calls `FileLoopState.create(path)`.
- The filesystem backend lives in [src/util/loop-state.ts](../../../src/util/loop-state.ts) and is tested in [src/util/\_\_test\_\_/loop-state.test.ts](../../../src/util/__test__/loop-state.test.ts).
- `FileLoopState` is referenced only from `src/loop-states.ts` (the factory) and its own test file. Its `completed` / `failed` getters and the legacy compatibility constructor are used **only** by tests, never by production code. So removing them is safe.
- `createReporter` in [src/reporters.ts](../../../src/reporters.ts) is the shape to mirror for `createLoopState`: a `Record<name, (config) => Promise<T>>` constructor map, a `DEFAULT_*` key, a `*Spec` union, and a default-typed `type` parameter. Each backend's `create(config)` takes `{ outputDir, jobName }` and builds its own path (see [YamlReporter.create](../../../src/reporters/yaml.ts#L18)).
- `cli.ts` is **not** measured by coverage (Vitest v8 only reports files imported during the test run, and no test imports `cli.ts`). Changing it cannot break the 100% threshold, but it is also not protected by tests, so keep its logic trivial.
- This step adds **no** CLI JSON config field, so per the roadmap's lockstep rule it needs **no** `schema/loop-the-loop.schema.json` change, no `src/examples/` change, and no README change. Do not touch those files.
- Commit messages in this repo use a leading tag (`Feature:`, `Fix:`, `Refactor:`, `Testing:`, `Docs:`). Follow the existing style. Per AGENTS.md, do not add `Co-Authored-By` trailers and do not run any `git add`/`git mv`/`git rm` or commit until the user explicitly asks — see "A note on committing" below.

### Target type definitions (used across all three sections)

`LoopRunResult`, added to `src/types.ts`:

```ts
/**
 * The structured outcome of a full loop run. Callers branch on the
 * `status` field and the optional `reason`, never on a parsed message
 * string. The reason set is open to extension by later steps (for
 * example Step 06 adds a pipeline-level `maxPasses` stop).
 */
export interface LoopRunResult {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly reason?:
    | 'maxPrompts'
    | 'maxBudgetUsd'
    | 'errorResult'
    | 'tooManyGlitches';
  readonly message?: string;
}
```

Status-to-reason mapping the loop produces:

- generator exhausted with no error/glitch-abort → `{ status: 'completed' }`
- `maxPrompts` reached (including `maxPrompts <= 0`) → `{ status: 'stopped', reason: 'maxPrompts', message }`
- an agent `error` result → `{ status: 'failed', reason: 'errorResult', message }`
- `MAX_CONSECUTIVE_GLITCHES` consecutive glitches → `{ status: 'failed', reason: 'tooManyGlitches', message }`
- `maxBudgetUsd` is reserved for Step 03 and is not produced by this step. It is in the union now so the contract is stable.

### A note on committing

Each section below ends with a "Commit" step. AGENTS.md forbids touching git without the user's explicit request. Treat each "Commit" step as: run the full completion gate, then **ask the user** to commit (or commit only if they have already said to). The command blocks are the exact messages to use when commit is authorized.

---

## File Structure

- `src/types.ts` — gains `LoopRunResult` (sits next to `InvokeResult`). Modified in Section 1.
- `src/loop-states.ts` — re-exports `LoopRunResult`; in Section 3 its `createLoopState` becomes a backend-constructor map and its `FileLoopState` import path changes. The `LoopState` / snapshot types stay here (they are the state contract; not moved).
- `src/loop.ts` — `loop()` / `loopImpl()` return `LoopRunResult` (Section 1); `createLoopState` call site updated to the new factory shape (Section 3).
- `src/cli.ts` — renders a `LoopRunResult` to a console string (Section 1).
- `src/index.ts` — exports the `LoopRunResult` type (Section 1).
- `src/util/loop-state.ts` — hardened in place (Section 2), then moved to `src/loop-states/file.ts` and deleted (Section 3).
- `src/util/__test__/loop-state.test.ts` — updated in place (Section 2), then moved to `src/loop-states/__test__/file.test.ts` and deleted (Section 3).
- `src/__test__/loop.test.ts` — assertions switch from string matching to structured `LoopRunResult` (Section 1).

> **Decision noted:** Step 01's "Files" list says `src/types.ts` holds "LoopRunResult and the v2 state types." This plan puts `LoopRunResult` in `types.ts` but **keeps** the persisted-shape types (`PromptOutcome`, `PromptClaim`, `LoopStateSnapshot`) in `loop-states.ts`, where they already live and are re-exported. Moving them would be churn with no functional gain and risks the type-only imports in the live prompt-generator tests. If you (or the user) prefer strict adherence, move those three types to `types.ts` and re-export from `loop-states.ts` as a follow-up; nothing else in this plan depends on their location.

---

## Section 1: Structured `LoopRunResult` return contract

Replace the loop's status-string return with `LoopRunResult`. No state-file behavior changes here.

**Files:**
- Modify: `src/types.ts` (add `LoopRunResult`)
- Modify: `src/index.ts` (export `LoopRunResult`)
- Modify: `src/loop-states.ts` (re-export `LoopRunResult`)
- Modify: `src/loop.ts:36-53` (`loop`) and `src/loop.ts:76-175` (`loopImpl`)
- Modify: `src/cli.ts:31-32`
- Test: `src/__test__/loop.test.ts`

- [ ] **Step 1: Rewrite the loop tests to expect structured results (failing)**

In `src/__test__/loop.test.ts`, change the helper return type and import. At the top, add `LoopRunResult` to the type import from `loop-the-loop`:

```ts
import type {
  Agent,
  InvokeOptions,
  LoopRunResult,
  LoopState,
  Prompt,
  PromptGenerator,
} from 'loop-the-loop';
```

Change the helper signature ([loop.test.ts:65](../../../src/__test__/loop.test.ts#L65)) from `Promise<string>` to `Promise<LoopRunResult>`:

```ts
async function runMainWithFakeTimers(
  config: LoopCliConfig,
): Promise<LoopRunResult> {
```

Then replace each string assertion with a structured one:

```ts
// "should return a completed result when all prompts succeed" (was line 130)
expect(result).toEqual({ status: 'completed' });

// "should stop on error and return a failed result" (was lines 146-147)
expect(result).toEqual({
  status: 'failed',
  reason: 'errorResult',
  message: 'Error on bad.ts: parsing failed',
});

// "should abort after max consecutive glitches" (was line 173)
expect(result).toEqual({
  status: 'failed',
  reason: 'tooManyGlitches',
  message: expect.stringContaining('Aborting after 5 consecutive glitches'),
});

// "should reset glitch count after a success" (was line 201)
expect(result).toEqual({ status: 'completed' });

// "should not invoke the agent when maxPrompts is 0" (was line 216)
expect(result).toEqual({
  status: 'stopped',
  reason: 'maxPrompts',
  message: 'Reached limit of 0 prompts',
});
expect(agent.invokeOptions).toHaveLength(0);

// "should respect maxPrompts limit" (was line 240)
expect(result).toEqual({
  status: 'stopped',
  reason: 'maxPrompts',
  message: 'Reached limit of 1 prompts',
});

// "should not check git cleanliness when allowSourceUpdate is false" (was line 270)
expect(result).toEqual({ status: 'completed' });

// "should pass allowSourceUpdate to agent invocations" (was line 286)
expect(result).toEqual({
  status: 'failed',
  reason: 'errorResult',
  message: 'Error on a.ts: stop',
});
expect(agent.invokeOptions).toHaveLength(1);
expect(agent.invokeOptions[0]?.allowSourceUpdate).toBe(true);

// "should return ... with an empty prompt generator" (was line ~300)
expect(result).toEqual({ status: 'completed' });
```

Leave the "should throw if working directory is not clean…" test unchanged (it asserts a rejection, not a return value). Update the three remaining `it(...)` titles that say `"Done"` to describe the structured result (for example `'should return a completed result when all prompts succeed'`) so the names stop lying.

- [ ] **Step 2: Run the loop tests to verify they fail**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: FAIL — `tsc`/Vitest reports `result` is typed `string` so `.toEqual({ status: … })` mismatches, and `LoopRunResult` is not exported from `loop-the-loop`.

- [ ] **Step 3: Add `LoopRunResult` to `src/types.ts`**

Append after the `InvokeResult` union (after [types.ts:71](../../../src/types.ts#L71)):

```ts
/**
 * The structured outcome of a full loop run. Callers branch on the
 * `status` field and the optional `reason`, never on a parsed message
 * string. The reason set is open to extension by later steps (for
 * example Step 06 adds a pipeline-level `maxPasses` stop).
 */
export interface LoopRunResult {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly reason?:
    | 'maxPrompts'
    | 'maxBudgetUsd'
    | 'errorResult'
    | 'tooManyGlitches';
  readonly message?: string;
}
```

- [ ] **Step 4: Export `LoopRunResult` from the package surface**

In `src/index.ts`, add `LoopRunResult` to the `export type { … } from './types.js'` block ([index.ts:23-31](../../../src/index.ts#L23-L31)):

```ts
export type {
  CostInfo,
  ErrorInvocationResult,
  GlitchedInvocationResult,
  InvokeResult,
  LoopCliConfig,
  LoopRunResult,
  OutputSchema,
  SuccessfulInvocationResult,
} from './types.js';
```

In `src/loop-states.ts`, extend the existing re-export line ([loop-states.ts:4](../../../src/loop-states.ts#L4)) so the type is also reachable there (the Step 01 spec lists `loop-states.ts` as a home for `LoopRunResult`):

```ts
export type { CostInfo, LoopRunResult } from './types.js';
```

- [ ] **Step 5: Change `loop.ts` to return `LoopRunResult`**

In `src/loop.ts`, update the import of types ([loop.ts:17](../../../src/loop.ts#L17)):

```ts
import type { LoopCliConfig, LoopRunResult } from './types.js';
```

Change `loop`'s signature ([loop.ts:36](../../../src/loop.ts#L36)) to `Promise<LoopRunResult>`:

```ts
export async function loop(config: LoopCliConfig): Promise<LoopRunResult> {
```

Change `loopImpl`'s signature ([loop.ts:76](../../../src/loop.ts#L76)) to `Promise<LoopRunResult>`:

```ts
async function loopImpl(config: LoopConfig): Promise<LoopRunResult> {
```

Replace each `return`/return-string in `loopImpl`:

The early `maxPrompts <= 0` guard ([loop.ts:102-105](../../../src/loop.ts#L102-L105)):

```ts
  if (maxPrompts <= 0) {
    logger.state(`Reached limit of ${maxPrompts} prompts`);
    return {
      status: 'stopped',
      reason: 'maxPrompts',
      message: `Reached limit of ${maxPrompts} prompts`,
    };
  }
```

The glitch-abort branch ([loop.ts:140-145](../../../src/loop.ts#L140-L145)):

```ts
        if (glitchCount >= MAX_CONSECUTIVE_GLITCHES) {
          const message = `Aborting after ${MAX_CONSECUTIVE_GLITCHES} consecutive glitches. Last: ${result.reason}`;
          logger.error(message);
          return { status: 'failed', reason: 'tooManyGlitches', message };
        }
```

The error branch ([loop.ts:150-153](../../../src/loop.ts#L150-L153)):

```ts
      } else {
        const message = `Error on ${prompt.id}: ${result.reason}`;
        logger.error(message);
        return { status: 'failed', reason: 'errorResult', message };
      }
```

The `completed >= maxPrompts` branch ([loop.ts:156-159](../../../src/loop.ts#L156-L159)):

```ts
      if (completed >= maxPrompts) {
        logger.state(`Reached limit of ${maxPrompts} prompts`);
        return {
          status: 'stopped',
          reason: 'maxPrompts',
          message: `Reached limit of ${maxPrompts} prompts`,
        };
      }
```

The final fall-through ([loop.ts:174](../../../src/loop.ts#L174)):

```ts
  return { status: 'completed' };
```

- [ ] **Step 6: Render the result in `src/cli.ts`**

Replace [cli.ts:31-32](../../../src/cli.ts#L31-L32):

```ts
  const config = await loadCliConfig(parsedArgs);
  const result = await loop(config);
  console.log(renderRunResult(result));
}

/**
 * Render a structured loop result as a single human-readable line for
 * the CLI. The loop's own `message` carries the detail; this only adds
 * the familiar "Done" framing for completed and stopped runs.
 */
function renderRunResult(result: LoopRunResult): string {
  if (result.status === 'completed') {
    return 'Done';
  }
  if (result.status === 'stopped') {
    return `Done (${result.message ?? result.reason})`;
  }
  return result.message ?? 'Failed';
}
```

Add the type import near the top of `src/cli.ts` (after [cli.ts:6](../../../src/cli.ts#L6)):

```ts
import { loop } from './loop.js';
import type { LoopRunResult } from './types.js';
```

- [ ] **Step 7: Run the loop tests to verify they pass**

Run: `pnpm test src/__test__/loop.test.ts`
Expected: PASS — all loop tests green with structured assertions.

- [ ] **Step 8: Full gate and commit**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: tsc clean, tests pass, coverage 100%, lint clean, format leaves no diff.

When the user authorizes the commit:

```bash
git commit -am "Refactor: Return a structured LoopRunResult from loop()"
```

---

## Section 2: Strict v2 state loading and atomic writes

Harden the filesystem backend in its current location. Drop legacy migration, fail clearly on non-v2 files, write via a temp file + rename, and remove the dead compatibility constructor and `completed`/`failed` getters.

**Files:**
- Modify: `src/util/loop-state.ts`
- Test: `src/util/__test__/loop-state.test.ts`

- [ ] **Step 1: Update the tests for strict loading and atomic writes (failing)**

In `src/util/__test__/loop-state.test.ts`:

Delete these three legacy-migration tests outright:
- `'should migrate old failed ids'` (lines ~55-82)
- `'should load completed ids from saved state'` (lines ~166-184)
- `'should drop old in-progress values on load'` (lines ~400-423)

Delete these two tests that exercise the to-be-removed getters:
- `'should expose completed and failed ids through the getters'` (lines ~277-292)
- `'should default a failed reason to an empty string in the getter'` (lines ~294-313)

Change `'should default results and claims to empty when missing from saved state'` so the file is a valid v2 document (a bare `{}` is no longer accepted):

```ts
  it('should default results and claims to empty when missing from saved state', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(path, `${JSON.stringify({ version: 2 }, null, 2)}\n`);

    const loopState = await FileLoopState.create(path);

    expect(loopState.isOutstanding('anything')).toBe(true);
    expect(await loopState.getSnapshot()).toEqual({
      version: 2,
      results: {},
      claims: {},
      totalUsd: 0,
    });
  });
```

Add a test that a non-v2 file fails clearly:

```ts
  it('should reject a state file that is not version 2', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify({ completed: ['x'], failed: [] }, null, 2)}\n`,
    );

    await expect(FileLoopState.create(path)).rejects.toThrow(
      /Unsupported loop-state file/,
    );
  });
```

Add a test that writes are atomic (no stray temp file remains):

```ts
  it('should write atomically and leave no temp file behind', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'item-1');
    await loopState.complete('run-1', 'item-1', {
      status: 'success',
      output: 'ok',
    });

    expect(JSON.parse(await readFile(path, 'utf-8')).results['item-1']).toEqual({
      status: 'success',
    });
    await expect(readFile(`${path}.tmp`, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
```

Leave `'should throw when the saved state is malformed'` (the `'{"completed": ['` JSON-parse case) unchanged — it still throws `SyntaxError` before any version check. The `'should swallow a failed write in the save chain'` test (which uses `new FileLoopState(dirPath)` against a directory path) also stays unchanged: with tmp+rename, `rename('<dir>.tmp', '<dir>')` rejects because the destination is an existing directory, so `save()` still rejects as the test asserts.

- [ ] **Step 2: Run the state tests to verify they fail**

Run: `pnpm test src/util/__test__/loop-state.test.ts`
Expected: FAIL — the new strict-load and atomic-write tests fail against the current migrating, non-atomic implementation.

- [ ] **Step 3: Rewrite `src/util/loop-state.ts` for strict v2 + atomic writes**

Replace the file contents with:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  LoopState,
  LoopStateSnapshot,
  LoopStateResult,
  PromptClaim,
  PromptOutcome,
} from '../loop-states.js';

/**
 * The only persisted shape we accept. A file that is not `version: 2`
 * fails clearly on load rather than being silently migrated.
 */
interface PersistedLoopState {
  readonly version: number;
  readonly results?: Record<string, PromptOutcome>;
  readonly claims?: Record<string, PromptClaim>;
  readonly totalUsd?: number;
}

/**
 * Persisted state for a running or interrupted loop. Saved before and
 * after every prompt execution so that any interruption loses at most one
 * item's work. Writes go through a temp file and an atomic rename so an
 * interrupted write never leaves a half-written file.
 */
export class FileLoopState implements LoopState {
  #path: string;
  #results: Map<string, PromptOutcome>;
  #claims: Map<string, PromptClaim>;
  #totalUsd: number;
  #saveChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#results = new Map();
    this.#claims = new Map();
    this.#totalUsd = 0;
  }

  /**
   * Create a state store for the given path. If a saved v2 state file
   * exists it is loaded; if none exists a fresh store is returned; a file
   * that exists but is not v2 throws.
   */
  static async create(path: string): Promise<FileLoopState> {
    try {
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw) as unknown;
      return FileLoopState.fromPersisted(path, data);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return new FileLoopState(path);
      }
      throw error;
    }
  }

  static fromPersisted(path: string, data: unknown): FileLoopState {
    if (!isV2(data)) {
      throw new Error(
        `Unsupported loop-state file at ${path}: expected a { version: 2, … } document. ` +
          `Pre-v2 state files are not supported; delete it to start a fresh run.`,
      );
    }

    const state = new FileLoopState(path);
    state.#results = new Map(Object.entries(data.results ?? {}));
    state.#claims = new Map(Object.entries(data.claims ?? {}));
    state.#totalUsd = isUsableTotal(data.totalUsd) ? data.totalUsd : 0;
    return state;
  }

  isOutstanding(id: string): boolean {
    return !this.#results.has(id);
  }

  async claim(runId: string, id: string): Promise<boolean> {
    if (this.#results.has(id)) {
      return false;
    }

    const claim = this.#claims.get(id);
    if (claim !== undefined && claim.runId !== runId) {
      return false;
    }

    if (claim === undefined) {
      this.#claims.set(id, {
        runId,
        claimedAt: new Date().toISOString(),
      });
      await this.save();
    }

    return true;
  }

  async complete(
    runId: string,
    id: string,
    result: LoopStateResult,
  ): Promise<void> {
    const claim = this.#claims.get(id);
    if (claim !== undefined && claim.runId !== runId) {
      return;
    }

    this.#addCost(result);

    if (result.status === 'success') {
      this.#results.set(id, {
        status: 'success',
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
      });
    }
    if (result.status === 'error') {
      this.#results.set(id, {
        status: 'error',
        reason: result.reason,
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
      });
    }

    this.#claims.delete(id);
    await this.save();
  }

  async release(runId: string): Promise<void> {
    let changed = false;
    for (const [id, claim] of this.#claims) {
      if (claim.runId === runId) {
        this.#claims.delete(id);
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  async getSnapshot(): Promise<LoopStateSnapshot> {
    return this.#snapshot();
  }

  get totalUsd(): number {
    return this.#totalUsd;
  }

  /**
   * Persist the current state to disk. Concurrent calls are serialized
   * through an internal chain so in-process updates are not lost.
   */
  async save(): Promise<void> {
    const next = this.#saveChain.then(() => this.#writeSnapshot());
    this.#saveChain = next.catch(() => {});
    await next;
  }

  #addCost(result: LoopStateResult): void {
    const cost = result.cost;
    if (
      cost === undefined ||
      cost.costSource === 'unavailable' ||
      !Number.isFinite(cost.usd) ||
      cost.usd < 0
    ) {
      return;
    }

    this.#totalUsd += cost.usd;
  }

  #snapshot(): LoopStateSnapshot {
    return {
      version: 2,
      results: Object.fromEntries(this.#results),
      claims: Object.fromEntries(this.#claims),
      totalUsd: this.#totalUsd,
    };
  }

  /**
   * Write the snapshot to a sibling temp file then rename it into place.
   * `rename` is atomic on a single filesystem, so a crash mid-write
   * leaves either the old file or the new file, never a partial one.
   */
  async #writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmpPath = `${this.#path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.#snapshot(), null, 2)}\n`);
    await rename(tmpPath, this.#path);
  }
}

/**
 * Narrow unknown parsed JSON to the supported v2 envelope. Only the
 * version is checked here; field shapes are trusted per the forward
 * contract (no legacy migration).
 */
function isV2(data: unknown): data is PersistedLoopState {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { version?: unknown }).version === 2
  );
}

function isUsableTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
```

Note what was removed: the `FailedState` interface, the legacy multi-arg constructor, `fromPersisted`'s migration branch, `migrateResults`, and the `completed` / `failed` getters. The `totalUsd` getter is kept because the cost tests use it and Step 03 consumes it.

- [ ] **Step 4: Run the state tests to verify they pass**

Run: `pnpm test src/util/__test__/loop-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, coverage 100%. If coverage flags an unreachable branch (for example a defensive default), prefer deleting the dead code over an ignore comment; use the `/coverage-to-100` skill if a genuine ignore is warranted.

When the user authorizes the commit:

```bash
git commit -am "Refactor: Require v2 loop-state files and write them atomically"
```

---

## Section 3: Move the backend to `src/loop-states/file.ts` and reshape `createLoopState`

Move `FileLoopState` to its own backend module and turn `createLoopState` into a `createReporter`-style factory keyed by backend name, so Step 10 can register an `s3` backend without changing callers.

**Files:**
- Create: `src/loop-states/file.ts`
- Create: `src/loop-states/__test__/file.test.ts`
- Modify: `src/loop-states.ts`
- Modify: `src/loop.ts`
- Delete: `src/util/loop-state.ts`
- Delete: `src/util/__test__/loop-state.test.ts`

- [ ] **Step 1: Create `src/loop-states/file.ts`**

Create the file with the hardened class from Section 2, with one import-path fix: it now sits one directory deeper, so the type import comes from `../loop-states.js`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  LoopState,
  LoopStateSnapshot,
  LoopStateResult,
  PromptClaim,
  PromptOutcome,
} from '../loop-states.js';

// … the entire FileLoopState class, isV2, and isUsableTotal exactly as
// written in Section 2 Step 3 (the import line above is the only change,
// and it is in fact identical because the old file was already one level
// deep under src/util/).
```

> The relative specifier `'../loop-states.js'` is the same string used by the old `src/util/loop-state.ts`, so the body can be copied verbatim from the Section 2 result.

- [ ] **Step 2: Create `src/loop-states/__test__/file.test.ts`**

Port the Section 2 test file. Two changes: the `@module-tag` header stays, and the import switches to the new absolute path (test files use absolute, extensionless specifiers per AGENTS.md):

```ts
// @module-tag local

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// … the entire describe('LoopState', …) block from the Section 2 result,
// unchanged.
```

- [ ] **Step 3: Reshape `createLoopState` in `src/loop-states.ts`**

Replace the bottom of `src/loop-states.ts` (the import at [loop-states.ts:2](../../../src/loop-states.ts#L2) and the `createLoopState` function at [loop-states.ts:38-43](../../../src/loop-states.ts#L38-L43)). New import line at the top:

```ts
import { join } from 'node:path';

import type { CostInfo, InvokeResult } from './types.js';
import { FileLoopState } from './loop-states/file.js';
```

New factory section at the bottom (replacing the old single-line `createLoopState`):

```ts
/**
 * Where a backend should write its state, mirroring `ReporterConfig`.
 * The filesystem backend turns this into `${outputDir}/${jobName}-loop-state.json`.
 */
export interface LoopStateConfig {
  readonly outputDir: string;
  readonly jobName: string;
}

export const DEFAULT_LOOP_STATE = 'file';

/**
 * Construct the default filesystem-backed store. Step 10 registers an
 * `s3` entry alongside this with no change to callers.
 */
function createFileLoopState(config: LoopStateConfig): Promise<LoopState> {
  const path = join(config.outputDir, `${config.jobName}-loop-state.json`);
  return FileLoopState.create(path);
}

/**
 * To add a new loop-state backend, add its creator function here.
 */
const loopStateConstructors = {
  [DEFAULT_LOOP_STATE]: createFileLoopState,
} satisfies Record<string, (config: LoopStateConfig) => Promise<LoopState>>;

/**
 * Enable TypeScript to know what backends are available.
 */
type LoopStateName = keyof typeof loopStateConstructors;

export type LoopStateSpec = LoopState | LoopStateName;

/**
 * Enable callers to discover the available loop-state backends.
 */
export const loopStateTypes = Object.keys(loopStateConstructors);

/**
 * Allow easy switching between loop-state backends, shaped like
 * `createReporter` so backend selection can be added without changing
 * callers again.
 */
export function createLoopState(
  type: LoopStateName = DEFAULT_LOOP_STATE,
  config: LoopStateConfig,
): Promise<LoopState> {
  return loopStateConstructors[type](config);
}
```

- [ ] **Step 4: Update the call site in `src/loop.ts`**

Replace the path-building and load block ([loop.ts:97-100](../../../src/loop.ts#L97-L100)):

```ts
  const loopState = await createLoopState(DEFAULT_LOOP_STATE, {
    outputDir,
    jobName: name,
  });
  const runId = randomUUID();
  logger.state(`Loaded loop state for ${name}`);
```

Update the `createLoopState` import in `src/loop.ts` ([loop.ts:7](../../../src/loop.ts#L7)) to also bring in the default key:

```ts
import { createLoopState, DEFAULT_LOOP_STATE } from './loop-states.js';
```

Then remove the now-unused `join` import. Check first: `join` is used only on the deleted path line (verify with `grep -n "join(" src/loop.ts`). If no other use remains, delete `import { join } from 'node:path';` ([loop.ts:3](../../../src/loop.ts#L3)).

- [ ] **Step 5: Delete the old backend and its test**

The user must run any `git rm`; for the working tree, delete the files:

```bash
rm src/util/loop-state.ts src/util/__test__/loop-state.test.ts
```

- [ ] **Step 6: Run the moved tests and type-check**

Run: `pnpm tsc && pnpm test src/loop-states/__test__/file.test.ts src/__test__/loop.test.ts`
Expected: PASS, no unresolved imports. If `tsc` reports a stale reference to `util/loop-state`, search for it with `rg -n "util/loop-state" src` and fix the importer (only `src/loop-states.ts` should have referenced it).

- [ ] **Step 7: Full gate and commit**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, coverage 100%.

When the user authorizes the commit:

```bash
git commit -am "Refactor: Move FileLoopState to a createLoopState backend map"
```

---

## Self-Review

**Spec coverage** (against `docs/future-plans/step-01-runtime-contracts-state-hardening.md`):

- Structured `LoopRunResult` with `maxPrompts` / `maxBudgetUsd` / `errorResult` / `tooManyGlitches` — Section 1, Step 3. `maxBudgetUsd` is in the union, reserved for Step 03.
- v2 the only supported persisted shape; non-v2 fails clearly — Section 2, Steps 1 and 3 (`isV2` + thrown error).
- Remove legacy `completed` / `failed` / `inProgress` / `begin` / `end` — Section 2 (migration code and getters deleted); `begin`/`end` were log lines and prose return strings, replaced in Section 1, Step 5.
- Move `FileLoopState` to `src/loop-states/file.ts` — Section 3, Steps 1 and 5.
- Atomic tmp-file + rename writes — Section 2, Step 3 (`#writeSnapshot`).
- Serialized saves preserved — `#saveChain` retained verbatim in Section 2.
- `createLoopState(spec, { outputDir, jobName })` with an internal constructor map, default writing `${outputDir}/${jobName}-loop-state.json` — Section 3, Step 3.
- `runId` via `crypto.randomUUID()` and `release(runId)` in `finally` — already present in `loop.ts` and left intact; Section 3 keeps both.
- Tests cover structured results, strict loading, atomic writes, serialized saves, claim ownership, completion, release, snapshots — Sections 1 and 2 (ownership/completion/release/snapshot tests are retained from the original suite).
- "Existing behavior preserved for current v2 files" — the v2 read/write path and `#saveChain` are unchanged; only legacy paths are removed.

**Placeholder scan:** No `TBD`/`handle edge cases`/"write tests for the above" — every code step shows full code; the two large copy-verbatim points (Section 3 Steps 1-2) reference the exact Section 2 output rather than re-pasting, which is intentional to avoid drift.

**Type consistency:** `LoopRunResult`, `LoopStateConfig`, `DEFAULT_LOOP_STATE`, `createLoopState(type, config)`, `FileLoopState.create(path)`, and `renderRunResult` are named identically everywhere they appear. The `message` strings in the loop (`Reached limit of N prompts`, `Error on <id>: <reason>`, `Aborting after 5 consecutive glitches. Last: …`) match the assertions in Section 1, Step 1.

**Out of scope (correctly excluded):** schema, `src/examples/`, and README — Step 01 adds no CLI config field or flag, so the roadmap's lockstep rule does not apply.
