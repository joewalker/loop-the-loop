# Step 05 Reader Generators plus Local Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `jsonl` and `loop-state` reader prompt generators so one loop can consume another loop's local output, with attempt-scoped re-emission, `structuredOutput` field-path filtering, and `{{steps.<name>.report|state}}` handoff substitution that keeps wiring correct when `outputDir`, pipeline, or step names change.

**Architecture:** Two new generators live beside the existing `json` generator. `jsonl` reads a `jsonl-report` line by line; `loop-state` reads the strict v2 state snapshot. A pure attempt-id helper parses and re-mints `#N` suffixes for bounded rework loops. Handoff substitution is a pure string rewrite applied during config normalization, resolving `{{steps.<name>.report}}` and `{{steps.<name>.state}}` to absolute paths under the consuming config's `outputDir`. Each reader gates emitted ids through the consuming step's own `loopState.isOutstanding`, so the consuming loop stays resumable.

**Tech Stack:** TypeScript (strict, ESM), vitest, ajv (schema test), pnpm. Coverage gate is 100% on non-ignored files. Every new file under `src/` is coverage-measured, so each new branch needs a test.

## Carry-over contract from Step 04

Read `docs/future-plans/next.md` before starting. The load-bearing facts:

- The loop body is now a worker-pool callback driven by `runPool`, not a `for await`. Step 05 does not touch the runner. The readers are consumed exactly the way the existing generators are.
- The `PromptGenerator` interface doc already states that under `concurrency > 1` multiple yielded items may be in flight and a generator must yield each id exactly once and must not rely on `isOutstanding` reflecting items yielded earlier in the same run. The readers satisfy this: they gate each id through `loopState.isOutstanding(id)` once, at yield time, and add no "wait for prior items" logic.
- A `jsonl-report` produced by a concurrent run is still one complete JSON object per line (`serializeReporter` guarantees non-interleaved appends), so the line-by-line reader can trust the format.
- The strict v2 snapshot (`{ version: 2, results, claims, totalUsd }`) and the `CostInfo` / `LoopRunResult` / `LoopStateSnapshot` types are unchanged. The `loop-state` reader consumes `results`; the `jsonl` reader passes cost through as an ordinary line field.
- CLI/schema touch-points are in a known state. The top-level `concurrency` flag and schema property are already present; leave them intact. Step 05's handoff substitution belongs in the config-normalization path (`normalizeCliConfig` / `normalizePromptGeneratorSpec`), not the flag parser.

## Established patterns this plan follows

- The `json` generator (`src/prompt-generators/json.ts`) is the template for both readers: a `static readonly promptGeneratorName`, a `static async create(task, basePath?)` factory, an async `*generate(loopState)` that resolves `dataFile` against `basePath` (the config dir), checks `loopState.isOutstanding(id)` before yielding, and detects duplicate ids. A `normalize<Name>TaskConfig(config)` function validates the config shape using the helpers in `src/prompt-generators/util/config.ts` (`isRecord`, `assertKnownProperties`, `assertRequiredString`, `assertOptionalString`, `assertOptionalBoolean`).
- Template expansion uses `expandPrompt(template, basePath, variables)` from `src/util/expand-prompt.js`, which resolves `{{include:...}}` then substitutes `{{key}}` variables.
- Registration: add the generator's `create` to `promptGeneratorCreators` in `src/prompt-generators.ts` (which auto-adds it to `promptGeneratorTypes`) and add a normalize branch to `normalizePromptGeneratorSpec`.
- The report file is `${outputDir}/${jobName}-report.jsonl` (`JsonlReporter`); the state file is `${outputDir}/${jobName}-loop-state.json` (`FileLoopState`). Handoff substitution targets exactly these names.
- Production imports are relative (`./util/attempt.js`); test imports are absolute (`loop-the-loop/prompt-generators/...`) with no extension. Test files start with `// @module-tag local`.

## Scope choices

- The new readers do not implement the optional `check()` doctor probe. `check()` is optional on `PromptGenerator`; omitting it keeps the surface (and coverage) small. Doctor handles its absence.
- Handoff substitution applies only to `jsonl.dataFile` and `loop-state.stateFile` (the reader fields the routing design uses). It is not applied to the `json` generator. Because `batch` normalization recurses with the same context, readers nested in a `batch` still get handoff resolution.
- The attempt knobs (`maxAttempts`, `minAttempts`, `incrementAttempt`) live on `jsonl` only. The routing model needs them only there (rework and giveup both read `jsonl`), and `loop-state` cannot carry a verdict. `loop-state` stays minimal: `stateFile`, `promptTemplate`, `select`.
- Equality matching in `filter` is string-coerced (`String(actual) === String(expected)`), so a numeric or boolean filter value matches its stringified line value. No operators, ranges, or expression language.

## File structure

Created:

- `src/prompt-generators/util/attempt.ts` - pure attempt-id helper (`parseAttempt`, `formatAttempt`, `resolveAttemptId`). No I/O.
- `src/prompt-generators/util/__test__/attempt.test.ts` - unit tests for the attempt helper.
- `src/prompt-generators/util/handoff.ts` - pure `resolveStepHandoff(value, outputDir)` string rewrite. No I/O.
- `src/prompt-generators/util/__test__/handoff.test.ts` - unit tests for the handoff rewrite.
- `src/prompt-generators/loop-state.ts` - the `loop-state` reader generator.
- `src/prompt-generators/__test__/loop-state.test.ts` - tests for the reader.
- `src/prompt-generators/jsonl.ts` - the `jsonl` reader generator.
- `src/prompt-generators/__test__/jsonl.test.ts` - tests for the reader.
- `src/examples/reader-generators/jsonl-rework.json` - example exercising `jsonl` filter + attempt knobs + handoff.
- `src/examples/reader-generators/loop-state-retry.json` - example exercising `loop-state` select + handoff.
- `src/examples/reader-generators/README.md` - note describing the examples.

Modified:

- `src/prompt-generators/util/config.ts` - add `outputDir` to `PromptGeneratorConfigContext`.
- `src/prompt-generators.ts` - register `loop-state` and `jsonl`; add their normalize branches (resolving handoff via `context.outputDir`).
- `src/util/load-cli-config.ts` - pass `outputDir` into the normalization context.
- `schema/loop-the-loop.schema.json` - add `loopStateTask` and `jsonlTask` definitions and their `promptGeneratorSpec` tuple entries.
- `src/__test__/schema.test.ts` - positive cases for both readers.
- `src/prompt-generators/__test__/prompt-generators.test.ts` - assert both new names are registered.
- `src/util/__test__/load-cli-config.test.ts` - handoff substitution integration test.
- `README.md` - "Reader generators and local handoff" section.

## Execution and commit protocol

Each section below is self-contained and ends with a commit. Sections are ordered so the build stays green (`pnpm tsc && pnpm test --coverage` clean, 100% coverage) after every commit. Dispatch one fresh sub-agent per section. Between sections the orchestrator runs the completion gate and reviews the diff before starting the next section.

Per AGENTS.md: stay on the `main` branch, do not open PRs, never run `git add`/`git mv`/`git rm` outside the commit step, use the default `~/.gitconfig` author, and do NOT add a `Co-Authored-By` trailer. Commit message tags follow recent history (`Feature:`, `Fix:`, `Docs:`). Before each commit run `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`.

Section ordering rationale: the two pure helpers come first so the readers can import them. `loop-state` (Section 2) is simpler than `jsonl` and establishes the reader pattern (missing-file-as-empty, v2 validation). `jsonl` (Section 3) adds filtering and the attempt knobs. Handoff substitution (Section 4) is layered on after both readers exist, touching only normalization. Examples and docs (Section 5) come last, once the schema supports the new task shapes.

---

## Section 1: The attempt-id helper

A pure, dependency-free helper that parses and re-mints `#N` attempt suffixes. Built and committed first so `jsonl` can import it.

**Files:**

- Create: `src/prompt-generators/util/attempt.ts`
- Test: `src/prompt-generators/util/__test__/attempt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/prompt-generators/util/__test__/attempt.test.ts`:

```ts
// @module-tag local

import {
  formatAttempt,
  parseAttempt,
  resolveAttemptId,
} from 'loop-the-loop/prompt-generators/util/attempt';
import { describe, expect, it } from 'vitest';

describe('parseAttempt', () => {
  it('treats a bare id as attempt 1', () => {
    expect(parseAttempt('bug-1')).toEqual({ base: 'bug-1', attempt: 1 });
  });

  it('parses a numeric suffix of 2 or more as the attempt', () => {
    expect(parseAttempt('bug-1#2')).toEqual({ base: 'bug-1', attempt: 2 });
    expect(parseAttempt('bug-1#10')).toEqual({ base: 'bug-1', attempt: 10 });
  });

  it('keeps a #1 or #0 suffix as part of the base so ids round-trip', () => {
    expect(parseAttempt('bug-1#1')).toEqual({ base: 'bug-1#1', attempt: 1 });
    expect(parseAttempt('bug-1#0')).toEqual({ base: 'bug-1#0', attempt: 1 });
  });

  it('keeps a non-numeric suffix as part of the base', () => {
    expect(parseAttempt('bug#abc')).toEqual({ base: 'bug#abc', attempt: 1 });
  });

  it('does not treat a leading-# id as an attempt suffix', () => {
    expect(parseAttempt('#2')).toEqual({ base: '#2', attempt: 1 });
  });
});

describe('formatAttempt', () => {
  it('renders attempt 1 as the bare base', () => {
    expect(formatAttempt('bug-1', 1)).toBe('bug-1');
  });

  it('renders attempt 2 or more with a #N suffix', () => {
    expect(formatAttempt('bug-1', 2)).toBe('bug-1#2');
    expect(formatAttempt('bug-1', 5)).toBe('bug-1#5');
  });

  it('round-trips with parseAttempt', () => {
    const { base, attempt } = parseAttempt('bug-1#3');
    expect(formatAttempt(base, attempt)).toBe('bug-1#3');
  });
});

describe('resolveAttemptId', () => {
  it('returns the id verbatim with no knobs', () => {
    expect(resolveAttemptId('bug-1', {})).toBe('bug-1');
    expect(resolveAttemptId('bug-1#2', {})).toBe('bug-1#2');
  });

  it('increments the attempt when incrementAttempt is set', () => {
    expect(resolveAttemptId('bug-1', { incrementAttempt: true })).toBe(
      'bug-1#2',
    );
    expect(resolveAttemptId('bug-1#2', { incrementAttempt: true })).toBe(
      'bug-1#3',
    );
  });

  it('emits only while the incoming attempt is below maxAttempts', () => {
    expect(
      resolveAttemptId('bug-1', { maxAttempts: 3, incrementAttempt: true }),
    ).toBe('bug-1#2');
    expect(
      resolveAttemptId('bug-1#2', { maxAttempts: 3, incrementAttempt: true }),
    ).toBe('bug-1#3');
    expect(
      resolveAttemptId('bug-1#3', { maxAttempts: 3, incrementAttempt: true }),
    ).toBeNull();
  });

  it('emits only once the incoming attempt is at or above minAttempts', () => {
    expect(resolveAttemptId('bug-1', { minAttempts: 3 })).toBeNull();
    expect(resolveAttemptId('bug-1#2', { minAttempts: 3 })).toBeNull();
    expect(resolveAttemptId('bug-1#3', { minAttempts: 3 })).toBe('bug-1#3');
  });

  it('applies both gates together', () => {
    expect(
      resolveAttemptId('bug-1#2', { minAttempts: 2, maxAttempts: 4 }),
    ).toBe('bug-1#2');
    expect(
      resolveAttemptId('bug-1', { minAttempts: 2, maxAttempts: 4 }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/prompt-generators/util/__test__/attempt.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/prompt-generators/util/attempt`.

- [ ] **Step 3: Implement `src/prompt-generators/util/attempt.ts`**

```ts
/**
 * Attempt knobs that gate and re-mint an id for bounded rework loops. A
 * reader (currently `jsonl`) parses the `#N` attempt suffix off an incoming
 * id, decides whether to emit it, and optionally re-emits it at the next
 * attempt. Attempt 1 is the bare id with no suffix; rework mints `id#2`,
 * `id#3`, and so on. See `docs/future-plans/conditional-routing-design.md`.
 */
export interface AttemptKnobs {
  /**
   * Emit only while the incoming attempt is strictly below this value.
   */
  readonly maxAttempts?: number;

  /**
   * Emit only once the incoming attempt is at or above this value.
   */
  readonly minAttempts?: number;

  /**
   * When true, emit the id at the next attempt (`#(N+1)`) rather than
   * verbatim. This is how a loop-back reader re-enters work.
   */
  readonly incrementAttempt?: boolean;
}

/**
 * Split an id into its base and attempt number. Only a numeric suffix of 2 or
 * more after the last `#` counts as an attempt marker, so a bare id is attempt
 * 1 and ids that legitimately contain `#` (or `#1`/`#0`) round-trip unchanged.
 */
export function parseAttempt(id: string): {
  readonly base: string;
  readonly attempt: number;
} {
  const hash = id.lastIndexOf('#');
  if (hash > 0) {
    const suffix = id.slice(hash + 1);
    if (/^\d+$/u.test(suffix)) {
      const attempt = Number(suffix);
      if (attempt >= 2) {
        return { base: id.slice(0, hash), attempt };
      }
    }
  }
  return { base: id, attempt: 1 };
}

/**
 * Render a base id at a given attempt. Attempt 1 is the bare base; higher
 * attempts append `#N`. Inverse of {@link parseAttempt}.
 */
export function formatAttempt(base: string, attempt: number): string {
  return attempt >= 2 ? `${base}#${attempt}` : base;
}

/**
 * Apply the attempt knobs to an incoming id. Returns the id to emit (possibly
 * incremented) or `null` when the gates suppress it.
 */
export function resolveAttemptId(
  id: string,
  knobs: AttemptKnobs,
): string | null {
  const { base, attempt } = parseAttempt(id);
  if (knobs.maxAttempts !== undefined && attempt >= knobs.maxAttempts) {
    return null;
  }
  if (knobs.minAttempts !== undefined && attempt < knobs.minAttempts) {
    return null;
  }
  const nextAttempt = knobs.incrementAttempt === true ? attempt + 1 : attempt;
  return formatAttempt(base, nextAttempt);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/prompt-generators/util/__test__/attempt.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, `attempt.ts` at 100%.

- [ ] **Step 6: Commit**

```bash
git add src/prompt-generators/util/attempt.ts src/prompt-generators/util/__test__/attempt.test.ts
git commit -m "Feature: Add attempt-scoped id helper for reader generators"
```

---

## Section 2: The `loop-state` reader

A generator that reads the strict v2 state snapshot and yields prompts from per-id outcomes. Establishes the reader pattern (missing file as empty, malformed as error, v2 validation).

**Files:**

- Create: `src/prompt-generators/loop-state.ts`
- Modify: `src/prompt-generators.ts`, `schema/loop-the-loop.schema.json`, `src/__test__/schema.test.ts`, `src/prompt-generators/__test__/prompt-generators.test.ts`
- Test: `src/prompt-generators/__test__/loop-state.test.ts`

- [ ] **Step 1: Write the failing reader test**

Create `src/prompt-generators/__test__/loop-state.test.ts`:

```ts
// @module-tag local

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  LoopStatePromptGenerator,
  normalizeLoopStateTaskConfig,
  type LoopStateTask,
} from 'loop-the-loop/prompt-generators/loop-state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SNAPSHOT = {
  version: 2,
  results: {
    a: { status: 'success' },
    b: { status: 'error', reason: 'broke' },
    c: { status: 'success' },
  },
  claims: { d: { runId: 'r', claimedAt: 'now' } },
  totalUsd: 0,
};

describe('LoopStatePromptGenerator', () => {
  let dir: string;
  const loopState = new FileLoopState('ignore.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-state-reader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function collect(task: LoopStateTask): Promise<Array<Prompt>> {
    const generator = await LoopStatePromptGenerator.create(task, dir);
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  async function writeState(name: string, value: unknown): Promise<string> {
    await writeFile(join(dir, name), `${JSON.stringify(value)}\n`);
    return name;
  }

  it('yields only successes by default and ignores claims', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const prompts = await collect({
      stateFile,
      promptTemplate: 'Continue {{id}} ({{status}})',
    });
    expect(prompts).toEqual([
      { id: 'a', prompt: 'Continue a (success)' },
      { id: 'c', prompt: 'Continue c (success)' },
    ]);
  });

  it('selects errors and exposes the reason', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const prompts = await collect({
      stateFile,
      select: 'error',
      promptTemplate: 'Retry {{id}}: {{reason}}',
    });
    expect(prompts).toEqual([{ id: 'b', prompt: 'Retry b: broke' }]);
  });

  it('selects all outcomes', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const prompts = await collect({
      stateFile,
      select: 'all',
      promptTemplate: '{{id}}={{status}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing state file as empty input', async () => {
    const prompts = await collect({
      stateFile: 'does-not-exist.json',
      promptTemplate: '{{id}}',
    });
    expect(prompts).toEqual([]);
  });

  it('skips ids that are no longer outstanding in the consuming loop', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const consuming = new FileLoopState('ignore.json');
    await consuming.complete('r', 'a', { status: 'success', output: '' });
    const generator = await LoopStatePromptGenerator.create(
      { stateFile, promptTemplate: '{{id}}' },
      dir,
    );
    const ids: Array<string> = [];
    for await (const prompt of generator.generate(consuming)) {
      ids.push(prompt.id);
    }
    expect(ids).toEqual(['c']);
  });

  it('throws a clear error for a present but non-v2 file', async () => {
    const stateFile = await writeState('old.json', { version: 1 });
    await expect(
      collect({ stateFile, promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/expected a \{ version: 2/u);
  });

  it('throws for a malformed (non-JSON) file', async () => {
    await writeFile(join(dir, 'bad.json'), 'not json');
    await expect(
      collect({ stateFile: 'bad.json', promptTemplate: '{{id}}' }),
    ).rejects.toThrow();
  });
});

describe('normalizeLoopStateTaskConfig', () => {
  it('accepts a minimal config', () => {
    expect(
      normalizeLoopStateTaskConfig({
        stateFile: 's.json',
        promptTemplate: '{{id}}',
      }),
    ).toEqual({ stateFile: 's.json', promptTemplate: '{{id}}' });
  });

  it('rejects a non-object', () => {
    expect(() => normalizeLoopStateTaskConfig('x')).toThrow(
      'loop-state task config must be an object',
    );
  });

  it('rejects an unknown property', () => {
    expect(() =>
      normalizeLoopStateTaskConfig({
        stateFile: 's.json',
        promptTemplate: '{{id}}',
        nope: 1,
      }),
    ).toThrow('loop-state.nope is not supported');
  });

  it('rejects a missing stateFile', () => {
    expect(() =>
      normalizeLoopStateTaskConfig({ promptTemplate: '{{id}}' }),
    ).toThrow('loop-state.stateFile must be a string');
  });

  it('rejects an invalid select', () => {
    expect(() =>
      normalizeLoopStateTaskConfig({
        stateFile: 's.json',
        promptTemplate: '{{id}}',
        select: 'maybe',
      }),
    ).toThrow('loop-state.select must be one of success, error, all');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/prompt-generators/__test__/loop-state.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/prompt-generators/loop-state`.

- [ ] **Step 3: Implement `src/prompt-generators/loop-state.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FileLoopState } from '../loop-states/file.js';
import type { LoopState, PromptOutcome } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import {
  assertKnownProperties,
  assertRequiredString,
  isRecord,
} from './util/config.js';

/**
 * Which terminal outcomes the `loop-state` reader yields. `success` is the
 * default because it is the safe choice for forward progress.
 */
export type LoopStateSelect = 'success' | 'error' | 'all';

/**
 * Configuration for the `loop-state` reader, which yields prompts from the
 * per-id terminal outcomes recorded in a strict v2 loop-state snapshot.
 */
export interface LoopStateTask {
  /**
   * Path to the v2 state file, config-relative or a `{{steps.<name>.state}}`
   * handoff substitution.
   */
  stateFile: string;

  /**
   * Prompt template. Placeholders: `{{id}}`, `{{status}}`, and `{{reason}}`
   * (only for error outcomes). Supports `{{include:path}}` macros.
   */
  promptTemplate: string;

  /**
   * Which outcomes to yield. Defaults to `success`.
   */
  select?: LoopStateSelect;
}

/**
 * Normalize a `loop-state` task config loaded from JSON.
 */
export function normalizeLoopStateTaskConfig(config: unknown): LoopStateTask {
  assertLoopStateTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that reads a strict v2 loop-state snapshot and yields one
 * prompt per terminal outcome, for status-based routing without the full
 * report. Entries are derived from `results`; `claims` are ignored because an
 * active claim is not a terminal routing decision. The reader cannot provide
 * `output` or `structuredOutput`, which the state file deliberately does not
 * store; use the `jsonl` reader when the upstream text or a verdict is needed.
 */
export class LoopStatePromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'loop-state';

  static async create(
    task: LoopStateTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new LoopStatePromptGenerator(task, basePath);
  }

  readonly #task: LoopStateTask;
  readonly #basePath: string;

  constructor(task: LoopStateTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const filePath = resolve(this.#basePath, this.#task.stateFile);
    const results = await loadResults(filePath);
    const select = this.#task.select ?? 'success';

    for (const [id, outcome] of results) {
      if (select !== 'all' && outcome.status !== select) {
        continue;
      }
      if (loopState.isOutstanding(id)) {
        const variables: Record<string, string> = {
          id,
          status: outcome.status,
        };
        if (outcome.status === 'error' && outcome.reason !== undefined) {
          variables['reason'] = outcome.reason;
        }
        const prompt = await expandPrompt(
          this.#task.promptTemplate,
          this.#basePath,
          variables,
        );
        yield { id, prompt };
      }
    }
  }
}

/**
 * Load the `results` map from a v2 state file. A missing file is empty input;
 * a present-but-malformed or non-v2 file throws (the v2 contract is enforced
 * by `FileLoopState.fromPersisted`).
 */
async function loadResults(
  filePath: string,
): Promise<ReadonlyMap<string, PromptOutcome>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      return new Map();
    }
    throw err;
  }
  const data = JSON.parse(raw) as unknown;
  const snapshot = await FileLoopState.fromPersisted(filePath, data).getSnapshot();
  return new Map(Object.entries(snapshot.results));
}

/**
 * Whether an unknown error is a "file not found" error.
 */
function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && 'code' in err && err.code === 'ENOENT'
  );
}

/**
 * Assert the runtime shape of a `loop-state` task config.
 */
function assertLoopStateTaskConfig(
  value: unknown,
): asserts value is LoopStateTask {
  if (!isRecord(value)) {
    throw new Error('loop-state task config must be an object');
  }
  assertKnownProperties(
    value,
    ['stateFile', 'promptTemplate', 'select'],
    'loop-state',
  );
  assertRequiredString(value, 'stateFile', 'loop-state.stateFile');
  assertRequiredString(value, 'promptTemplate', 'loop-state.promptTemplate');
  if (
    'select' in value &&
    value['select'] !== 'success' &&
    value['select'] !== 'error' &&
    value['select'] !== 'all'
  ) {
    throw new Error('loop-state.select must be one of success, error, all');
  }
}
```

- [ ] **Step 4: Register `loop-state` in `src/prompt-generators.ts`**

Add the import near the other generator imports (after the `json` imports):

```ts
import {
  LoopStatePromptGenerator,
  normalizeLoopStateTaskConfig,
} from './prompt-generators/loop-state.js';
```

Add it to `promptGeneratorCreators` (keep alphabetical-ish ordering, e.g. after the `json` entry):

```ts
  [LoopStatePromptGenerator.promptGeneratorName]:
    LoopStatePromptGenerator.create,
```

Add a normalize branch in `normalizePromptGeneratorSpec`, after the `json` branch:

```ts
  if (type === LoopStatePromptGenerator.promptGeneratorName) {
    return [type, normalizeLoopStateTaskConfig(config), configDir];
  }
```

- [ ] **Step 5: Assert the name is registered in `src/prompt-generators/__test__/prompt-generators.test.ts`**

Add a test inside the `describe('promptGeneratorTypes', ...)` block, mirroring the existing `per-file` assertion:

```ts
  it('includes loop-state', () => {
    expect(promptGeneratorTypes).toContain('loop-state');
  });
```

- [ ] **Step 6: Add the schema definition and tuple entry**

In `schema/loop-the-loop.schema.json`, add a `promptGeneratorSpec` tuple entry alongside the others (after the `json` entry, around line 382):

```json
        {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "additionalItems": false,
          "items": [
            { "const": "loop-state" },
            { "$ref": "#/definitions/loopStateTask" }
          ]
        },
```

Add the `loopStateTask` definition in `definitions` (next to `jsonTask`, around line 850):

```json
    "loopStateTask": {
      "type": "object",
      "required": ["stateFile", "promptTemplate"],
      "additionalProperties": false,
      "properties": {
        "stateFile": {
          "type": "string",
          "description": "Path to a strict v2 loop-state file. Config-relative, or a {{steps.<name>.state}} handoff substitution. A missing file is treated as empty input."
        },
        "promptTemplate": {
          "type": "string",
          "description": "Prompt template. Placeholders: {{id}}, {{status}}, and {{reason}} (error outcomes only). Supports {{include:path}} macros."
        },
        "select": {
          "type": "string",
          "enum": ["success", "error", "all"],
          "default": "success",
          "description": "Which terminal outcomes to yield. Defaults to success."
        }
      }
    },
```

- [ ] **Step 7: Add a positive schema case in `src/__test__/schema.test.ts`**

Add to the `positive cases` array:

```ts
      [
        'loop-state reader',
        {
          name: 'retry',
          agent: 'claude-sdk',
          promptGenerator: [
            'loop-state',
            {
              stateFile: 'prior-loop-state.json',
              select: 'error',
              promptTemplate: 'Retry {{id}}',
            },
          ],
        },
      ],
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `pnpm test src/prompt-generators/__test__/loop-state.test.ts src/prompt-generators/__test__/prompt-generators.test.ts src/__test__/schema.test.ts`
Expected: PASS - reader behaviour, name registration, and schema validation all green.

- [ ] **Step 9: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, `loop-state.ts` at 100% (success/error/all selects, missing-file, non-v2, malformed, isOutstanding skip, and every normalize branch covered).

- [ ] **Step 10: Commit**

```bash
git add src/prompt-generators/loop-state.ts src/prompt-generators/__test__/loop-state.test.ts src/prompt-generators.ts src/prompt-generators/__test__/prompt-generators.test.ts schema/loop-the-loop.schema.json src/__test__/schema.test.ts
git commit -m "Feature: Add loop-state reader prompt generator"
```

---

## Section 3: The `jsonl` reader

A generator that reads a `jsonl-report` line by line, with field-path equality filtering and the attempt knobs. The routing model in `conditional-routing-design.md` depends on these.

**Files:**

- Create: `src/prompt-generators/jsonl.ts`
- Modify: `src/prompt-generators.ts`, `schema/loop-the-loop.schema.json`, `src/__test__/schema.test.ts`, `src/prompt-generators/__test__/prompt-generators.test.ts`
- Test: `src/prompt-generators/__test__/jsonl.test.ts`

- [ ] **Step 1: Write the failing reader test**

Create `src/prompt-generators/__test__/jsonl.test.ts`:

```ts
// @module-tag local

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  JsonlPromptGenerator,
  normalizeJsonlTaskConfig,
  type JsonlTask,
} from 'loop-the-loop/prompt-generators/jsonl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('JsonlPromptGenerator', () => {
  let dir: string;
  const loopState = new FileLoopState('ignore.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeLines(
    name: string,
    lines: ReadonlyArray<unknown>,
  ): Promise<string> {
    const body = lines.map(l => JSON.stringify(l)).join('\n');
    await writeFile(join(dir, name), `${body}\n`);
    return name;
  }

  async function collect(
    task: JsonlTask,
    state: FileLoopState = loopState,
  ): Promise<Array<Prompt>> {
    const generator = await JsonlPromptGenerator.create(task, dir);
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(state)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  it('yields one prompt per line with id and index variables', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success', output: 'one' },
      { id: 'b', status: 'success', output: 'two' },
    ]);
    const prompts = await collect({
      dataFile,
      promptTemplate: '{{index}}:{{id}} {{output}}',
    });
    expect(prompts).toEqual([
      { id: 'a', prompt: '0:a one' },
      { id: 'b', prompt: '1:b two' },
    ]);
  });

  it('stringifies object-valued fields so they can be templated', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      promptTemplate: '{{id}} {{structuredOutput}}',
    });
    expect(prompts[0].prompt).toBe('a {"verdict":"rework"}');
  });

  it('uses a custom idField, falling back to the index when absent', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { key: 'k1', status: 'success' },
      { status: 'success' },
    ]);
    const prompts = await collect({
      dataFile,
      idField: 'key',
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['k1', '1']);
  });

  it('filters on a top-level field by equality', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success' },
      { id: 'b', status: 'error' },
      { id: 'c', status: 'success' },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { status: 'success' },
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a', 'c']);
  });

  it('filters on a structuredOutput field-path', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', structuredOutput: { verdict: 'rework' } },
      { id: 'b', structuredOutput: { verdict: 'approve' } },
      { id: 'c', structuredOutput: {} },
      { id: 'd' },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a']);
  });

  it('re-emits matching items at the next attempt id', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'bug-1', structuredOutput: { verdict: 'rework' } },
      { id: 'bug-2#3', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      maxAttempts: 4,
      incrementAttempt: true,
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['bug-1#2', 'bug-2#4']);
  });

  it('suppresses items at or above the attempt cap', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'bug-1#3', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      maxAttempts: 3,
      incrementAttempt: true,
      promptTemplate: '{{id}}',
    });
    expect(prompts).toEqual([]);
  });

  it('pulls only items at or above minAttempts for a giveup arm', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'bug-1', structuredOutput: { verdict: 'rework' } },
      { id: 'bug-2#3', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      minAttempts: 3,
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['bug-2#3']);
  });

  it('treats a missing data file as empty input', async () => {
    const prompts = await collect({
      dataFile: 'absent.jsonl',
      promptTemplate: '{{id}}',
    });
    expect(prompts).toEqual([]);
  });

  it('skips blank lines including a trailing newline', async () => {
    await writeFile(
      join(dir, 'r.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n\n`,
    );
    const prompts = await collect({
      dataFile: 'r.jsonl',
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a']);
  });

  it('throws with the line number on a malformed line', async () => {
    await writeFile(
      join(dir, 'r.jsonl'),
      `${JSON.stringify({ id: 'a' })}\nnot json\n`,
    );
    await expect(
      collect({ dataFile: 'r.jsonl', promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/malformed JSON on line 2/u);
  });

  it('throws when a line is valid JSON but not an object', async () => {
    await writeFile(join(dir, 'r.jsonl'), '42\n');
    await expect(
      collect({ dataFile: 'r.jsonl', promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/line 1 .* is not a JSON object/u);
  });

  it('throws a format-mismatch error for a yaml report', async () => {
    await writeFile(join(dir, 'r.yaml'), '- id: a\n');
    await expect(
      collect({ dataFile: 'r.yaml', promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/looks like a YAML report/u);
  });

  it('throws on a duplicate id', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a' },
      { id: 'a' },
    ]);
    await expect(
      collect({ dataFile, promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/duplicate id "a" at line 2/u);
  });

  it('skips ids that are no longer outstanding in the consuming loop', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success' },
      { id: 'b', status: 'success' },
    ]);
    const consuming = new FileLoopState('ignore.json');
    await consuming.complete('r', 'a', { status: 'success', output: '' });
    const prompts = await collect(
      { dataFile, promptTemplate: '{{id}}' },
      consuming,
    );
    expect(prompts.map(p => p.id)).toEqual(['b']);
  });
});

describe('normalizeJsonlTaskConfig', () => {
  it('accepts a full config', () => {
    const task = normalizeJsonlTaskConfig({
      dataFile: 'r.jsonl',
      promptTemplate: '{{id}}',
      idField: 'id',
      filter: { status: 'success', 'structuredOutput.verdict': 'rework' },
      maxAttempts: 3,
      minAttempts: 1,
      incrementAttempt: true,
    });
    expect(task.maxAttempts).toBe(3);
  });

  it('rejects a non-object', () => {
    expect(() => normalizeJsonlTaskConfig(7)).toThrow(
      'jsonl task config must be an object',
    );
  });

  it('rejects an unknown property', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        nope: 1,
      }),
    ).toThrow('jsonl.nope is not supported');
  });

  it('rejects a missing dataFile', () => {
    expect(() =>
      normalizeJsonlTaskConfig({ promptTemplate: '{{id}}' }),
    ).toThrow('jsonl.dataFile must be a string');
  });

  it('rejects a non-object filter', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        filter: 'x',
      }),
    ).toThrow('jsonl.filter must be an object of scalar values');
  });

  it('rejects a filter with a non-scalar value', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        filter: { k: { nested: true } },
      }),
    ).toThrow('jsonl.filter must be an object of scalar values');
  });

  it('rejects a non-integer maxAttempts', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        maxAttempts: 1.5,
      }),
    ).toThrow('jsonl.maxAttempts must be a positive integer');
  });

  it('rejects a non-boolean incrementAttempt', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        incrementAttempt: 'yes',
      }),
    ).toThrow('jsonl.incrementAttempt must be a boolean');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/prompt-generators/__test__/jsonl.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/prompt-generators/jsonl`.

- [ ] **Step 3: Implement `src/prompt-generators/jsonl.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import { resolveAttemptId } from './util/attempt.js';
import {
  assertKnownProperties,
  assertOptionalBoolean,
  assertOptionalString,
  assertRequiredString,
  isRecord,
} from './util/config.js';

/**
 * A scalar value accepted in a `filter` map. Equality matching is
 * string-coerced, so a number or boolean matches its stringified line value.
 */
export type FilterScalar = string | number | boolean;

/**
 * Configuration for the `jsonl` reader, which iterates a `jsonl-report` one
 * JSON object per line. Distinct from `json`, which does one whole-file
 * `JSON.parse`.
 */
export interface JsonlTask {
  /**
   * Path to the JSONL file, config-relative or a `{{steps.<name>.report}}`
   * handoff substitution. A missing file is treated as empty input.
   */
  dataFile: string;

  /**
   * Prompt template. Each line's top-level fields become `{{field}}`
   * placeholders (object-valued fields are JSON-stringified), plus `{{id}}`
   * (the emitted, possibly attempt-incremented id) and `{{index}}`. Supports
   * `{{include:path}}` macros.
   */
  promptTemplate: string;

  /**
   * Line field used as the prompt id. Defaults to `id`. Falls back to the
   * line index when the field is absent.
   */
  idField?: string;

  /**
   * Field-path equality filter, for example `{ "status": "success" }` or
   * `{ "structuredOutput.verdict": "rework" }`. Dotted paths navigate into
   * nested objects. Equality only.
   */
  filter?: Readonly<Record<string, FilterScalar>>;

  /**
   * Emit a line only while its parsed `#N` attempt is below this value.
   */
  maxAttempts?: number;

  /**
   * Emit a line only once its parsed `#N` attempt is at or above this value.
   */
  minAttempts?: number;

  /**
   * When true, re-emit the line at the next attempt id (`#(N+1)`).
   */
  incrementAttempt?: boolean;
}

/**
 * Normalize a `jsonl` task config loaded from JSON.
 */
export function normalizeJsonlTaskConfig(config: unknown): JsonlTask {
  assertJsonlTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that reads a `jsonl-report` line by line and yields a
 * prompt per matching line. It can only read line-delimited JSON; a `.yaml`
 * report fails with a clear format-mismatch message. A missing file is empty
 * input; a malformed line is an error naming the line number. Emitted ids are
 * gated through the consuming step's own `loopState.isOutstanding`.
 */
export class JsonlPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'jsonl';

  static async create(
    task: JsonlTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new JsonlPromptGenerator(task, basePath);
  }

  readonly #task: JsonlTask;
  readonly #basePath: string;

  constructor(task: JsonlTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const filePath = resolve(this.#basePath, this.#task.dataFile);
    const entries = await loadLines(filePath);
    const seenIds = new Map<string, number>();

    for (let index = 0; index < entries.length; index++) {
      const { lineNumber, line } = entries[index];

      if (this.#task.filter !== undefined && !matchesFilter(line, this.#task.filter)) {
        continue;
      }

      const rawId = resolveRawId(line, this.#task.idField, index);
      const id = resolveAttemptId(rawId, {
        maxAttempts: this.#task.maxAttempts,
        minAttempts: this.#task.minAttempts,
        incrementAttempt: this.#task.incrementAttempt,
      });
      if (id === null) {
        continue;
      }

      const previousLine = seenIds.get(id);
      if (previousLine !== undefined) {
        throw new Error(
          `JsonlTask: duplicate id "${id}" at line ${lineNumber} (already used at line ${previousLine})`,
        );
      }
      seenIds.set(id, lineNumber);

      if (loopState.isOutstanding(id)) {
        const variables = buildVariables(line, id, index);
        const prompt = await expandPrompt(
          this.#task.promptTemplate,
          this.#basePath,
          variables,
        );
        yield { id, prompt };
      }
    }
  }
}

interface JsonlLine {
  readonly lineNumber: number;
  readonly line: Record<string, unknown>;
}

/**
 * Read and parse the JSONL file into one record per non-blank line. A missing
 * file is empty input; a `.yaml`/`.yml` path is a clear format mismatch; a
 * line that is not a JSON object throws with its line number.
 */
async function loadLines(filePath: string): Promise<ReadonlyArray<JsonlLine>> {
  if (/\.ya?ml$/iu.test(filePath)) {
    throw new Error(
      `JsonlTask: ${filePath} looks like a YAML report; the jsonl reader needs a jsonl-report (one JSON object per line). Configure the upstream reporter as "jsonl-report".`,
    );
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const out: Array<JsonlLine> = [];
  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i].trim();
    if (text === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : /* istanbul ignore next */ String(err);
      throw new Error(
        `JsonlTask: malformed JSON on line ${i + 1} in ${filePath}: ${detail}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `JsonlTask: line ${i + 1} in ${filePath} is not a JSON object`,
      );
    }
    out.push({ lineNumber: i + 1, line: parsed });
  }
  return out;
}

/**
 * Resolve the raw id for a line: the `idField` value (default `id`) if
 * present, otherwise the line index as a string.
 */
function resolveRawId(
  line: Record<string, unknown>,
  idField: string | undefined,
  index: number,
): string {
  const field = idField ?? 'id';
  const value = line[field];
  if (value !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(value);
  }
  return String(index);
}

/**
 * Whether a line satisfies every field-path equality in the filter.
 */
function matchesFilter(
  line: Record<string, unknown>,
  filter: Readonly<Record<string, FilterScalar>>,
): boolean {
  for (const [path, expected] of Object.entries(filter)) {
    const actual = getPath(line, path);
    if (actual === undefined) {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    if (String(actual) !== String(expected)) {
      return false;
    }
  }
  return true;
}

/**
 * Walk a dot-notation path into a parsed line, returning `undefined` when any
 * intermediate value is missing or not a plain object.
 */
function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Build the template variables for a line. Each top-level field becomes a
 * variable (object-valued fields JSON-stringified), then `id` (the emitted
 * attempt id) and `index` are set last so they win over any same-named line
 * field.
 */
function buildVariables(
  line: Record<string, unknown>,
  id: string,
  index: number,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(line)) {
    variables[key] =
      value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : // eslint-disable-next-line @typescript-eslint/no-base-to-string
          String(value);
  }
  variables['id'] = id;
  variables['index'] = String(index);
  return variables;
}

/**
 * Whether an unknown error is a "file not found" error.
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/**
 * Assert the runtime shape of a `jsonl` task config.
 */
function assertJsonlTaskConfig(value: unknown): asserts value is JsonlTask {
  if (!isRecord(value)) {
    throw new Error('jsonl task config must be an object');
  }
  assertKnownProperties(
    value,
    [
      'dataFile',
      'promptTemplate',
      'idField',
      'filter',
      'maxAttempts',
      'minAttempts',
      'incrementAttempt',
    ],
    'jsonl',
  );
  assertRequiredString(value, 'dataFile', 'jsonl.dataFile');
  assertRequiredString(value, 'promptTemplate', 'jsonl.promptTemplate');
  assertOptionalString(value, 'idField', 'jsonl.idField');
  assertOptionalBoolean(value, 'incrementAttempt', 'jsonl.incrementAttempt');
  assertFilter(value);
  assertPositiveInteger(value, 'maxAttempts', 'jsonl.maxAttempts');
  assertPositiveInteger(value, 'minAttempts', 'jsonl.minAttempts');
}

/**
 * Assert that `filter`, if present, is an object whose values are scalars.
 */
function assertFilter(value: Record<string, unknown>): void {
  if (!('filter' in value)) {
    return;
  }
  const filter = value['filter'];
  if (!isRecord(filter) || Object.values(filter).some(v => !isScalar(v))) {
    throw new Error('jsonl.filter must be an object of scalar values');
  }
}

/**
 * Whether a value is a string, number, or boolean.
 */
function isScalar(value: unknown): value is FilterScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Assert that an optional property, if present, is a positive integer.
 */
function assertPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value)) {
    return;
  }
  const n = value[key];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}
```

- [ ] **Step 4: Register `jsonl` in `src/prompt-generators.ts`**

Add the import near the other generator imports:

```ts
import {
  JsonlPromptGenerator,
  normalizeJsonlTaskConfig,
} from './prompt-generators/jsonl.js';
```

Add it to `promptGeneratorCreators` (after the `json` entry):

```ts
  [JsonlPromptGenerator.promptGeneratorName]: JsonlPromptGenerator.create,
```

Add a normalize branch in `normalizePromptGeneratorSpec`, after the `json` branch:

```ts
  if (type === JsonlPromptGenerator.promptGeneratorName) {
    return [type, normalizeJsonlTaskConfig(config), configDir];
  }
```

- [ ] **Step 5: Assert the name is registered in `src/prompt-generators/__test__/prompt-generators.test.ts`**

Add a test inside the `describe('promptGeneratorTypes', ...)` block:

```ts
  it('includes jsonl', () => {
    expect(promptGeneratorTypes).toContain('jsonl');
  });
```

- [ ] **Step 6: Add the schema definition and tuple entry**

In `schema/loop-the-loop.schema.json`, add a `promptGeneratorSpec` tuple entry (after the `json` entry):

```json
        {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "additionalItems": false,
          "items": [{ "const": "jsonl" }, { "$ref": "#/definitions/jsonlTask" }]
        },
```

Add the `jsonlTask` definition in `definitions` (next to `jsonTask`):

```json
    "jsonlTask": {
      "type": "object",
      "required": ["dataFile", "promptTemplate"],
      "additionalProperties": false,
      "properties": {
        "dataFile": {
          "type": "string",
          "description": "Path to a JSONL report file (one JSON object per line). Config-relative, or a {{steps.<name>.report}} handoff substitution. A missing file is treated as empty input."
        },
        "promptTemplate": {
          "type": "string",
          "description": "Prompt template. Each line field becomes {{field}} (objects JSON-stringified), plus {{id}} and {{index}}. Supports {{include:path}} macros."
        },
        "idField": {
          "type": "string",
          "description": "Line field used as the prompt id. Defaults to id; falls back to the line index when absent."
        },
        "filter": {
          "type": "object",
          "additionalProperties": { "type": ["string", "number", "boolean"] },
          "description": "Field-path equality filter, e.g. { \"structuredOutput.verdict\": \"rework\" }. Dotted paths navigate nested objects. Equality only."
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "description": "Emit a line only while its parsed #N attempt is below this value."
        },
        "minAttempts": {
          "type": "integer",
          "minimum": 1,
          "description": "Emit a line only once its parsed #N attempt is at or above this value."
        },
        "incrementAttempt": {
          "type": "boolean",
          "default": false,
          "description": "Re-emit the line at the next attempt id (#(N+1))."
        }
      }
    },
```

- [ ] **Step 7: Add a positive schema case in `src/__test__/schema.test.ts`**

Add to the `positive cases` array:

```ts
      [
        'jsonl reader with filter and attempt knobs',
        {
          name: 'rework',
          agent: 'claude-sdk',
          promptGenerator: [
            'jsonl',
            {
              dataFile: 'verify-report.jsonl',
              filter: { 'structuredOutput.verdict': 'rework' },
              maxAttempts: 3,
              incrementAttempt: true,
              promptTemplate: 'Rework {{id}}',
            },
          ],
        },
      ],
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `pnpm test src/prompt-generators/__test__/jsonl.test.ts src/prompt-generators/__test__/prompt-generators.test.ts src/__test__/schema.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, `jsonl.ts` at 100% (filter present/absent, structuredOutput path miss, attempt gates and increment, missing file, blank line, malformed line, non-object line, yaml mismatch, duplicate id, isOutstanding skip, and every normalize/assert branch covered).

- [ ] **Step 10: Commit**

```bash
git add src/prompt-generators/jsonl.ts src/prompt-generators/__test__/jsonl.test.ts src/prompt-generators.ts src/prompt-generators/__test__/prompt-generators.test.ts schema/loop-the-loop.schema.json src/__test__/schema.test.ts
git commit -m "Feature: Add jsonl reader prompt generator"
```

---

## Section 4: Handoff substitution

Resolve `{{steps.<name>.report}}` and `{{steps.<name>.state}}` in reader config fields to absolute paths under the consuming config's `outputDir`, so renaming a step or pipeline updates its consumers instead of breaking a hard-coded filename.

**Files:**

- Create: `src/prompt-generators/util/handoff.ts`, `src/prompt-generators/util/__test__/handoff.test.ts`
- Modify: `src/prompt-generators/util/config.ts`, `src/prompt-generators.ts`, `src/util/load-cli-config.ts`
- Test: `src/util/__test__/load-cli-config.test.ts`

- [ ] **Step 1: Write the failing handoff-util test**

Create `src/prompt-generators/util/__test__/handoff.test.ts`:

```ts
// @module-tag local

import { resolve } from 'node:path';

import { resolveStepHandoff } from 'loop-the-loop/prompt-generators/util/handoff';
import { describe, expect, it } from 'vitest';

describe('resolveStepHandoff', () => {
  const outputDir = '/out';

  it('resolves a report handoff to a jsonl file under outputDir', () => {
    expect(resolveStepHandoff('{{steps.review.report}}', outputDir)).toBe(
      resolve(outputDir, 'review-report.jsonl'),
    );
  });

  it('resolves a state handoff to a loop-state file under outputDir', () => {
    expect(resolveStepHandoff('{{steps.fix.state}}', outputDir)).toBe(
      resolve(outputDir, 'fix-loop-state.json'),
    );
  });

  it('leaves a plain path unchanged', () => {
    expect(resolveStepHandoff('data/report.jsonl', outputDir)).toBe(
      'data/report.jsonl',
    );
  });

  it('supports step names with dashes and underscores', () => {
    expect(
      resolveStepHandoff('{{steps.fix_bug-2.report}}', outputDir),
    ).toBe(resolve(outputDir, 'fix_bug-2-report.jsonl'));
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test src/prompt-generators/util/__test__/handoff.test.ts`
Expected: FAIL - cannot resolve `loop-the-loop/prompt-generators/util/handoff`.

- [ ] **Step 3: Implement `src/prompt-generators/util/handoff.ts`**

```ts
import { resolve } from 'node:path';

const REPORT_HANDOFF = /\{\{steps\.([A-Za-z0-9_-]+)\.report\}\}/gu;
const STATE_HANDOFF = /\{\{steps\.([A-Za-z0-9_-]+)\.state\}\}/gu;

/**
 * Resolve `{{steps.<name>.report}}` and `{{steps.<name>.state}}` handoff
 * markers in a config path to the named step's actual local artifacts under
 * `outputDir`: `<name>-report.jsonl` for the report and
 * `<name>-loop-state.json` for the state. A path with no marker is returned
 * unchanged. This removes hard-coded filenames so renaming a step updates its
 * consumers instead of silently breaking the wiring.
 */
export function resolveStepHandoff(value: string, outputDir: string): string {
  return value
    .replace(REPORT_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${name}-report.jsonl`),
    )
    .replace(STATE_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${name}-loop-state.json`),
    );
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm test src/prompt-generators/util/__test__/handoff.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `outputDir` to the normalization context**

In `src/prompt-generators/util/config.ts`, extend `PromptGeneratorConfigContext`:

```ts
export interface PromptGeneratorConfigContext {
  /**
   * Directory containing the config file.
   */
  readonly configDir: string;

  /**
   * Directory the loop writes its report and state into. Used to resolve
   * `{{steps.<name>.report|state}}` handoff substitutions in reader configs.
   */
  readonly outputDir: string;
}
```

- [ ] **Step 6: Resolve handoff in the reader normalize branches**

In `src/prompt-generators.ts`, add the import:

```ts
import { resolveStepHandoff } from './prompt-generators/util/handoff.js';
```

Destructure `outputDir` alongside `configDir` in `normalizePromptGeneratorSpec`:

```ts
  const { configDir, outputDir } = context;
```

Replace the `loop-state` normalize branch with a handoff-resolving version:

```ts
  if (type === LoopStatePromptGenerator.promptGeneratorName) {
    const task = normalizeLoopStateTaskConfig(config);
    return [
      type,
      { ...task, stateFile: resolveStepHandoff(task.stateFile, outputDir) },
      configDir,
    ];
  }
```

Replace the `jsonl` normalize branch with a handoff-resolving version:

```ts
  if (type === JsonlPromptGenerator.promptGeneratorName) {
    const task = normalizeJsonlTaskConfig(config);
    return [
      type,
      { ...task, dataFile: resolveStepHandoff(task.dataFile, outputDir) },
      configDir,
    ];
  }
```

- [ ] **Step 7: Pass `outputDir` into the context from `src/util/load-cli-config.ts`**

In `normalizeCliConfig`, the `outputDir` const is already computed. Add it to the context object passed to `normalizePromptGeneratorSpec`:

```ts
    promptGenerator: normalizePromptGeneratorSpec(config.promptGenerator, {
      configDir,
      outputDir,
    }),
```

- [ ] **Step 8: Write the failing handoff integration test**

Add to `src/util/__test__/load-cli-config.test.ts`, inside the `describe('loadCliConfig', ...)` block (near the other merge tests). This test loads a config whose reader uses a handoff and asserts the normalized spec resolved it to an absolute path under `outputDir`:

```ts
  it('resolves {{steps.*}} handoff substitutions to outputDir artifacts', async () => {
    const configDir = join(tempDir, 'handoff');
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        name: 'consumer',
        agent: 'claude-sdk',
        promptGenerator: [
          'jsonl',
          {
            dataFile: '{{steps.review.report}}',
            promptTemplate: 'Fix {{id}}',
          },
        ],
      })}\n`,
    );

    const config = await loadCliConfig({ configPath });
    const spec = config.promptGenerator as [string, { dataFile: string }];
    expect(spec[0]).toBe('jsonl');
    expect(spec[1].dataFile).toBe(join(configDir, 'review-report.jsonl'));
  });
```

If `join` or `mkdir`/`writeFile`/`tempDir` are not already imported/declared in this file, reuse the existing imports and `tempDir` fixture (the file already uses them for the other merge tests; do not add duplicates).

- [ ] **Step 9: Run the tests and verify they pass**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts src/prompt-generators/util/__test__/handoff.test.ts`
Expected: PASS - the loaded jsonl `dataFile` resolves to `<configDir>/review-report.jsonl` (outputDir defaults to configDir when unset).

- [ ] **Step 10: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green, `handoff.ts` at 100%, the new branches in `prompt-generators.ts` covered (handoff-present via the integration test, handoff-absent via the existing reader/CLI tests).

- [ ] **Step 11: Commit**

```bash
git add src/prompt-generators/util/handoff.ts src/prompt-generators/util/__test__/handoff.test.ts src/prompt-generators/util/config.ts src/prompt-generators.ts src/util/load-cli-config.ts src/util/__test__/load-cli-config.test.ts
git commit -m "Feature: Resolve {{steps.*}} local handoff substitutions in reader configs"
```

---

## Section 5: Examples and documentation

Add example configs that exercise the readers (validated automatically by `src/__test__/schema.test.ts`) and a README section so the feature is discoverable.

**Files:**

- Create: `src/examples/reader-generators/jsonl-rework.json`, `src/examples/reader-generators/loop-state-retry.json`, `src/examples/reader-generators/README.md`
- Modify: `README.md`

- [ ] **Step 1: Create `src/examples/reader-generators/jsonl-rework.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/joewalker/loop-the-loop/refs/heads/main/schema/loop-the-loop.schema.json",
  "name": "fix",
  "agent": "claude-sdk",
  "reporter": "jsonl-report",
  "promptGenerator": [
    "jsonl",
    {
      "dataFile": "{{steps.verify.report}}",
      "filter": { "structuredOutput.verdict": "rework" },
      "maxAttempts": 3,
      "incrementAttempt": true,
      "promptTemplate": "The verifier rejected the fix for {{id}}. Feedback: {{output}}. Produce an improved fix."
    }
  ]
}
```

- [ ] **Step 2: Create `src/examples/reader-generators/loop-state-retry.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/joewalker/loop-the-loop/refs/heads/main/schema/loop-the-loop.schema.json",
  "name": "retry-errors",
  "agent": "claude-sdk",
  "promptGenerator": [
    "loop-state",
    {
      "stateFile": "{{steps.fix.state}}",
      "select": "error",
      "promptTemplate": "A previous run recorded an error for {{id}}: {{reason}}. Try again."
    }
  ]
}
```

- [ ] **Step 3: Create `src/examples/reader-generators/README.md`**

```markdown
# reader-generators examples

Two readers that let one loop consume another loop's local output.

`jsonl-rework.json` reads a verify step's `jsonl-report`, pulls only the lines whose `structuredOutput.verdict` is `rework`, and re-emits each at the next attempt id (`bug-1` becomes `bug-1#2`). `maxAttempts` bounds the rework loop, so an item that still fails after three attempts is left for a giveup arm rather than cycling forever. Verdict routing requires `jsonl-report`, so the reporter is set explicitly.

`loop-state-retry.json` reads a prior step's strict v2 state file and pulls only the ids whose recorded outcome was an error, so a follow-up loop can retry just the failures. The `loop-state` reader carries `status` and `reason` but not the agent output or a verdict; use the `jsonl` reader when the upstream text or a structured verdict is needed.

Both `dataFile` and `stateFile` use a `{{steps.<name>.report|state}}` handoff substitution, which resolves to the named step's artifacts under `outputDir`. Renaming a step updates its consumers instead of breaking a hard-coded filename. A missing upstream file is treated as empty input, so a consumer is safe to run before its producer has emitted anything.
```

- [ ] **Step 4: Add the README section**

Add a "Reader generators and local handoff" section to `README.md`, immediately after the "Concurrency" section. Prose only, one line per paragraph, no bold (per AGENTS.md):

```markdown
## Reader generators and local handoff

Two prompt generators let one loop consume another loop's local output. The `jsonl` generator reads a `jsonl-report` one JSON object per line; each line's fields become `{{field}}` placeholders (object-valued fields are JSON-stringified) alongside `{{id}}` and `{{index}}`. The `loop-state` generator reads the strict v2 state file and yields `{{id}}`, `{{status}}`, and `{{reason}}` per recorded outcome, with a `select` of `success` (the default), `error`, or `all`. A missing upstream file is treated as empty input, so a consumer can run before its producer; a present-but-malformed file is an error, and a `jsonl` reader pointed at a `.yaml` report fails with a clear format-mismatch message.

The `jsonl` reader can filter lines by field-path equality, including dotted paths into `structuredOutput`, for example `{ "structuredOutput.verdict": "rework" }`. It also understands attempt-scoped ids: `maxAttempts` emits a line only while its `#N` attempt is below the cap, `minAttempts` emits only once it has reached the cap, and `incrementAttempt` re-emits the line at the next attempt (`bug-1` becomes `bug-1#2`). Together these are the primitive that bounded rework loops are built from.

Config fields like `dataFile` and `stateFile` accept `{{steps.<name>.report}}` and `{{steps.<name>.state}}`, which resolve to the named step's `<name>-report.jsonl` and `<name>-loop-state.json` under `outputDir`. This keeps handoff wiring correct when `outputDir`, a pipeline, or a step name changes, instead of relying on hard-coded filenames. Each reader gates every emitted id through the consuming loop's own state, so the consuming loop is itself resumable; its state file is a different file from the upstream artifact it reads as data.
```

- [ ] **Step 5: Run the completion gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all green; the schema test validates both new example configs automatically; coverage stays at 100%.

- [ ] **Step 6: Commit**

```bash
git add src/examples/reader-generators README.md
git commit -m "Docs: Add reader-generator examples and README section"
```

---

## Self-review checklist (run after all sections)

1. Spec coverage against `step-05-reader-generators-local-handoff.md` "Work" and "Done when":
   - `jsonl` reader reading JSONL line by line, distinct from `json` - Section 3.
   - `loop-state` reader of the strict v2 snapshot - Section 2.
   - Filter by status; success/error/all selection - `jsonl.filter` (Section 3) and `loop-state.select` (Section 2).
   - Field-path filter keys including `structuredOutput.*`, equality only - Section 3.
   - `maxAttempts` / `minAttempts` / `incrementAttempt` and `id#N` re-emission - Section 1 helper + Section 3 wiring.
   - Ids gated through the consuming step's `isOutstanding` - both readers (Sections 2 and 3).
   - `{{steps.<name>.report|state}}` handoff substitution for `dataFile` / `stateFile` - Section 4.
   - Missing local file as empty input; malformed present file an error - both readers.
   - `jsonl` against a `yaml-report` fails with a clear format-mismatch message - Section 3.
   - Readers useful in ordinary non-pipeline configs - examples in Section 5; tests construct plain configs.
   - Schema `jsonlTask` and `loopStateTask` plus validated examples - Sections 2, 3, 5.
2. Type consistency: `JsonlTask` / `LoopStateTask` field names match their asserts, schema properties, and test usages; `resolveAttemptId` / `resolveStepHandoff` signatures match their call sites; `PromptGeneratorConfigContext` carries both `configDir` and `outputDir` and every construction site passes both.
3. Final full gate: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format` clean with coverage at 100%.

## Out of scope (do not implement)

Per the step doc and `conditional-routing-design.md`: the pipeline orchestrator, the fixed-point pass loop, `maxPasses`, and the `output` terminal step (all Step 06); storing `structuredOutput` in loop-state (deferred until a dashboard); predicate operators in filters (ranges, negation, boolean composition); a central route table or flow visualisation. Handoff substitution is not applied to the `json` generator and the new readers do not implement the optional `check()` doctor probe.
```