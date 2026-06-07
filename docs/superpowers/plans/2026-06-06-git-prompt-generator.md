# Git Prompt Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `git` prompt-generator that walks a commit range and yields one prompt per non-merge commit (oldest-first) for per-commit actions such as code review.

**Architecture:** A new `GitPromptGenerator` follows the existing generator pattern (see `GitHubPromptGenerator`). It uses the repo's commit list from `git rev-list --reverse --no-merges <range>`, then for each commit reads metadata via a single delimiter-separated `git show --no-patch --format=…` call and lazily computes diff/stat/files only when the template references them. Low-level git invocations are added to the existing `Git` class in `src/util/git.ts`.

**Tech Stack:** TypeScript, Node, Vitest, the project's `Git` wrapper around `child_process`, and `expandPrompt` for `{{placeholder}}` / `{{include:…}}` substitution.

The design spec this plan implements: `docs/superpowers/specs/2026-06-06-git-prompt-generator-design.md`.

---

## File Structure

- Modify: `src/util/git.ts` — add `revList`, `showMetadata`, `showPatch`, `showStat`, `showNameStatus` to the `Git` class.
- Modify: `src/util/__test__/git.test.ts` — tests for the new `Git` methods.
- Create: `src/prompt-generators/git/config.ts` — `normalizeGitTaskConfig` and runtime validation.
- Create: `src/prompt-generators/git/__test__/config.test.ts` — config validation tests.
- Create: `src/prompt-generators/git.ts` — `GitTask` interface and `GitPromptGenerator`.
- Create: `src/prompt-generators/__test__/git.test.ts` — generator behavior tests against a fixture repo.
- Modify: `src/prompt-generators.ts` — register the generator and its normalization.
- Modify: `src/prompt-generators/__test__/prompt-generators.test.ts` — registration/creation tests.
- Modify: `schema/loop-the-loop.schema.json` — `git` tuple variant and `gitTask` definition.
- Modify: `src/__test__/schema.test.ts` — positive and negative schema cases.

---

## Task 1: Add git plumbing to the `Git` class

**Files:**
- Modify: `src/util/git.ts` (add methods to the `Git` class, after `commit` near line 145)
- Test: `src/util/__test__/git.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this block inside the top-level `describe('Git', …)` in `src/util/__test__/git.test.ts`, after the existing `describe('configValue', …)` block (before the final closing `});` of `describe('Git')`). It defines a small helper that runs raw git in the fixture repo.

```ts
  /** Run a raw git command in the fixture repo and return trimmed stdout. */
  function rawGit(...args: Array<string>): string {
    return execFileSync('git', ['-C', repoPath, ...args]).toString().trim();
  }

  /** Create and commit a file in the fixture repo. */
  async function commitFile(file: string, content: string, message: string) {
    await writeFile(join(repoPath, file), content);
    await git.add(file);
    await git.commit(message, { committer: { name: 'Test', email: 'test@test.com' } });
    return rawGit('rev-parse', 'HEAD');
  }

  describe('revList', () => {
    it('returns non-merge commits oldest-first for a linear range', async () => {
      // beforeEach already created the "Initial commit" (commit A).
      const a = rawGit('rev-parse', 'HEAD');
      const b = await commitFile('b.txt', 'B', 'Commit B');
      const c = await commitFile('c.txt', 'C', 'Commit C');

      expect(await git.revList(`${a}..HEAD`)).toEqual([b, c]);
    });

    it('excludes merge commits', async () => {
      rawGit('config', 'user.name', 'Test');
      rawGit('config', 'user.email', 'test@test.com');
      const a = rawGit('rev-parse', 'HEAD');
      const b = await commitFile('b.txt', 'B', 'Commit B');

      rawGit('checkout', '-b', 'feature', a);
      const c = await commitFile('c.txt', 'C', 'Commit C');

      const base = 'master';
      // The default branch may be master or main; check out whichever exists.
      const branches = rawGit('branch', '--format=%(refname:short)').split('\n');
      rawGit('checkout', branches.includes(base) ? base : 'main');
      rawGit('merge', '--no-ff', '-m', 'Merge feature', 'feature');
      const merge = rawGit('rev-parse', 'HEAD');

      const hashes = await git.revList(`${a}..HEAD`);
      expect(hashes).toContain(b);
      expect(hashes).toContain(c);
      expect(hashes).not.toContain(merge);
    });

    it('returns an empty array for an empty range', async () => {
      expect(await git.revList('HEAD..HEAD')).toEqual([]);
    });
  });

  describe('show helpers', () => {
    it('showMetadata renders a pretty-format string', async () => {
      const hash = await commitFile('b.txt', 'B', 'Commit B');
      const out = await git.showMetadata(hash, '%s%x1f%an');
      expect(out.replace(/\n$/, '')).toBe('Commit B\x1fTest');
    });

    it('showPatch returns the patch body', async () => {
      const hash = await commitFile('b.txt', 'hello', 'Commit B');
      expect(await git.showPatch(hash)).toContain('b.txt');
    });

    it('showStat returns a diffstat', async () => {
      const hash = await commitFile('b.txt', 'hello', 'Commit B');
      expect(await git.showStat(hash)).toContain('b.txt');
    });

    it('showNameStatus returns name-status lines', async () => {
      const hash = await commitFile('b.txt', 'hello', 'Commit B');
      expect(await git.showNameStatus(hash)).toMatch(/A\s+b\.txt/);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/util/__test__/git.test.ts`
Expected: FAIL with errors like "git.revList is not a function".

- [ ] **Step 3: Implement the new `Git` methods**

In `src/util/git.ts`, add these methods to the `Git` class immediately after the `commit` method (after line 145, before the class's closing `}`):

```ts
  /**
   * 'git rev-list --reverse --no-merges <range>'
   *
   * Returns the non-merge commit hashes reachable in `range`, oldest-first.
   * An empty range resolves to an empty array.
   */
  async revList(range: string): Promise<Array<string>> {
    const out = await exec('git', [
      '-C',
      this.#repoPath,
      'rev-list',
      '--reverse',
      '--no-merges',
      range,
    ]);
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  /**
   * 'git show --no-patch --format=<format> <hash>'
   *
   * Returns commit metadata rendered with a pretty-format string and no diff.
   * The caller is responsible for parsing the result.
   */
  async showMetadata(hash: string, format: string): Promise<string> {
    return exec('git', [
      '-C',
      this.#repoPath,
      'show',
      '--no-patch',
      `--format=${format}`,
      hash,
    ]);
  }

  /**
   * 'git show --format= <hash>'
   *
   * Returns the single-parent patch for a commit with no metadata header. The
   * output begins with a blank line that the caller may wish to strip.
   */
  async showPatch(hash: string): Promise<string> {
    return exec('git', ['-C', this.#repoPath, 'show', '--format=', hash]);
  }

  /**
   * 'git show --stat --format= <hash>'
   *
   * Returns the diffstat for a commit with no metadata header.
   */
  async showStat(hash: string): Promise<string> {
    return exec('git', [
      '-C',
      this.#repoPath,
      'show',
      '--stat',
      '--format=',
      hash,
    ]);
  }

  /**
   * 'git show --name-status --format= <hash>'
   *
   * Returns the changed files with their status letters and no metadata header.
   */
  async showNameStatus(hash: string): Promise<string> {
    return exec('git', [
      '-C',
      this.#repoPath,
      'show',
      '--name-status',
      '--format=',
      hash,
    ]);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/util/__test__/git.test.ts`
Expected: PASS (all new tests green).

- [ ] **Step 5: Commit**

```bash
git add src/util/git.ts src/util/__test__/git.test.ts
git commit -m "Feature: Add rev-list and show helpers to the Git wrapper"
```

---

## Task 2: Git task config validation

**Files:**
- Create: `src/prompt-generators/git/config.ts`
- Test: `src/prompt-generators/git/__test__/config.test.ts`

This task references `GitTask`, which is defined in Task 3. To keep tasks independently runnable, define the config validator against the `GitTask` shape now; Task 3 creates the matching interface. If you implement out of order, Task 3's `git.ts` must export `interface GitTask { range: string; repoPath?: string; promptTemplate: string }`.

- [ ] **Step 1: Write the failing tests**

Create `src/prompt-generators/git/__test__/config.test.ts`:

```ts
// @module-tag local

import { normalizeGitTaskConfig } from 'loop-the-loop/prompt-generators/git/config';
import { describe, expect, it } from 'vitest';

describe('normalizeGitTaskConfig', () => {
  it('returns a valid config unchanged', () => {
    const config = { range: 'main..HEAD', promptTemplate: 'Review {{hash}}' };
    expect(normalizeGitTaskConfig(config)).toBe(config);
  });

  it('accepts an optional repoPath', () => {
    const config = {
      range: 'main..HEAD',
      repoPath: '../other',
      promptTemplate: 'Review {{hash}}',
    };
    expect(normalizeGitTaskConfig(config)).toBe(config);
  });

  it('throws when the value is not an object', () => {
    expect(() => normalizeGitTaskConfig('nope')).toThrow(
      'git task config must be an object',
    );
  });

  it('throws when range is missing', () => {
    expect(() =>
      normalizeGitTaskConfig({ promptTemplate: 'x' }),
    ).toThrow('git.range must be a string');
  });

  it('throws when promptTemplate is missing', () => {
    expect(() =>
      normalizeGitTaskConfig({ range: 'main..HEAD' }),
    ).toThrow('git.promptTemplate must be a string');
  });

  it('throws when repoPath is not a string', () => {
    expect(() =>
      normalizeGitTaskConfig({
        range: 'main..HEAD',
        repoPath: 5,
        promptTemplate: 'x',
      }),
    ).toThrow('git.repoPath must be a string');
  });

  it('throws on an unknown property', () => {
    expect(() =>
      normalizeGitTaskConfig({
        range: 'main..HEAD',
        promptTemplate: 'x',
        bogus: true,
      }),
    ).toThrow('git.bogus is not supported');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/prompt-generators/git/__test__/config.test.ts`
Expected: FAIL with "Cannot find module .../git/config".

- [ ] **Step 3: Implement the validator**

Create `src/prompt-generators/git/config.ts`:

```ts
import type { GitTask } from '../git.js';
import {
  assertKnownProperties,
  assertOptionalString,
  assertRequiredString,
  isRecord,
} from '../util/config.js';

/**
 * Normalize git task config values loaded from JSON.
 */
export function normalizeGitTaskConfig(config: unknown): GitTask {
  assertGitTaskConfig(config);
  return config;
}

/**
 * Assert that an unknown value has the runtime shape required for a git task
 * config.
 */
function assertGitTaskConfig(value: unknown): asserts value is GitTask {
  if (!isRecord(value)) {
    throw new Error('git task config must be an object');
  }

  assertKnownProperties(
    value,
    ['range', 'repoPath', 'promptTemplate'],
    'git',
  );
  assertRequiredString(value, 'range', 'git.range');
  assertRequiredString(value, 'promptTemplate', 'git.promptTemplate');
  assertOptionalString(value, 'repoPath', 'git.repoPath');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/prompt-generators/git/__test__/config.test.ts`
Expected: PASS. (If `git.ts` does not yet exist, the type-only import of `GitTask` still resolves at test runtime because it is erased; run `pnpm tsc` only after Task 3.)

- [ ] **Step 5: Commit**

```bash
git add src/prompt-generators/git/config.ts src/prompt-generators/git/__test__/config.test.ts
git commit -m "Feature: Add git prompt-generator config validation"
```

---

## Task 3: The `GitPromptGenerator`

**Files:**
- Create: `src/prompt-generators/git.ts`
- Test: `src/prompt-generators/__test__/git.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/prompt-generators/__test__/git.test.ts`. The fixture builds a deterministic linear history for ordering/placeholder assertions, plus a separate merge for the exclusion test. `vi.spyOn` proves the diff is computed lazily.

```ts
// @module-tag local

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import { GitPromptGenerator } from 'loop-the-loop/prompt-generators/git';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import { Git } from 'loop-the-loop/util/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const committer = { name: 'Test', email: 'test@test.com' };

describe('GitPromptGenerator', () => {
  let repoPath: string;
  let git: Git;
  let firstHash: string;

  function rawGit(...args: Array<string>): string {
    return execFileSync('git', ['-C', repoPath, ...args]).toString().trim();
  }

  async function commitFile(file: string, content: string, message: string) {
    await writeFile(join(repoPath, file), content);
    await git.add(file);
    await git.commit(message, { committer });
    return rawGit('rev-parse', 'HEAD');
  }

  async function collect(generator: GitPromptGenerator): Promise<Array<Prompt>> {
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'git-gen-'));
    git = new Git(repoPath);
    await git.init();
    rawGit('config', 'user.name', 'Test');
    rawGit('config', 'user.email', 'test@test.com');
    firstHash = await commitFile('a.txt', 'A', 'Commit A');
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('yields one prompt per non-merge commit, oldest-first', async () => {
    const b = await commitFile('b.txt', 'B', 'Commit B');
    const c = await commitFile('c.txt', 'C', 'Commit C');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts.map(p => p.id)).toEqual([b, c]);
    expect(prompts.map(p => p.prompt)).toEqual(['Commit B', 'Commit C']);
  });

  it('substitutes metadata and position placeholders', async () => {
    await commitFile('b.txt', 'B', 'Commit B');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        promptTemplate:
          '[{{index}}/{{commitCount}}] {{subject}} by {{authorName}} <{{authorEmail}}>',
      },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts[0].prompt).toBe(
      '[1/1] Commit B by Test <test@test.com>',
    );
  });

  it('includes diff, stat and files when the template references them', async () => {
    await commitFile('b.txt', 'hello', 'Commit B');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        promptTemplate: 'D:{{diff}} S:{{stat}} F:{{files}}',
      },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts[0].prompt).toContain('b.txt');
    expect(prompts[0].prompt).toContain('hello');
    expect(prompts[0].prompt).toMatch(/A\s+b\.txt/);
  });

  it('does not compute the diff when the template omits {{diff}}', async () => {
    await commitFile('b.txt', 'B', 'Commit B');
    const spy = vi.spyOn(Git.prototype, 'showPatch');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    await collect(generator);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('excludes merge commits', async () => {
    const b = await commitFile('b.txt', 'B', 'Commit B');
    const branches = rawGit('branch', '--format=%(refname:short)').split('\n');
    rawGit('checkout', '-b', 'feature', firstHash);
    const c = await commitFile('c.txt', 'C', 'Commit C');
    rawGit('checkout', branches[0]);
    rawGit('merge', '--no-ff', '-m', 'Merge feature', 'feature');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts.map(p => p.id).sort()).toEqual([b, c].sort());
    expect(prompts.map(p => p.prompt)).not.toContain('Merge feature');
  });

  it('skips commits already tracked in the loop state', async () => {
    const b = await commitFile('b.txt', 'B', 'Commit B');
    const c = await commitFile('c.txt', 'C', 'Commit C');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const loopState = FileLoopState.fromPersisted('ignored.json', {
      version: 2,
      results: { [b]: { status: 'success' } },
      claims: {},
    });
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts.map(p => p.id)).toEqual([c]);
  });

  it('defaults repoPath to basePath and resolves it relatively', async () => {
    await commitFile('b.txt', 'B', 'Commit B');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, repoPath: '.', promptTemplate: '{{subject}}' },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts.map(p => p.prompt)).toEqual(['Commit B']);
  });

  describe('check', () => {
    it('reports ok with a commit count for a valid range', async () => {
      await commitFile('b.txt', 'B', 'Commit B');
      const generator = new GitPromptGenerator(
        { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
        repoPath,
      );
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      expect(results).toContainEqual(
        expect.objectContaining({ status: 'ok', message: '1 commits' }),
      );
    });

    it('warns when the range resolves to zero commits', async () => {
      const generator = new GitPromptGenerator(
        { range: 'HEAD..HEAD', promptTemplate: '{{subject}}' },
        repoPath,
      );
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      expect(results).toContainEqual(
        expect.objectContaining({ status: 'warn' }),
      );
    });

    it('fails when repoPath is not a git work tree', async () => {
      const nonRepo = await mkdtemp(join(tmpdir(), 'git-nonrepo-'));
      try {
        const generator = new GitPromptGenerator(
          { range: 'main..HEAD', promptTemplate: '{{subject}}' },
          nonRepo,
        );
        const results = [];
        for await (const result of generator.check()) {
          results.push(result);
        }
        expect(results).toContainEqual(
          expect.objectContaining({ status: 'fail' }),
        );
      } finally {
        await rm(nonRepo, { recursive: true, force: true });
      }
    });

    it('fails when the range is invalid', async () => {
      const generator = new GitPromptGenerator(
        { range: 'no-such-ref..HEAD', promptTemplate: '{{subject}}' },
        repoPath,
      );
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      expect(results).toContainEqual(
        expect.objectContaining({ status: 'fail' }),
      );
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/prompt-generators/__test__/git.test.ts`
Expected: FAIL with "Cannot find module .../prompt-generators/git".

- [ ] **Step 3: Implement the generator**

Create `src/prompt-generators/git.ts`:

```ts
import { resolve } from 'node:path';

import type { CheckResult } from '../doctor.js';
import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import { Git } from '../util/git.js';

/**
 * Configuration for a git-commit-range-driven loop task. Describes which range
 * of commits to walk and what prompt to generate for each commit.
 */
export interface GitTask {
  /**
   * Commit range passed to git, for example "main..HEAD" or
   * "abc123..def456".
   */
  range: string;

  /**
   * Path to the git repository. Relative paths resolve against `basePath`
   * (the config file directory under CLI loading), which is also the default.
   */
  repoPath?: string;

  /**
   * How to construct a prompt for each commit. The following placeholders are
   * substituted:
   * - `{{hash}}` / `{{shortHash}}` - full / abbreviated commit hash
   * - `{{parents}}` / `{{shortParents}}` - parent hashes
   * - `{{refs}}` - ref-name decoration
   * - `{{subject}}` - commit subject line
   * - `{{body}}` - commit message body
   * - `{{rawBody}}` - raw subject and body
   * - `{{authorName}}` / `{{authorEmail}}` - commit author
   * - `{{committerName}}` / `{{committerEmail}}` - commit committer
   * - `{{authorDate}}` / `{{authorDateRelative}}` - author date (ISO / relative)
   * - `{{committerDate}}` - committer date (ISO)
   * - `{{signatureStatus}}` / `{{signer}}` - signature verification
   * - `{{diff}}` - the single-parent patch
   * - `{{stat}}` - the diffstat
   * - `{{files}}` - changed files with status letters
   * - `{{index}}` / `{{commitCount}}` - 1-based position / total in the range
   *
   * `{{diff}}`, `{{stat}}` and `{{files}}` are computed only when the template
   * string references them. A placeholder that appears solely inside an
   * `{{include:...}}` file is not detected.
   */
  promptTemplate: string;
}

const FIELD_SEP = '\x1f';

/**
 * Ordered metadata fields and their git pretty-format specifiers. `body` and
 * `rawBody` are kept last because they may span multiple lines; only the very
 * last field carries git's trailing newline.
 */
const METADATA_FIELDS = [
  ['hash', '%H'],
  ['shortHash', '%h'],
  ['parents', '%P'],
  ['shortParents', '%p'],
  ['refs', '%D'],
  ['subject', '%s'],
  ['authorName', '%an'],
  ['authorEmail', '%ae'],
  ['committerName', '%cn'],
  ['committerEmail', '%ce'],
  ['authorDate', '%aI'],
  ['authorDateRelative', '%ar'],
  ['committerDate', '%cI'],
  ['signatureStatus', '%G?'],
  ['signer', '%GS'],
  ['body', '%b'],
  ['rawBody', '%B'],
] as const;

const METADATA_FORMAT = METADATA_FIELDS.map(([, fmt]) => fmt).join(FIELD_SEP);

/**
 * A PromptGenerator that walks a commit range and yields one prompt per
 * non-merge commit, oldest-first. The commit hash is used as the prompt id so
 * already-processed commits are skipped on resume. `basePath` resolves
 * `{{include:...}}` macros and a relative `repoPath`, defaulting to
 * `process.cwd()`. CLI config loading passes the config file's directory.
 */
export class GitPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'git';

  static async create(
    task: GitTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new GitPromptGenerator(task, basePath);
  }

  readonly #task: GitTask;
  readonly #basePath: string;

  constructor(task: GitTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const git = new Git(this.#resolveRepoPath());
    const template = this.#task.promptTemplate;

    const hashes = await git.revList(this.#task.range);
    const commitCount = hashes.length;

    for (const [i, hash] of hashes.entries()) {
      if (!loopState.isOutstanding(hash)) {
        continue;
      }

      const meta = parseMetadata(await git.showMetadata(hash, METADATA_FORMAT));

      let diff = '';
      let stat = '';
      let files = '';
      if (template.includes('{{diff}}')) {
        diff = stripLeadingNewlines(await git.showPatch(hash));
      }
      if (template.includes('{{stat}}')) {
        stat = stripLeadingNewlines(await git.showStat(hash));
      }
      if (template.includes('{{files}}')) {
        files = stripLeadingNewlines(await git.showNameStatus(hash));
      }

      const variables = buildVariables(meta, {
        index: String(i + 1),
        commitCount: String(commitCount),
        diff,
        stat,
        files,
      });
      const prompt = await expandPrompt(template, this.#basePath, variables);

      yield { id: hash, prompt };
    }
  }

  /**
   * Preflight probe used by `--doctor`: confirm the repo path is a git work
   * tree and that the configured range resolves.
   */
  async *check(): AsyncIterable<CheckResult> {
    const repoPath = this.#resolveRepoPath();
    const git = new Git(repoPath);

    if (!(await git.isInsideWorkTree())) {
      yield {
        name: 'git repo',
        status: 'fail',
        message: `${repoPath} is not a git work tree`,
      };
      return;
    }

    try {
      const hashes = await git.revList(this.#task.range);
      yield {
        name: 'range resolves',
        status: hashes.length > 0 ? 'ok' : 'warn',
        message: `${hashes.length} commits`,
      };
    } catch (err) {
      yield {
        name: 'range resolves',
        status: 'fail',
        message:
          err instanceof Error
            ? err.message
            : /* istanbul ignore next */ String(err),
        cause: err,
      };
    }
  }

  /**
   * Resolve the configured repo path against `basePath`, defaulting to the
   * base path itself when `repoPath` is omitted.
   */
  #resolveRepoPath(): string {
    return resolve(this.#basePath, this.#task.repoPath ?? '.');
  }
}

/**
 * Parse delimiter-separated `git show` metadata output into a record keyed by
 * the field names in `METADATA_FIELDS`.
 */
function parseMetadata(out: string): Record<string, string> {
  const parts = out.replace(/\n$/, '').split(FIELD_SEP);
  const result: Record<string, string> = {};
  METADATA_FIELDS.forEach(([name], i) => {
    result[name] = parts[i] ?? /* istanbul ignore next */ '';
  });
  return result;
}

/**
 * Build the prompt template variables for a commit. Multi-line content fields
 * (subject, stat, files, diff, body, rawBody) are inserted last so that any
 * placeholder-looking text inside them is not re-substituted.
 */
function buildVariables(
  meta: Record<string, string>,
  extra: {
    readonly index: string;
    readonly commitCount: string;
    readonly diff: string;
    readonly stat: string;
    readonly files: string;
  },
): Record<string, string> {
  return {
    hash: meta['hash'],
    shortHash: meta['shortHash'],
    parents: meta['parents'],
    shortParents: meta['shortParents'],
    refs: meta['refs'],
    authorName: meta['authorName'],
    authorEmail: meta['authorEmail'],
    committerName: meta['committerName'],
    committerEmail: meta['committerEmail'],
    authorDate: meta['authorDate'],
    authorDateRelative: meta['authorDateRelative'],
    committerDate: meta['committerDate'],
    signatureStatus: meta['signatureStatus'],
    signer: meta['signer'],
    index: extra.index,
    commitCount: extra.commitCount,
    subject: meta['subject'],
    stat: extra.stat,
    files: extra.files,
    diff: extra.diff,
    body: meta['body'],
    rawBody: meta['rawBody'],
  };
}

/**
 * Strip the leading blank line(s) that `git show --format=` emits before the
 * patch/stat/name-status body.
 */
function stripLeadingNewlines(text: string): string {
  return text.replace(/^\n+/, '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/prompt-generators/__test__/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/prompt-generators/git.ts src/prompt-generators/__test__/git.test.ts
git commit -m "Feature: Add the git prompt-generator"
```

---

## Task 4: Register the generator

**Files:**
- Modify: `src/prompt-generators.ts`
- Test: `src/prompt-generators/__test__/prompt-generators.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/prompt-generators/__test__/prompt-generators.test.ts`, add a registration assertion inside `describe('promptGeneratorTypes', …)` (after the `github` case, around line 29):

```ts
  it('should include git', () => {
    expect(promptGeneratorTypes).toContain('git');
  });
```

And add a creation assertion inside `describe('createPromptGenerator', …)` (after the per-file case, around line 52):

```ts
  it('should resolve a git prompt generator', async () => {
    const generator = await createPromptGenerator([
      'git',
      { range: 'main..HEAD', promptTemplate: 'Review {{hash}}' },
    ]);
    expect(typeof generator.generate).toBe('function');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/prompt-generators/__test__/prompt-generators.test.ts`
Expected: FAIL ("expected [ … ] to contain 'git'").

- [ ] **Step 3: Register the generator**

In `src/prompt-generators.ts`:

Add the imports near the other generator imports (place before the `github` imports so oxfmt's sort is satisfied, i.e. just before line 11):

```ts
import { GitPromptGenerator } from './prompt-generators/git.js';
import { normalizeGitTaskConfig } from './prompt-generators/git/config.js';
```

Add to the `promptGeneratorCreators` map (before the `GitHubPromptGenerator` entry, around line 113):

```ts
  [GitPromptGenerator.promptGeneratorName]: GitPromptGenerator.create,
```

Add a normalization case in `normalizePromptGeneratorSpec`, immediately before the `GitHubPromptGenerator` case (around line 189):

```ts
  if (type === GitPromptGenerator.promptGeneratorName) {
    return [type, normalizeGitTaskConfig(config), configDir];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/prompt-generators/__test__/prompt-generators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-generators.ts src/prompt-generators/__test__/prompt-generators.test.ts
git commit -m "Feature: Register the git prompt-generator"
```

---

## Task 5: JSON schema

**Files:**
- Modify: `schema/loop-the-loop.schema.json`
- Test: `src/__test__/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/__test__/schema.test.ts`, add a positive case to the `cases` array in `describe('positive cases', …)` (for example after the `'github issue search'` entry, around line 246):

```ts
      [
        'git commit range',
        {
          name: 'git',
          agent: 'claude-sdk',
          promptGenerator: [
            'git',
            {
              range: 'main..HEAD',
              repoPath: '.',
              promptTemplate: 'Review commit {{index}}/{{commitCount}}: {{subject}}',
            },
          ],
        },
      ],
```

And add a negative case to the `cases` array in `describe('negative cases', …)` (for example after the `'rejects github search without repository'` entry, around line 530):

```ts
      [
        'rejects git task without range',
        {
          name: 'x',
          agent: 'claude-sdk',
          promptGenerator: ['git', { promptTemplate: 'y' }],
        },
      ],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/__test__/schema.test.ts`
Expected: FAIL (the positive `git commit range` case does not validate yet).

- [ ] **Step 3: Update the schema**

In `schema/loop-the-loop.schema.json`, add a `git` tuple variant to the `promptGeneratorSpec.oneOf` array. Insert it immediately before the `github` variant (the block whose `items` first element is `{ "const": "github" }`, around line 356):

```json
        {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "additionalItems": false,
          "items": [{ "const": "git" }, { "$ref": "#/definitions/gitTask" }]
        },
```

Then add the `gitTask` definition immediately before the `githubTask` definition (around line 463):

```json
    "gitTask": {
      "type": "object",
      "required": ["range", "promptTemplate"],
      "additionalProperties": false,
      "properties": {
        "range": {
          "type": "string",
          "description": "Commit range passed to git rev-list, e.g. 'main..HEAD' or 'abc123..def456'."
        },
        "repoPath": {
          "type": "string",
          "description": "Path to the git repository. Relative paths resolve against the config file directory, which is also the default."
        },
        "promptTemplate": {
          "type": "string",
          "description": "Prompt template. Substituted placeholders: {{hash}}, {{shortHash}}, {{parents}}, {{shortParents}}, {{refs}}, {{subject}}, {{body}}, {{rawBody}}, {{authorName}}, {{authorEmail}}, {{committerName}}, {{committerEmail}}, {{authorDate}}, {{authorDateRelative}}, {{committerDate}}, {{signatureStatus}}, {{signer}}, {{diff}}, {{stat}}, {{files}}, {{index}}, {{commitCount}}. Supports {{include:path}} macros (resolved relative to the config file directory)."
        }
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/__test__/schema.test.ts`
Expected: PASS (schema still compiles cleanly and both new cases pass).

- [ ] **Step 5: Commit**

```bash
git add schema/loop-the-loop.schema.json src/__test__/schema.test.ts
git commit -m "Feature: Document the git prompt-generator in the config schema"
```

---

## Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check and full test run with coverage**

Run: `pnpm tsc && pnpm test --coverage`
Expected: tsc clean; all tests pass; coverage at 100%. If coverage gaps remain on the new files, use the `/coverage-to-100` skill to add tests or justified `istanbul ignore` markers, then re-run.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors. Fix any reported issues.

- [ ] **Step 3: Format**

Run: `pnpm format`
Expected: files formatted. If anything changed, review and include it.

- [ ] **Step 4: Commit any verification fixups**

```bash
git add -A
git commit -m "Test: Finalize git prompt-generator coverage and formatting"
```

(Skip this commit if Steps 1-3 produced no changes.)

---

## Self-Review Notes

Spec coverage: per-commit iteration (Task 3 `generate`), oldest-first via `--reverse` (Task 1 `revList`), merge skipping via `--no-merges` (Task 1, asserted in Tasks 1 and 3), commit-hash id and `isOutstanding` skipping (Task 3), the full placeholder set including `{{index}}`/`{{commitCount}}` and the dropped `{{range}}` (Task 3 `buildVariables` + Task 5 schema), lazy diff/stat/files (Task 3, asserted via spy), `repoPath` defaulting to the config dir (Task 3 `#resolveRepoPath`), config validation (Task 2), registration (Task 4), schema (Task 5), and the `check()` preflight (Task 3).

Type consistency: `GitTask` (range, repoPath?, promptTemplate) is used identically in Tasks 2, 3, 4, and 5. Method names `revList`, `showMetadata`, `showPatch`, `showStat`, `showNameStatus` match between Task 1's implementation and Task 3's calls.

Known limitation (documented in the `promptTemplate` doc comment): lazy diff/stat/files detection inspects the raw template string, so a `{{diff}}` placeholder that lives only inside an `{{include:...}}` file will not trigger computation. This is acceptable for v1; per-commit data placeholders normally live in the template itself.
