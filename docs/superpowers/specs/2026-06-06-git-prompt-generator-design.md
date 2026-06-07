# Git Prompt Generator Design

## Purpose

Add a `git` prompt-generator to loop-the-loop. It walks a commit range and yields one prompt per commit so a loop can take per-commit actions such as code review (or, with a suitable template, per-commit rebase-style cleanup work).

It follows the existing prompt-generator pattern: query a data source, iterate items, skip already-processed items via `loopState.isOutstanding(id)`, build a variables record, expand a `promptTemplate`, and yield `{ id, prompt }`.

## Iteration Model

One prompt per commit. The commit hash is the prompt `id`, so commits already processed in a previous run are skipped via `loopState.isOutstanding(hash)`.

Commits are yielded oldest-first, in the order they were applied, which is the natural order for reviewing or reasoning about a series where each commit builds on the previous one.

Merge commits are skipped. This keeps the `{{diff}}` placeholder a clean single-parent patch and matches how most per-commit review works, since merge commits rarely carry reviewable code changes.

The underlying commit list comes from `git rev-list --reverse --no-merges <range>` run inside the repo.

## Configuration

The task config mirrors the shape of `PerFileTask` and `GitHubTask`.

```ts
export interface GitTask {
  /** Commit range passed to git, e.g. "main..HEAD" or "abc123..def456". */
  range: string;
  /** Path to the git repo. Defaults to the config directory (basePath). */
  repoPath?: string;
  /** Template with {{placeholder}} substitution and {{include:…}} support. */
  promptTemplate: string;
}
```

`repoPath` defaults to the config directory (the `basePath` threaded through `create`), so a config that lives in the target repo needs no explicit path.

Path filtering and author filtering are intentionally out of scope for v1. They are easy to add later as extra fields without breaking existing configs.

## Placeholders

Commit metadata is read with a single `git show --no-patch --format=…` call per commit, using a delimiter-separated pretty-format so all metadata fields come back in one invocation.

The diff, stat, and files placeholders are computed lazily, with their own `git show` calls, only when the `promptTemplate` actually references them. A template that never mentions `{{diff}}` pays no cost for computing it.

Metadata placeholders and their pretty-format sources:

| Placeholder | Source |
|---|---|
| `{{hash}}` / `{{shortHash}}` | `%H` / `%h` |
| `{{parents}}` / `{{shortParents}}` | `%P` / `%p` |
| `{{refs}}` | `%D` |
| `{{subject}}` | `%s` |
| `{{body}}` | `%b` |
| `{{rawBody}}` | `%B` |
| `{{authorName}}` / `{{authorEmail}}` | `%an` / `%ae` |
| `{{committerName}}` / `{{committerEmail}}` | `%cn` / `%ce` |
| `{{authorDate}}` / `{{authorDateRelative}}` | `%aI` / `%ar` |
| `{{committerDate}}` | `%cI` |
| `{{signatureStatus}}` / `{{signer}}` | `%G?` / `%GS` |

Computed placeholders (lazy, separate git calls):

| Placeholder | Source |
|---|---|
| `{{diff}}` | `git show --format= <hash>` (single-parent patch) |
| `{{stat}}` | `git show --stat --format= <hash>` |
| `{{files}}` | `git show --name-status --format= <hash>` |

Position placeholders, giving the model a sense of where the commit sits in the series (a template can say `Reviewing commit {{index}} of {{commitCount}}`):

| Placeholder | Meaning |
|---|---|
| `{{index}}` | 1-based position of this commit within the range |
| `{{commitCount}}` | total commits in the range |

Placeholders deliberately excluded as low-value for review: tree hashes (`%T` / `%t`), encoding (`%e`), the filename-sanitized subject (`%f`), notes (`%N`), reflog selectors (`%g…`), and color/wrapping codes. A `{{range}}` placeholder was also considered and dropped: it is constant on every prompt and a template author who wants it can hard-code the range string they already wrote in the config.

## Registration

Following the github generator pattern:

- New file `src/prompt-generators/git.ts` exporting `GitTask` and `GitPromptGenerator` with `static readonly promptGeneratorName = 'git'` and `static async create(task, basePath?)`.
- New file `src/prompt-generators/git/config.ts` exporting `normalizeGitTaskConfig` and an `assertGitTaskConfig` validator.
- `src/prompt-generators.ts`: import the generator, add it to `promptGeneratorCreators`, add a normalization case in `normalizePromptGeneratorSpec()`, and add a creation case in `createPromptGenerator()`.
- `schema/loop-the-loop.schema.json`: add a `git` tuple variant and a `gitTask` definition describing `range`, `repoPath`, and `promptTemplate`.

## Preflight Check

`check()` (used by `--doctor`) verifies that `repoPath` is a git repository and that `range` resolves, for example by running `git rev-list <range>` and reporting a failed `CheckResult` if git exits non-zero.

## Testing

Vitest, following `src/prompt-generators/__test__/prompt-generators.test.ts`.

A fixture git repository is created in a temp directory: init, several commits, and a merge commit to prove merges are skipped. Tests assert:

- `git` appears in `promptGeneratorTypes`.
- `createPromptGenerator(['git', task])` returns a generator with a `generate()` function.
- Commits are yielded oldest-first.
- Merge commits are excluded.
- `loopState.isOutstanding` skipping works across a simulated re-run.
- Metadata placeholders substitute correctly.
- `{{diff}}`, `{{stat}}`, and `{{files}}` substitute correctly when referenced, and the diff is not computed when the template omits `{{diff}}`.
- `{{index}}` and `{{commitCount}}` reflect position and range size.
- `check()` succeeds for a valid repo/range and fails for an invalid one.

Coverage target is 100%, using the `/coverage-to-100` skill to fill gaps.
