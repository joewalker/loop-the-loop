
# Running loop-the-loop tests

## Getting Started

```sh
pnpm install
pnpm tsc
pnpm test
```

Use `pnpm build` when you need the package-ready `dist` output used by `pnpm pack` and `pnpm publish`.

## Test Tags

The default `pnpm test` run selects tests tagged `local`, so it does not call live services or require secrets. Live tests are tagged `live` and can be selected with Vitest's native tag filter.

Every `.test.ts` file should declare exactly one primary module tag at the top:

```ts
// @module-tag local
```

or:

```ts
// @module-tag live
```

Live tests can add secondary tags such as `network`, `github`, `gitlab`, `bugzilla`, `agent`, `claude-sdk`, and `codex-cli`.

Run all local and live tests with:

```sh
pnpm test --tagsFilter='local || live'
```

Run every live check with:

```sh
pnpm test --tagsFilter=live
```

Run individual live checks with:

```sh
pnpm test --tagsFilter=github
pnpm test --tagsFilter=gitlab
pnpm test --tagsFilter=bugzilla
pnpm test --tagsFilter=claude-sdk
pnpm test --tagsFilter=codex-cli
```

The GitHub check uses `GITHUB_TOKEN` or `GH_TOKEN` if either is present, but it can also run unauthenticated against a public repository. By default it checks `octocat/Hello-World` with a broad issue query. To debug a specific repository or search, set:

```sh
LOOP_TEST_GITHUB_REPOSITORY=owner/repo LOOP_TEST_GITHUB_QUERY='is:open label:bug' pnpm test --tagsFilter=github
```

The GitLab check uses `GITLAB_TOKEN` or `GL_TOKEN` if either is present, but it can also run unauthenticated against a public project. By default it checks `gitlab-org/gitlab`. To debug a specific project or search, set:

```sh
LOOP_TEST_GITLAB_PROJECT=group/project LOOP_TEST_GITLAB_SEARCH='crash' pnpm test --tagsFilter=gitlab
```

The Bugzilla check defaults to bug 2000000 on `bugzilla.mozilla.org`. To debug a specific Bugzilla bug, set:

```sh
LOOP_TEST_BUGZILLA_ID=2000000 pnpm test --tagsFilter=bugzilla
```

The Claude SDK check requires a working local Claude Agent SDK authentication
setup. It runs the `test` prompt generator against `claude-sdk` with a cheap
arithmetic prompt and asserts the exact answer:

```sh
pnpm test --tagsFilter=claude-sdk
```

The Codex CLI check requires a working local `codex` binary and authentication
setup. It uses the same generated arithmetic prompt and exact-answer assertion:

```sh
pnpm test --tagsFilter=codex-cli
```
