# Step 02 `--doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan workstream-by-workstream. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--doctor` preflight command that validates the configured agent, prompt generator, reporter, output directory, resumable state file, and git prerequisites, exiting 0 when everything passes and 1 when any check fails, without ever invoking the main loop.

**Architecture:** A new `src/doctor.ts` defines a `CheckResult` type, a `doctor()` orchestrator, a text formatter, and cross-cutting environment checks. The three core interfaces (`Agent`, `PromptGenerator`, `Reporter`) each gain an optional `check(): AsyncIterable<CheckResult>` capability. The orchestrator constructs the configured components, streams each component's results (yielding a single `skip` for components without a `check()`, and a synthetic `fail` for any probe that throws or any component that fails to construct), prints a summary, and returns `false` iff any `fail` was observed. The git working-tree preflight currently inline in `loopImpl` is extracted into a shared `gitPreflight()` helper so the loop and the doctor stay in lockstep.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers in runtime files, absolute extensionless imports in tests), Vitest with module-tag gating (`local` default, `live` for network probes), Node `node:fs/promises` (`access`, `mkdir`), the existing `Git` wrapper over `child_process`, and the project's `glob`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, and `@joewalker/bzjs` dependencies.

---

## Decisions locked in before coding

- **Branch:** All Step 2 work is committed directly to `main`. No feature branches, no PRs, no worktrees. The user reviews when the whole step is complete.
- **`CheckResult` lives in `src/doctor.ts`.** The three interface files import it type-only (`import type { CheckResult } from './doctor.js'`) so there is no runtime import cycle (`doctor.ts` imports the factories at runtime; the interface files only import the type).
- **`doctor()` prints as it goes** (streaming requirement). It takes an injected `write` function (default writes to `process.stdout`) so tests collect lines without spying on `console`.
- **The `query()`/network probes run for real** inside `check()` (the doctor hits real components by design). Local unit tests mock the SDK / `fetch` / `spawn`; `*-live.test.ts` files exercise the real call gated on env tokens.
- **Output line format:** `[<status>] <component-kind> (<component-name>): <check-name>[ - <message>]`, status tag `padEnd(6)` then a single space, so columns line up. A trailing summary line counts `ok` / `warn` / `fail` / `skip`.
- **Schema:** `--doctor` adds no JSON config key, so `schema/loop-the-loop.schema.json` and `src/examples/` are untouched. README and `USAGE` still gain a mention.

## File map

Create:
- `src/doctor.ts` — `CheckResult`, `doctor()`, the formatter, environment checks.
- `src/git-preflight.ts` — `GitPreflightItem`, `gitPreflight(git)`, shared by loop and doctor.
- `src/__test__/doctor.test.ts` — orchestration tests with fakes.
- `src/__test__/git-preflight.test.ts` — preflight helper tests.
- `src/agents/__test__/claude-sdk-check-live.test.ts` (and reuse existing live files where present) — live agent probe.
- Live test files for `github` / `gitlab` / `bugzilla` / `codex` `check()` where not already present.

Modify:
- `src/agents.ts`, `src/prompt-generators.ts`, `src/reporters.ts` — add optional `check?(): AsyncIterable<CheckResult>` to the interfaces.
- `src/util/git.ts` — add `isInsideWorkTree()` and `configValue(key)`.
- `src/loop.ts` — replace the inline clean-tree check with `gitPreflight()`.
- `src/util/load-cli-config.ts` — parse `--doctor`, ignore `--dry-run` when `--doctor` is set, extend `USAGE`.
- `src/cli.ts` — dispatch to `doctor()` on `--doctor`.
- Each agent (`claude-sdk`, `openai-sdk`, `codex-cli`, `test`), generator (`batch`, `bugzilla`, `github`, `gitlab`, `json`, `per-file`, `test`), and reporter (`yaml`, `jsonl`) implementation file plus its `__test__` unit test.
- `README.md` — document `--doctor`.

## Dependency graph and commit cadence

```
W0  Merge step-01 to main, confirm clean baseline        (merge commit only)
        |
W1  Refactor: shared gitPreflight() helper               (commit)
        |
W2  Feature: doctor core (interfaces + doctor.ts + env)   (commit)
        |
  +-----+-----------+-----------+
  |     |           |           |
 W3    W4          W5          W6      <-- independent, dispatch in parallel
 CLI   agents      generators  reporters
(commit)(commit)   (commit)    (commit)
        |
W7  Final gate + README + coverage sweep                  (commit)
```

W1 must land before W2 (the environment git check calls `gitPreflight`). W2 must land before W3-W6 (they all depend on the `check?` interface members and, for W3, on `doctor()` existing). W4, W5, W6, and W3 touch disjoint directories and are safe to implement in parallel sub-agents; commit each workstream as a separate commit on `main` after its own slice is green, one at a time, so the index stays clean.

---

## Workstream 0: Confirm baseline

**Files:** none

- [ ] **Step 1: Verify the baseline is green on main before any Step 2 code**

Run: `pnpm tsc && pnpm test --coverage`
Expected: types clean, all tests pass, coverage 100%.

Run: `pnpm lint`
Expected: no errors.

No commit in this workstream beyond the merge itself.

---

## Workstream 1: Shared git preflight helper

**Files:**
- Create: `src/git-preflight.ts`
- Create test: `src/__test__/git-preflight.test.ts`
- Modify: `src/util/git.ts` (add `isInsideWorkTree`, `configValue`)
- Modify: `src/loop.ts:88-94` (use the helper)

### Task 1.1: Add probe methods to `Git`

- [ ] **Step 1: Write failing tests for the new `Git` methods**

Add to a new or existing git test (the project keeps git tests under `src/util/__test__/git.test.ts` — confirm with `pnpm test src/util/__test__/git.test.ts` and follow that file's mocking style for `child_process`). Tests:

```ts
// @module-tag local
// isInsideWorkTree returns true when `git rev-parse --is-inside-work-tree` prints "true"
// isInsideWorkTree returns false when the exec rejects (not a work tree)
// configValue('user.name') returns the trimmed value on success
// configValue returns undefined when `git config --get` rejects (unset key)
// configValue returns undefined when the value is empty/whitespace
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/util/__test__/git.test.ts`
Expected: FAIL (methods do not exist).

- [ ] **Step 3: Implement the methods in `src/util/git.ts`**

Add inside the `Git` class (after `isClean()`):

```ts
/**
 * 'git rev-parse --is-inside-work-tree'
 *
 * Returns true only when the repo path is inside a git work tree. A
 * non-zero exit (no repository) is reported as false rather than thrown.
 */
async isInsideWorkTree(): Promise<boolean> {
  try {
    const out = await exec('git', [
      '-C',
      this.#repoPath,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 'git config --get <key>'
 *
 * Returns the trimmed config value, or undefined when the key is unset
 * (git exits non-zero) or resolves to an empty string.
 */
async configValue(key: string): Promise<string | undefined> {
  try {
    const out = await exec('git', ['-C', this.#repoPath, 'config', '--get', key]);
    const value = out.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/util/__test__/git.test.ts`
Expected: PASS.

### Task 1.2: Create `gitPreflight()` and wire it into the loop

- [ ] **Step 1: Write failing tests in `src/__test__/git-preflight.test.ts`**

```ts
// @module-tag local

import { gitPreflight } from 'loop-the-loop/git-preflight';
import { describe, expect, it } from 'vitest';

function fakeGit(overrides: Partial<Record<string, unknown>>): any {
  return {
    isInsideWorkTree: async () => true,
    isClean: async () => true,
    configValue: async (key: string) =>
      key === 'user.name' ? 'Ada' : 'ada@example.com',
    ...overrides,
  };
}

describe('gitPreflight', () => {
  it('returns three ok items when inside a clean tree with identity', async () => {
    const items = await gitPreflight(fakeGit({}));
    expect(items.map(i => i.ok)).toEqual([true, true, true]);
  });

  it('stops after the work-tree item when not inside a work tree', async () => {
    const items = await gitPreflight(fakeGit({ isInsideWorkTree: async () => false }));
    expect(items).toHaveLength(1);
    expect(items[0].ok).toBe(false);
  });

  it('flags a dirty tree with the loop-compatible message', async () => {
    const items = await gitPreflight(fakeGit({ isClean: async () => false }));
    const clean = items.find(i => i.name === 'clean working tree');
    expect(clean?.ok).toBe(false);
    expect(clean?.message).toBe(
      'Working directory is not clean. Commit or stash changes before starting.',
    );
  });

  it('flags missing committer identity', async () => {
    const items = await gitPreflight(fakeGit({ configValue: async () => undefined }));
    const ident = items.find(i => i.name === 'committer identity');
    expect(ident?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/__test__/git-preflight.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/git-preflight.ts`**

```ts
import type { Git } from './util/git.js';

/**
 * One probe in the git preflight. `ok` is false when the requirement is not
 * met; `message` carries the human-readable reason (used both as the loop's
 * thrown error and the doctor's check message).
 */
export interface GitPreflightItem {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * Shared git preflight used by both the loop runner and `--doctor`.
 *
 * Probes, in order: inside a work tree, clean working tree, committer
 * identity configured. The work-tree probe short-circuits the rest because
 * the later probes are meaningless outside a repository. Keeping this in one
 * place ensures the loop and the doctor agree on what counts as ready.
 */
export async function gitPreflight(git: Git): Promise<ReadonlyArray<GitPreflightItem>> {
  const items: Array<GitPreflightItem> = [];

  const insideWorkTree = await git.isInsideWorkTree();
  items.push({
    name: 'inside work tree',
    ok: insideWorkTree,
    message: insideWorkTree
      ? undefined
      : 'Not inside a git work tree. Run from a repository when allowSourceUpdate is set.',
  });
  if (!insideWorkTree) {
    return items;
  }

  const clean = await git.isClean();
  items.push({
    name: 'clean working tree',
    ok: clean,
    message: clean
      ? undefined
      : 'Working directory is not clean. Commit or stash changes before starting.',
  });

  const name = await git.configValue('user.name');
  const email = await git.configValue('user.email');
  const hasIdentity = name !== undefined && email !== undefined;
  items.push({
    name: 'committer identity',
    ok: hasIdentity,
    message: hasIdentity
      ? `${name} <${email}>`
      : 'git user.name / user.email are not configured for commits.',
  });

  return items;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/__test__/git-preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `loopImpl` to use the shared helper**

In `src/loop.ts`, replace lines 88-94:

```ts
const git = allowSourceUpdate ? new Git(process.cwd()) : undefined;

if (git && !(await git.isClean())) {
  throw new Error(
    'Working directory is not clean. Commit or stash changes before starting.',
  );
}
```

with:

```ts
const git = allowSourceUpdate ? new Git(process.cwd()) : undefined;

if (git) {
  const failed = (await gitPreflight(git)).find(item => !item.ok);
  if (failed) {
    throw new Error(
      failed.message ?? /* istanbul ignore next */ `Git preflight failed: ${failed.name}`,
    );
  }
}
```

Add the import near the other loop imports:

```ts
import { gitPreflight } from './git-preflight.js';
```

- [ ] **Step 6: Reconcile existing loop tests**

The dirty-tree path now flows through `gitPreflight`. Its thrown message for a dirty tree is byte-for-byte identical, so dirty-tree assertions still pass. The loop now ALSO requires an in-work-tree repo with a committer identity when `allowSourceUpdate` is true; this is satisfied in CI and local checkouts. Run the loop suite and fix any test that stubbed `Git` with only `isClean`:

Run: `pnpm test src/__test__/loop.test.ts`
Expected: PASS. If a `Git` stub is missing `isInsideWorkTree`/`configValue`, extend the stub to return `true` / valid identity so existing scenarios keep their intent.

- [ ] **Step 7: Full gate for the workstream**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all clean, coverage 100%, no format diff.

- [ ] **Step 8: Commit**

```bash
git add src/git-preflight.ts src/__test__/git-preflight.test.ts src/util/git.ts src/util/__test__/git.test.ts src/loop.ts src/__test__/loop.test.ts
git commit -m "Refactor: Extract a shared gitPreflight helper for loop and doctor"
```

---

## Workstream 2: Doctor core (interfaces, orchestrator, environment checks)

**Files:**
- Create: `src/doctor.ts`
- Create test: `src/__test__/doctor.test.ts`
- Modify: `src/agents.ts`, `src/prompt-generators.ts`, `src/reporters.ts` (add optional `check?`)

### Task 2.1: Add the optional `check?` capability to the three interfaces

- [ ] **Step 1: Add `check?` to `Agent` (`src/agents.ts`)**

At the top of the file, add a type-only import:

```ts
import type { CheckResult } from './doctor.js';
```

Extend the `Agent` interface (after `invoke`):

```ts
export interface Agent {
  invoke: (prompt: string, options: InvokeOptions) => Promise<InvokeResult>;

  /**
   * Optional preflight probe used by `--doctor`. Yields results one at a
   * time so a slow probe does not block earlier fast probes from printing.
   * Optional so external and test implementations stay valid.
   */
  check?(): AsyncIterable<CheckResult>;
}
```

- [ ] **Step 2: Add `check?` to `PromptGenerator` (`src/prompt-generators.ts`)**

Add the type-only import `import type { CheckResult } from './doctor.js';` and extend the interface:

```ts
export interface PromptGenerator {
  generate(loopState: LoopState): AsyncIterable<Prompt>;

  /**
   * Optional preflight probe used by `--doctor` (see Agent.check).
   */
  check?(): AsyncIterable<CheckResult>;
}
```

- [ ] **Step 3: Add `check?` to `Reporter` (`src/reporters.ts`)**

Add the type-only import and extend the interface:

```ts
export interface Reporter {
  append(prompt: Prompt, result: InvokeResult): Promise<void>;

  /**
   * Optional preflight probe used by `--doctor` (see Agent.check).
   */
  check?(): AsyncIterable<CheckResult>;
}
```

- [ ] **Step 4: Confirm types still compile** (doctor.ts not yet created — the type-only import will fail until Task 2.2 lands, so do Task 2.2 in the same edit batch before running `pnpm tsc`).

### Task 2.2: Implement `src/doctor.ts`

- [ ] **Step 1: Write the orchestrator tests first (`src/__test__/doctor.test.ts`)**

```ts
// @module-tag local

import { doctor } from 'loop-the-loop/doctor';
import { createLogger } from 'loop-the-loop/loggers';
import type { Agent } from 'loop-the-loop/agents';
import type { LoopCliConfig } from 'loop-the-loop/types';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const okAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
  async *check() {
    yield { name: 'all good', status: 'ok' };
  },
};

const throwingAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
  // eslint-disable-next-line require-yield
  async *check() {
    throw new Error('boom');
  },
};

const noCheckAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
};

async function baseConfig(overrides: Partial<LoopCliConfig>): Promise<LoopCliConfig> {
  const outputDir = await mkdtemp(join(tmpdir(), 'doctor-'));
  return {
    name: 'job',
    outputDir,
    agent: noCheckAgent,
    promptGenerator: { generate: async function* () {} },
    reporter: { append: async () => {} },
    ...overrides,
  } as LoopCliConfig;
}

function collect() {
  const lines: Array<string> = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('doctor', () => {
  it('returns true and prints an ok line for a passing check', async () => {
    const { lines, write } = collect();
    const ok = await doctor(await baseConfig({ agent: okAgent }), createLogger(undefined), write);
    expect(ok).toBe(true);
    expect(lines.some(l => l.includes('agent (custom): all good'))).toBe(true);
  });

  it('yields a synthetic fail (return false) when check() throws', async () => {
    const { lines, write } = collect();
    const ok = await doctor(await baseConfig({ agent: throwingAgent }), createLogger(undefined), write);
    expect(ok).toBe(false);
    expect(lines.some(l => l.startsWith('[fail]') && l.includes('boom'))).toBe(true);
  });

  it('yields exactly one skip for a component without check()', async () => {
    const { lines, write } = collect();
    await doctor(await baseConfig({ agent: noCheckAgent }), createLogger(undefined), write);
    const skips = lines.filter(l => l.includes('agent (custom)') && l.startsWith('[skip]'));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('no diagnostics defined');
  });

  it('runs the other components when one fails to construct', async () => {
    const { lines, write } = collect();
    const ok = await doctor(
      await baseConfig({ agent: 'no-such-agent' as never, reporter: { append: async () => {} } }),
      createLogger(undefined),
      write,
    );
    expect(ok).toBe(false);
    // reporter and environment still produced lines
    expect(lines.some(l => l.includes('reporter'))).toBe(true);
    expect(lines.some(l => l.includes('environment'))).toBe(true);
  });

  it('reports the environment output-directory and state checks', async () => {
    const { lines, write } = collect();
    await doctor(await baseConfig({}), createLogger(undefined), write);
    expect(lines.some(l => l.includes('environment') && l.includes('output directory writable'))).toBe(true);
    expect(lines.some(l => l.includes('resumable state'))).toBe(true);
  });

  it('prints a trailing summary counting statuses', async () => {
    const { lines, write } = collect();
    await doctor(await baseConfig({ agent: okAgent }), createLogger(undefined), write);
    expect(lines.at(-1)).toMatch(/^Summary: \d+ ok, \d+ warn, \d+ fail, \d+ skip$/u);
  });
});
```

Add focused tests for the environment helpers as needed to hit 100% (malformed state file -> `fail`; absent state file -> `skip`; git check appears only when `allowSourceUpdate` is true). For the malformed-state case, write a non-v2 JSON file at `${outputDir}/${name}-loop-state.json` before calling `doctor`. For the git-on case, set `allowSourceUpdate: true` and assert an `environment (...): inside work tree` line appears.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/__test__/doctor.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/doctor.ts`**

```ts
import { access, constants, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { createAgent, type AgentSpec } from './agents.js';
import { gitPreflight } from './git-preflight.js';
import type { Logger } from './loggers.js';
import { FileLoopState } from './loop-states/file.js';
import { createPromptGenerator, type PromptGeneratorSpec } from './prompt-generators.js';
import { createReporter, DEFAULT_REPORTER, type ReporterSpec } from './reporters.js';
import type { LoopCliConfig } from './types.js';
import { Git } from './util/git.js';

/**
 * One line of a `--doctor` report. Structured so a future `--json` mode can
 * serialize results without breaking the text contract.
 */
export interface CheckResult {
  /** Short check name, e.g. "ANTHROPIC_API_KEY set". */
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  /** Human detail or error text. */
  readonly message?: string;
  /** Underlying error, surfaced via the logger when --verbose. */
  readonly cause?: unknown;
}

/**
 * A check result tagged with the component it came from, used for formatting.
 */
interface TaggedResult {
  readonly kind: string;
  readonly name: string;
  readonly result: CheckResult;
}

const STATUS_WIDTH = 6;

/**
 * Default output sink. Injected in tests so they can collect lines without
 * spying on the console.
 */
function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Format a tagged result as a single self-contained line:
 *   [<status>] <component-kind> (<component-name>): <check-name>[ - <message>]
 */
function formatLine(tagged: TaggedResult): string {
  const tag = `[${tagged.result.status}]`.padEnd(STATUS_WIDTH);
  const head = `${tag} ${tagged.kind} (${tagged.name}): ${tagged.result.name}`;
  return tagged.result.message === undefined
    ? head
    : `${head} - ${tagged.result.message}`;
}

/**
 * Best-effort message extraction for thrown values.
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Human-readable name for a spec: a bare name string, the head of a tuple
 * spec, or "custom" for an inline instance.
 */
function describeSpec(spec: unknown, fallback: string): string {
  if (typeof spec === 'string') {
    return spec;
  }
  if (Array.isArray(spec)) {
    return String(spec[0]);
  }
  if (spec === undefined) {
    return fallback;
  }
  return 'custom';
}

/**
 * Run a single component's check(): one skip when absent, a synthetic fail
 * when the generator throws mid-iteration, otherwise each yielded result.
 */
async function* runCheck(
  kind: string,
  name: string,
  component: { check?(): AsyncIterable<CheckResult> },
): AsyncIterable<TaggedResult> {
  if (component.check === undefined) {
    yield { kind, name, result: { name: 'diagnostics', status: 'skip', message: 'no diagnostics defined' } };
    return;
  }
  try {
    for await (const result of component.check()) {
      yield { kind, name, result };
    }
  } catch (err) {
    yield { kind, name, result: { name: 'check', status: 'fail', message: errMessage(err), cause: err } };
  }
}

/**
 * Construct a component then run its check. A construction failure becomes a
 * single fail for that component and does not abort the rest of the run.
 */
async function* buildAndCheck(
  kind: string,
  name: string,
  build: () => Promise<{ check?(): AsyncIterable<CheckResult> }>,
): AsyncIterable<TaggedResult> {
  let component: { check?(): AsyncIterable<CheckResult> };
  try {
    component = await build();
  } catch (err) {
    yield { kind, name, result: { name: 'construct', status: 'fail', message: errMessage(err), cause: err } };
    return;
  }
  yield* runCheck(kind, name, component);
}

/**
 * Output directory writable probe (independent of any reporter).
 */
async function checkOutputDir(outputDir: string): Promise<CheckResult> {
  try {
    await access(outputDir, constants.W_OK);
    return { name: 'output directory writable', status: 'ok', message: outputDir };
  } catch (err) {
    return { name: 'output directory writable', status: 'fail', message: errMessage(err), cause: err };
  }
}

/**
 * Resumable state probe: skip when absent, ok when a valid v2 file loads,
 * fail when the Step 01 loader rejects a malformed or non-v2 file.
 */
async function checkResumableState(outputDir: string, jobName: string): Promise<CheckResult> {
  const path = join(outputDir, `${jobName}-loop-state.json`);
  try {
    await access(path, constants.F_OK);
  } catch {
    return { name: 'resumable state', status: 'skip', message: 'no state file to resume' };
  }
  try {
    await FileLoopState.create(path);
    return { name: 'resumable state', status: 'ok', message: path };
  } catch (err) {
    return { name: 'resumable state', status: 'fail', message: errMessage(err), cause: err };
  }
}

/**
 * Cross-cutting environment checks: output dir, resumable state, and (only
 * when allowSourceUpdate is set) the shared git preflight.
 */
async function* environmentChecks(config: LoopCliConfig): AsyncIterable<TaggedResult> {
  const kind = 'environment';
  const name = config.name;
  const outputDir = config.outputDir ?? process.cwd();

  yield { kind, name, result: await checkOutputDir(outputDir) };
  yield { kind, name, result: await checkResumableState(outputDir, config.name) };

  if (config.allowSourceUpdate === true) {
    const items = await gitPreflight(new Git(process.cwd()));
    for (const item of items) {
      yield {
        kind,
        name,
        result: { name: item.name, status: item.ok ? 'ok' : 'fail', message: item.message },
      };
    }
  }
}

/**
 * Run all preflight checks for the resolved config, streaming each result as
 * a formatted line. Returns false iff any check failed (the CLI maps this to
 * exit code 1). Never invokes the main loop.
 */
export async function doctor(
  config: LoopCliConfig,
  logger: Logger,
  write: (line: string) => void = defaultWrite,
): Promise<boolean> {
  const outputDir = config.outputDir ?? process.cwd();
  const reporterSpec: ReporterSpec | undefined = config.reporter;

  const sources: Array<AsyncIterable<TaggedResult>> = [
    buildAndCheck('agent', describeSpec(config.agent as AgentSpec, 'default'), () =>
      createAgent(config.agent),
    ),
    buildAndCheck(
      'prompt-generator',
      describeSpec(config.promptGenerator as PromptGeneratorSpec, 'default'),
      () => createPromptGenerator(config.promptGenerator),
    ),
    buildAndCheck('reporter', describeSpec(reporterSpec, DEFAULT_REPORTER), () => {
      if (reporterSpec !== undefined && typeof reporterSpec !== 'string') {
        return Promise.resolve(reporterSpec);
      }
      return createReporter(reporterSpec, { outputDir, jobName: config.name });
    }),
    environmentChecks(config),
  ];

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  let anyFail = false;

  for (const source of sources) {
    for await (const tagged of source) {
      write(formatLine(tagged));
      counts[tagged.result.status] += 1;
      if (tagged.result.status === 'fail') {
        anyFail = true;
      }
      if (tagged.result.cause !== undefined && logger.enabled) {
        logger.error(
          tagged.result.cause instanceof Error
            ? (tagged.result.cause.stack ?? tagged.result.cause.message)
            : String(tagged.result.cause),
        );
      }
    }
  }

  write(`Summary: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip`);
  return !anyFail;
}
```

- [ ] **Step 4: Run the doctor tests and the type check**

Run: `pnpm tsc`
Expected: clean (the `check?` type-only imports now resolve).

Run: `pnpm test src/__test__/doctor.test.ts`
Expected: PASS. Add tests until `src/doctor.ts` is at 100% coverage (notably: the verbose-cause branch — pass `createLogger('verbose')` and assert `logger.error` fires; the non-Error cause branch; the malformed-state `fail`; the git-on branch).

- [ ] **Step 5: Full gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all clean, coverage 100%, no format diff.

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts src/__test__/doctor.test.ts src/agents.ts src/prompt-generators.ts src/reporters.ts
git commit -m "Feature: Add doctor() orchestrator and optional check() capability"
```

---

## Workstream 3: `--doctor` CLI flag and dispatch

> Depends on Workstream 2. Independent of W4/W5/W6 (touches only `load-cli-config.ts`, `cli.ts`, README).

**Files:**
- Modify: `src/util/load-cli-config.ts`
- Modify test: `src/util/__test__/load-cli-config.test.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`

### Task 3.1: Parse `--doctor` and ignore `--dry-run` under it

- [ ] **Step 1: Write failing flag tests in `load-cli-config.test.ts`**

```ts
it('parses --doctor as a boolean flag', () => {
  expect(parseArgs(['--doctor', 'config.json']).doctor).toBe(true);
});

it('--doctor does not take a value', () => {
  expect(() => parseArgs(['--doctor=1', 'config.json'])).toThrow(
    'Option --doctor does not take a value',
  );
});

it('ignores --dry-run when --doctor is set', async () => {
  // load a config fixture with --doctor and --dry-run; assert the agent is
  // the configured agent, not the DRY_RUN_AGENT_SPEC test agent.
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the parser changes in `src/util/load-cli-config.ts`**

Add to `ParsedArgs`:

```ts
  readonly doctor?: boolean | undefined;
```

Extend `BooleanField`:

```ts
type BooleanField = 'verbose' | 'dryRun' | 'help' | 'version' | 'doctor';
```

Add to `BOOLEAN_FLAGS`:

```ts
  ['doctor', 'doctor'],
```

Add to the `booleans` initializer in `parseArgs`:

```ts
    doctor: false,
```

Add `doctor: booleans.doctor` to the normal (non-short-circuit) return object. Update `USAGE`:

```ts
export const USAGE =
  'Usage: loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--doctor] [--max-prompts N] <config.json>';
```

In `loadCliConfig`, compute an effective dry-run that is suppressed under `--doctor`, and use it for both the verbose force and the agent swap:

```ts
const { configPath, maxPrompts, verbose, dryRun, doctor } = parsedArgs;
// ...
const effectiveDryRun = dryRun === true && doctor !== true;
return {
  ...(await normalizeCliConfig(config as LoopCliConfig, resolvedPath)),
  ...(maxPrompts !== undefined ? /* istanbul ignore next */ { maxPrompts } : {}),
  ...(verbose === true || effectiveDryRun ? { logger: 'verbose' as const } : {}),
  ...(effectiveDryRun ? { agent: DRY_RUN_AGENT_SPEC } : {}),
};
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/util/__test__/load-cli-config.test.ts`
Expected: PASS. Keep coverage at 100% for `load-cli-config.ts` (the `effectiveDryRun` branches need both doctor-on and doctor-off cases).

### Task 3.2: Dispatch to `doctor()` in `cli.ts`

- [ ] **Step 1: Edit `src/cli.ts`**

Add imports:

```ts
import { doctor } from './doctor.js';
import { createLogger } from './loggers.js';
```

In `main()`, after `const config = await loadCliConfig(parsedArgs);` and before `const result = await loop(config);`:

```ts
if (parsedArgs.doctor === true) {
  const ok = await doctor(config, createLogger(config.logger));
  process.exitCode = ok ? 0 : 1;
  return;
}
```

`cli.ts` is not coverage-measured (no test imports it), so this dispatch stays untested by design; keep it a thin pass-through.

- [ ] **Step 2: Manual smoke test against a real example config**

Run: `pnpm tsc && node dist/cli.js --doctor src/examples/<some-config>.json` (build first if needed via the project's build step), or run a passing and a failing config and confirm exit codes:

```bash
pnpm tsc && node dist/cli.js --doctor src/examples/<passing-config>.json; echo "exit=$status"
```

Expected: streamed `[ok]`/`[skip]` lines, a `Summary:` line, `exit=0`. Point it at a config with a bad token env to confirm a `[fail]` line and `exit=1`.

### Task 3.3: Document `--doctor` in the README

- [ ] **Step 1: Add a `--doctor` entry** to the README's CLI/usage section, mirroring the `gh auth status` mental model: it validates the configured agent, prompt generator, reporter, output directory, resumable state, and git prerequisites; exits 0 on success and 1 on any failure; never runs the loop; and ignores `--dry-run`.

- [ ] **Step 2: Full gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all clean.

- [ ] **Step 3: Commit**

```bash
git add src/util/load-cli-config.ts src/util/__test__/load-cli-config.test.ts src/cli.ts README.md
git commit -m "Feature: Add the --doctor CLI flag and dispatch"
```

---

## Workstream 4: Agent `check()` probes

> Depends on Workstream 2. Disjoint from W3/W5/W6. Each agent's probe lives in its own file with a sibling unit test; live probes go in `*-live.test.ts`.

**Files (modify each implementation + its `__test__` unit test, add live tests):**
- `src/agents/claude-sdk.ts` (+ `__test__/claude-sdk.test.ts`, `__test__/claude-sdk-live.test.ts`)
- `src/agents/openai-sdk.ts` (+ tests)
- `src/agents/codex-cli.ts` (+ `__test__/codex-cli.test.ts`, existing `__test__/codex-cli-live.test.ts`)
- `src/agents/test.ts` (+ `__test__/test.test.ts`)

### Probe specification per agent

Implement each as `async *check(): AsyncIterable<CheckResult>` on the agent class. Use the credential sources already used at runtime (verified against the current code):

**`claude-sdk`** (`agentName = 'claude-sdk'`; static `import { query } from '@anthropic-ai/claude-agent-sdk'`):
- `SDK module loaded` -> `ok` when `typeof query === 'function'`.
- `credentials present` -> `ok` when `process.env['ANTHROPIC_API_KEY']` or `process.env['CLAUDE_CODE_OAUTH_TOKEN']` is set; else `fail` with message `set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN`.
- `config shape valid` -> validate the stored `outputSchema` (object when present), `model` (string when present), and `allowedTools`/`loadedTools` (array, or the `{ type: 'preset' }` form) shapes; `fail` with the offending field name otherwise.
- `query probe` -> when credentials are present, run a minimal 1-token `query()` and iterate the first message; `ok` on success, `fail` (with `cause`) on any network/auth error. When credentials are absent, `skip` with `no credentials`.

**`openai-sdk`** (`agentName = 'openai-sdk'`):
- `credentials present` -> `process.env['OPENAI_API_KEY']` set, else `fail`.
- `config shape valid` -> `model` (string when present), `modelSettings` (object when present), `outputSchema` (object when present).
- `models reachable` -> when the key is present, call `openai.models.list()` as the read-only probe; `ok`/`fail`. `skip` when absent. (The SDK client is created the same way the agent's `run` path does; if the agent does not hold a raw client, construct a minimal one in the probe using the same env key.)

**`codex-cli`** (`agentName = 'codex-cli'`; spawns the `codex` binary; reads `CODEX_MODEL`):
- `codex on PATH` -> spawn `codex --version`; `ok` with the reported version, `fail` when the binary is unresolvable (`spawn` `ENOENT`).
- `CODEX_MODEL set` -> `ok` with the value when `process.env['CODEX_MODEL']` is set; `warn` when unset (codex has a default), message `CODEX_MODEL not set; codex default will be used`.
- `timeoutMs valid` -> `ok` when unset or a positive integer; `fail` otherwise.

**`test`** (`agentName = 'test'`):
- `responses configured` -> `ok` when the stored `responses` array is non-empty; `fail` (`responses must be non-empty`) otherwise. Trivially `ok` in normal use.

### Task 4.x (one per agent): TDD each probe

For each agent, follow this cycle (shown concretely for `per-file`'s sibling pattern in Workstream 5; agents follow the same shape):

- [ ] **Step 1: Write the failing unit test** in the agent's `__test__/<agent>.test.ts` (`// @module-tag local`). Mock the external dependency:
  - claude-sdk: `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` to stub `query`; set/unset `process.env` keys with `vi.stubEnv`.
  - openai-sdk: mock the OpenAI client's `models.list`; stub `OPENAI_API_KEY`.
  - codex-cli: reuse the existing `spawnMock` (`vi.hoisted`) from `codex-cli.test.ts`; assert `--version` is requested and ENOENT yields `fail`.
  - test agent: construct via `TestAgent.create({ responses: [...] })` and drain `check()`.
  Assert the yielded `CheckResult` sequence (names + statuses) for the credentials-present, credentials-absent, and config-invalid cases.

- [ ] **Step 2: Run to confirm failure** — `pnpm test src/agents/__test__/<agent>.test.ts` -> FAIL.

- [ ] **Step 3: Implement `async *check()`** on the class per the spec above. Reuse the existing private credential/config fields; do not re-resolve env vars in a way that diverges from the runtime path.

- [ ] **Step 4: Run to confirm pass** — `pnpm test src/agents/__test__/<agent>.test.ts` -> PASS.

- [ ] **Step 5: Add the live probe** in `<agent>-live.test.ts` for claude-sdk / openai-sdk / codex-cli, headed with the existing module-tag convention (see `src/agents/__test__/codex-cli-live.test.ts`: `// @module-tag live` + service tags). The live test runs the real probe and asserts no `fail` when the token/binary is present; it is skipped by the default `local` run.

### Task 4.final: Gate and commit the agent workstream

- [ ] **Step 1: Full gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all clean, coverage 100% (the local tests must cover every branch of each `check()`; live-only lines that cannot run locally should be reached by mocked equivalents, not istanbul-ignored, wherever possible).

- [ ] **Step 2: Commit**

```bash
git add src/agents
git commit -m "Feature: Add check() preflight probes to agents"
```

---

## Workstream 5: Prompt generator `check()` probes

> Depends on Workstream 2. Disjoint from W3/W4/W6.

**Files (modify each implementation + unit test, add live tests for network probes):**
- `src/prompt-generators/batch.ts`
- `src/prompt-generators/bugzilla.ts` (+ `bugzilla-live.test.ts`)
- `src/prompt-generators/github.ts` (+ `github-live.test.ts`)
- `src/prompt-generators/gitlab.ts` (+ `gitlab-live.test.ts`)
- `src/prompt-generators/json.ts`
- `src/prompt-generators/per-file.ts`
- `src/prompt-generators/test.ts`

### Probe specification per generator

**`per-file`** (`import { glob } from 'glob'`):
- `glob resolves` -> run `await glob(filePattern, { ...(excludePatterns ? { ignore: excludePatterns } : {}), nodir: true })`; `ok` with the match count when > 0; `warn` (`glob matched 0 files`) when zero; `fail` (with `cause`) when glob throws on invalid syntax.

**`json`**:
- inline `data` present -> `ok` (`inline data`).
- `dataFile` present -> resolve against the generator's `basePath`, `access(path, F_OK)` then `readFile` + `JSON.parse`; `ok` (`<path>`) on success, `fail` (with `cause`) when missing or unparseable.

**`github`** (token precedence `token` -> `tokenEnv` -> `GITHUB_TOKEN` -> `GH_TOKEN`; default origin `https://api.github.com`):
- `token resolvable` -> `ok` when the resolver returns a value, else `fail` (`set GITHUB_TOKEN or GH_TOKEN, or configure token/tokenEnv`).
- `GET /user authenticates` -> `fetch(\`${origin}/user\`, { headers })` with the same `Accept`/`User-Agent`/`X-GitHub-Api-Version`/`Authorization: Bearer` headers the generator uses; `ok` on HTTP 200, `fail` with the status text otherwise. `skip` when no token.

**`gitlab`** (token precedence `token` -> `tokenEnv` -> `GITLAB_TOKEN` -> `GL_TOKEN`; default origin `https://gitlab.com/api/v4`):
- `token resolvable` -> as above with GitLab env names.
- `GET /user authenticates` -> `fetch(\`${origin}/user\`, { headers })` with `Accept: application/json` + `PRIVATE-TOKEN`; `ok` on 200, else `fail`. `skip` when no token.

**`bugzilla`** (delegates to `@joewalker/bzjs`):
- `api key resolvable` -> `ok`/`fail` from the configured key resolution.
- `whoami authenticates` -> instantiate `new Bugzilla(task.bugzilla)` and call its whoami/`GET /rest/whoami` equivalent; `ok` on success, `fail` (with `cause`) otherwise. `skip` when no key.

**`batch`** (holds a single resolved child `source: PromptGenerator`):
- delegate to the child: if `this.#source.check !== undefined`, yield each child result with its `name` prefixed `source: `; otherwise yield one `skip` (`source has no diagnostics defined`).

**`test`**:
- trivially `ok` (`name: 'test generator'`).

### Task 5.x (one per generator): TDD each probe

Worked example for `per-file` (the others follow the identical cycle with their own mocks):

- [ ] **Step 1: Write the failing unit test** `src/prompt-generators/__test__/per-file.test.ts`:

```ts
it('check() yields ok with a match count when files match', async () => {
  const gen = await PerFilePromptGenerator.create(
    { filePattern: 'src/**/*.ts', promptTemplate: 'x' },
    process.cwd(),
  );
  const results = [];
  for await (const r of gen.check!()) {
    results.push(r);
  }
  expect(results[0].status).toBe('ok');
  expect(results[0].message).toMatch(/^\d+ files?/u);
});

it('check() yields warn when the glob matches nothing', async () => {
  const gen = await PerFilePromptGenerator.create(
    { filePattern: 'no/such/**/*.zzz', promptTemplate: 'x' },
    process.cwd(),
  );
  const results = [];
  for await (const r of gen.check!()) {
    results.push(r);
  }
  expect(results[0].status).toBe('warn');
});
```

- [ ] **Step 2: Run to confirm failure** — FAIL (`check` undefined).

- [ ] **Step 3: Implement `async *check()`** on `PerFilePromptGenerator`:

```ts
async *check(): AsyncIterable<CheckResult> {
  try {
    const files = await glob(this.#filePattern, {
      ...(this.#excludePatterns ? { ignore: this.#excludePatterns } : {}),
      nodir: true,
    });
    yield files.length > 0
      ? { name: 'glob resolves', status: 'ok', message: `${files.length} files` }
      : { name: 'glob resolves', status: 'warn', message: 'glob matched 0 files' };
  } catch (err) {
    yield {
      name: 'glob resolves',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    };
  }
}
```

Add `import type { CheckResult } from '../doctor.js';` to the file. (Confirm the exact private field names for the pattern/excludes via the class definition and reuse them; do not re-read the task config.)

- [ ] **Step 4: Run to confirm pass** — PASS.

- [ ] **Step 5: For `github`/`gitlab`/`bugzilla`**, add a `-live.test.ts` with the existing module-tag header (`// @module-tag live`, `// @module-tag network`, plus the service tag) that runs the real `GET /user` / whoami and asserts no `fail` when the token is set. Local unit tests mock `fetch` (`vi.stubGlobal('fetch', ...)`) / the `Bugzilla` client and assert the 200 -> `ok`, non-200 -> `fail`, no-token -> `skip` paths.

### Task 5.final: Gate and commit the generator workstream

- [ ] **Step 1: Full gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all clean, coverage 100%.

- [ ] **Step 2: Commit**

```bash
git add src/prompt-generators
git commit -m "Feature: Add check() preflight probes to prompt generators"
```

---

## Workstream 6: Reporter `check()` probes

> Depends on Workstream 2. Disjoint from W3/W4/W5.

**Files:**
- `src/reporters/yaml.ts` (+ `__test__/yaml.test.ts`)
- `src/reporters/jsonl.ts` (+ `__test__/jsonl.test.ts`)

### Probe specification

Both reporters store the full report file `#path`. Their `check()`:
- `output directory writable` -> derive `dir = dirname(this.#path)`, call `mkdir(dir, { recursive: true })` (the same path `create()` uses) then `access(dir, constants.W_OK)`; `ok` (`<dir>`) on success, `fail` (with `cause`) otherwise.
- `report file appendable` -> if the file exists, `access(this.#path, constants.W_OK)` and `ok`; if it does not exist, `ok` (`will be created on first append`) since `appendFile` creates it; `fail` only when it exists but is not writable.

### Task 6.1: TDD the yaml and jsonl probes

- [ ] **Step 1: Write failing tests** in each reporter's `__test__` file:

```ts
it('check() reports the output directory as writable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rep-'));
  const reporter = await YamlReporter.create({ outputDir: dir, jobName: 'job' });
  const results = [];
  for await (const r of reporter.check!()) {
    results.push(r);
  }
  expect(results.find(r => r.name === 'output directory writable')?.status).toBe('ok');
  expect(results.find(r => r.name === 'report file appendable')?.status).toBe('ok');
});
```

- [ ] **Step 2: Run to confirm failure** — FAIL (`check` undefined).

- [ ] **Step 3: Implement `async *check()`** on each reporter (identical body; `YamlReporter` shown):

```ts
async *check(): AsyncIterable<CheckResult> {
  const dir = dirname(this.#path);
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    yield { name: 'output directory writable', status: 'ok', message: dir };
  } catch (err) {
    yield {
      name: 'output directory writable',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    };
    return;
  }
  try {
    await access(this.#path, constants.F_OK);
    await access(this.#path, constants.W_OK);
    yield { name: 'report file appendable', status: 'ok', message: this.#path };
  } catch {
    yield { name: 'report file appendable', status: 'ok', message: 'will be created on first append' };
  }
}
```

Add imports to each reporter file: `import { access, constants, mkdir } from 'node:fs/promises';` (mkdir already imported in `create()`; add `access`, `constants`), `import { dirname } from 'node:path';` (join already imported; add dirname), and `import type { CheckResult } from '../doctor.js';`.

Note the `catch` here treats both "file absent" and "file present but unreadable" as `ok`/created. To reach the genuine fail branch and keep 100% coverage, add a test that makes the file exist and is unwritable, OR simplify the second probe to only the dir check if the appendable distinction is not worth the coverage cost. Prefer keeping the appendable line but cover the existing-and-writable path with a test that pre-creates the file.

- [ ] **Step 4: Run to confirm pass** — PASS.

### Task 6.2: Gate and commit the reporter workstream

- [ ] **Step 1: Full gate**

Run: `pnpm tsc && pnpm test --coverage && pnpm lint && pnpm format`
Expected: all clean, coverage 100%.

- [ ] **Step 2: Commit**

```bash
git add src/reporters
git commit -m "Feature: Add check() preflight probes to reporters"
```

---

## Workstream 7: Final integration sweep

**Files:** any touched for coverage/docs polish.

- [ ] **Step 1: Full repository gate**

Run: `pnpm tsc && pnpm test --coverage`
Expected: types clean, all tests pass, coverage 100% on statements, branches, functions, lines.

- [ ] **Step 2: Lint and format**

Run: `pnpm lint && pnpm format`
Expected: no lint errors, no format diff.

- [ ] **Step 3: Confirm `--doctor` end to end** against a passing and a failing config (see Workstream 3, Task 3.2) and confirm exit codes 0 and 1.

- [ ] **Step 4: Verify the schema and examples are unchanged** (this step adds no config key): `git diff --stat schema/ src/examples/` should be empty.

- [ ] **Step 5: Update `docs/future-plans/next.md`** with the as-built Step 02 contracts (the `CheckResult` shape, the `gitPreflight` helper, the `check?` interface members, the `--doctor` flag and dry-run interaction) as carry-over context for Step 03. Mark Step 2 complete in `docs/future-plans/roadmap.md`.

- [ ] **Step 6: Commit any remaining doc/coverage changes**

```bash
git add -A
git commit -m "Docs: Mark step 2 complete and record doctor carry-over context"
```

---

## Self-review against the Step 02 spec

Spec coverage check (each requirement -> task):
- Optional `check()` on agents/generators/reporters -> Task 2.1, Workstreams 4/5/6.
- `doctor(config)` instantiates components and streams structured results -> Task 2.2.
- `--doctor` CLI flag, exit 0/1, never invokes loop, ignores `--dry-run` -> Workstream 3.
- Component without `check()` -> single `skip`; throwing probe -> synthetic `fail`; construction failure isolates -> Task 2.2 tests.
- Per-implementation probes (all agents, all generators, all reporters) -> Workstreams 4/5/6, with the exact env-var precedence and HTTP/spawn patterns confirmed against current code.
- Cross-cutting environment checks (output dir, resumable state via the Step 01 loader, git preflight only when `allowSourceUpdate`) -> `environmentChecks` in Task 2.2.
- Shared git preflight extracted so loop and doctor stay in lockstep -> Workstream 1.
- Output format `[status] kind (name): check[ - message]`, padded tags, summary line, `--verbose` cause -> `formatLine` + `doctor()` in Task 2.2.
- Live tests for github/gitlab/bugzilla/codex gated on tokens -> Workstreams 4/5.
- No schema/example changes; README + USAGE updated -> Task 3.1/3.3, Workstream 7 Step 4.

Type/name consistency: `CheckResult`, `gitPreflight`, `GitPreflightItem`, `describeSpec`, `runCheck`, `buildAndCheck`, `environmentChecks`, and `doctor(config, logger, write?)` are used identically across tasks. `check?(): AsyncIterable<CheckResult>` is the single signature added to all three interfaces and implemented by every component.

Open risk to watch during execution: extending the loop's git preflight from clean-only to three probes (Workstream 1, Step 6) may surface loop tests that stub `Git` with only `isClean`; the step calls that out and instructs extending those stubs rather than weakening the helper.

---

## Execution handoff

This plan is structured for **subagent-driven execution** (the user asked for sub-agents). Recommended dispatch:

1. Run Workstream 0 (merge + baseline) in the main session.
2. Dispatch Workstream 1 to a sub-agent; review and commit before continuing.
3. Dispatch Workstream 2 to a sub-agent; review and commit (this unblocks the rest).
4. Dispatch Workstreams 3, 4, 5, 6 to parallel sub-agents (disjoint files). Review and commit each slice one at a time on `main` to keep the index clean.
5. Run Workstream 7 in the main session.

REQUIRED SUB-SKILL for execution: superpowers:subagent-driven-development (fresh sub-agent per workstream, two-stage review between workstreams).
