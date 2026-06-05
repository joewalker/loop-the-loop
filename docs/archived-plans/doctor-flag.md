# Plan: `--doctor` CLI option

## Context

Running `loop-the-loop` against a fresh config is often the first time the
runtime touches the real outside world: an LLM API key, a GitHub/GitLab token,
the `codex` binary on PATH, a writable output directory, a clean git tree.
Static JSON schema validation in `schema/loop-the-loop.schema.json` catches
shape errors but cannot tell the user "your `GITHUB_TOKEN` is set but expired"
or "`codex` is not on PATH" before the loop kicks off and burns time/tokens.

`--doctor` runs preflight checks against the actually-configured agent,
prompt generator, and reporter (plus a handful of cross-cutting environment
checks) and prints a per-component report. It exits 0 if everything passes
and 1 if any check fails. It does NOT invoke the main loop.

The mental model is `gh auth status` / `glab auth status`: a self-diagnostic
that turns silent runtime failures into a single, readable up-front report.

## Design

### New `Checkable` capability

Add an optional `check()` method to each of the three core interfaces. Each
yields `CheckResult` values via an async generator so the CLI can print each
result the moment it lands instead of waiting for the whole component to
finish. This matches the existing
`PromptGenerator.generate(): AsyncIterable<Prompt>` pattern for
consistency, and means a slow probe (e.g. a network call) does not block
output of earlier fast probes.

```ts
// src/doctor.ts (new file)
export interface CheckResult {
  readonly name: string;                       // "ANTHROPIC_API_KEY set"
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly message?: string;                   // human detail or error text
  readonly cause?: unknown;                    // underlying error if any
}
```

Interface changes (all optional, so external/test implementations stay valid):

- [src/agents.ts:44-46](../../src/agents.ts#L44-L46) - add
  `check?: () => AsyncIterable<CheckResult>` to `Agent`.
- [src/prompt-generators.ts:66-72](../../src/prompt-generators.ts#L66-L72) - add
  `check?: () => AsyncIterable<CheckResult>` to `PromptGenerator`.
- [src/reporters.ts:22-27](../../src/reporters.ts#L22-L27) - add
  `check?: () => AsyncIterable<CheckResult>` to `Reporter`.

Implementations are written as `async function* check() { yield ...; }`
and may `await` between yields. If a probe throws, the generator yields a
synthetic `fail` entry rather than propagating - so one failed probe does
not abort the rest of that component's checks.

`doctor()` yields a single `skip` entry for any component whose
implementation omits `check()`.

### Per-implementation checks

Agent probe depth: cheap real API call (per user decision).

- ClaudeSDKAgent ([src/agents/claude-sdk.ts](../../src/agents/claude-sdk.ts))
  - SDK module loads.
  - `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` present.
  - Validate `outputSchema`, `model`, tool list shape.
  - Cheap probe: a minimal `query()` with `maxTurns: 0` if supported, else
    the lightest no-tool prompt available (1 token request). Network/auth
    failures surface as `fail`.
- OpenAISDKAgent ([src/agents/openai-sdk.ts](../../src/agents/openai-sdk.ts))
  - SDK module loads.
  - `OPENAI_API_KEY` present.
  - Validate `model`, `modelSettings`, schema shape.
  - Cheap probe: `openai.models.list()` (read-only, billed at zero tokens).
- CodexCLIAgent ([src/agents/codex-cli.ts](../../src/agents/codex-cli.ts))
  - `codex` binary resolvable on PATH.
  - `CODEX_MODEL` env var set.
  - `timeoutMs` positive integer.
  - Run `codex --version` and report the version string.
- TestAgent ([src/agents/test.ts](../../src/agents/test.ts))
  - `responses` array is non-empty; trivially `ok`.

Prompt generators:

- BatchPromptGenerator ([src/prompt-generators/batch.ts](../../src/prompt-generators/batch.ts))
  - Recursively delegate `check()` to each child source. Prefix names with
    `source[i].` so output is unambiguous.
- BugzillaPromptGenerator ([src/prompt-generators/bugzilla.ts](../../src/prompt-generators/bugzilla.ts))
  - API key resolvable.
  - `GET /rest/whoami` (read-only) authenticates.
- GitHubPromptGenerator ([src/prompt-generators/github.ts](../../src/prompt-generators/github.ts))
  - Token resolvable from `GITHUB_TOKEN`/`GH_TOKEN` or `tokenEnv`/`token`.
  - `GET /user` returns 200 (lightweight, free).
- GitLabPromptGenerator ([src/prompt-generators/gitlab.ts](../../src/prompt-generators/gitlab.ts))
  - Token resolvable from `GITLAB_TOKEN`/`GL_TOKEN` or `tokenEnv`/`token`.
  - `GET /user` against configured origin returns 200.
- JsonPromptGenerator ([src/prompt-generators/json.ts](../../src/prompt-generators/json.ts))
  - If `dataFile` configured: file exists and is readable.
  - Inline `data` form is trivially `ok`.
- PerFilePromptGenerator ([src/prompt-generators/per-file.ts](../../src/prompt-generators/per-file.ts))
  - Resolve the glob with `globSync({ nodir: true })`; `warn` if zero
    matches; `fail` if glob syntax is invalid.
- TestPromptGenerator ([src/prompt-generators/test.ts](../../src/prompt-generators/test.ts))
  - Trivially `ok`.

Reporters:

- YamlReporter ([src/reporters/yaml.ts](../../src/reporters/yaml.ts))
- JsonlReporter ([src/reporters/jsonl.ts](../../src/reporters/jsonl.ts))
  - `outputDir` is writable (`fs.access(dir, W_OK)`).
  - Target report file is appendable (writable if exists; otherwise parent
    dir writable).

### Cross-cutting environment checks

Per user selections, `doctor()` also emits an `environment` component with:

- Output directory writable: `fs.access(config.outputDir, W_OK)` (called
  independently of the reporter so a misconfigured `outputDir` surfaces
  even if no reporter is configured to flag it).
- Resumable state: if `${outputDir}/${name}-loop-state.json` exists, parse
  it; `fail` on JSON parse error, `ok` otherwise. Missing file is `skip`.
- Git working tree (only when `config.allowSourceUpdate === true`): reuse
  the same preflight currently in `loopImpl` ([src/loop.ts](../../src/loop.ts))
  - `git rev-parse --is-inside-work-tree` succeeds.
  - Working tree clean (`Git.isClean()` / equivalent).
  - `user.name` and `user.email` are configured (commits require them).

### CLI integration

[src/util/load-cli-config.ts](../../src/util/load-cli-config.ts):

- Extend `BooleanField` union with `'doctor'`.
- Add `['doctor', 'doctor']` to `BOOLEAN_FLAGS` at line 38.
- Add `doctor?: boolean | undefined` to `ParsedArgs` at line 15.
- Propagate `doctor` through both return statements in `parseArgs()` (the
  short-circuit help/version path and the main path).
- Update `USAGE` string at line 28 to include `[--doctor]`.

[src/cli.ts](../../src/cli.ts):

- After `loadCliConfig(parsedArgs)`, branch on `parsedArgs.doctor === true`:
  ```ts
  if (parsedArgs.doctor === true) {
    const ok = await doctor(config);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  ```
- `--doctor` short-circuits the loop. `--dry-run` is ignored when `--doctor`
  is set (doctor uses the real configured agent so the probe is meaningful).
- Update the JSDoc usage block at lines 12-15.

### `doctor()` function

New file [src/doctor.ts](../../src/doctor.ts) exporting:

```ts
export async function doctor(config: LoopCliConfig): Promise<boolean>;
```

Behavior:

1. Instantiate agent, prompt generator, reporter. Wrap each `create*()`
   call in `try/catch`; an instantiation failure becomes a synthetic
   `fail` entry for that component (so doctor still reports the others).
2. For each component in fixed order (agent, promptGenerator, reporter,
   environment), invoke `check?.()` and `for await` over the yielded
   `CheckResult` values. Print each result to stdout the moment it
   arrives, prefixed with the component label - results stream live, not
   in grouped blocks. Missing `check` yields a single `skip` line "no
   diagnostics defined".
3. The environment checks are emitted by an internal `async function*`
   inside `doctor.ts` that the orchestrator drives the same way as the
   component generators.
4. Track running counts of `ok`/`warn`/`fail`/`skip` to print the final
   summary line after all generators finish.
5. Components run sequentially (not in parallel) so the streamed output
   stays readable and stable - one component finishes before the next
   begins. Within a component, the generator is free to interleave
   `await`s and `yield`s.
6. Use `console.log` for streaming output (matches the rest of cli.ts).
   Use the `Logger` only for verbose tracing of individual probes when
   `--verbose` is also set.
7. Return `true` iff zero `fail` entries observed (any number of `warn`
   / `skip` is acceptable).

### Output format

Plain text only (per user decision). No `--json` flag in this change.
The `CheckResult` shape is structured so JSON can be added later without
breaking changes.

Because results stream, each line stands on its own and carries enough
context (component kind + component name) to be readable without grouping
headers. The format is:

```
[<status>] <component-kind> (<component-name>): <check-name>[ - <message>]
```

A representative session:

```
Doctor: my-task

[ok]   agent (claude-sdk): SDK module loads
[ok]   agent (claude-sdk): ANTHROPIC_API_KEY set
[ok]   agent (claude-sdk): API probe (1 token) returned 200
[ok]   promptGenerator (github): token resolved from GITHUB_TOKEN
[fail] promptGenerator (github): GET /user - 401 Bad credentials
[ok]   reporter (yaml-report): /tmp/out is writable
[ok]   environment: outputDir writable
[skip] environment: resumable state file - none found
[skip] environment: git checks - allowSourceUpdate is false

Summary: 7 ok, 1 fail, 2 skip - 1 component has failures
```

Status tags are space-padded to a fixed width (`[ok]   `, `[warn] `,
`[fail]`, `[skip]`) so the columns line up. No emoji (AGENTS.md).
Failures include the cause's message inline; `--verbose` adds the full
stack via the existing logger.

## Files

New:

- `src/doctor.ts` - `CheckResult` type, `doctor()` orchestrator, text
  formatter, environment checks.
- `src/__test__/doctor.test.ts` - orchestration tests with fakes.

Modified (interface + flag wiring):

- `src/agents.ts` - add `Agent.check?`.
- `src/prompt-generators.ts` - add `PromptGenerator.check?`.
- `src/reporters.ts` - add `Reporter.check?`.
- `src/cli.ts` - dispatch to `doctor()`; update usage doc.
- `src/util/load-cli-config.ts` - parse `--doctor`; update `USAGE`.

Modified (per-implementation `check()` plus unit tests):

- `src/agents/claude-sdk.ts` + `__test__/claude-sdk.test.ts`
- `src/agents/openai-sdk.ts` + `__test__/openai-sdk.test.ts`
- `src/agents/codex-cli.ts` + `__test__/codex-cli.test.ts`
- `src/agents/test.ts` + `__test__/test-agent.test.ts`
- `src/prompt-generators/batch.ts` + `__test__/batch.test.ts`
- `src/prompt-generators/bugzilla.ts` + `__test__/bugzilla.test.ts`
- `src/prompt-generators/github.ts` + `__test__/github.test.ts`
- `src/prompt-generators/gitlab.ts` + `__test__/gitlab.test.ts`
- `src/prompt-generators/json.ts` + `__test__/json.test.ts`
- `src/prompt-generators/per-file.ts` + `__test__/per-file.test.ts`
- `src/prompt-generators/test.ts` + `__test__/test.test.ts`
- `src/reporters/yaml.ts` + `__test__/yaml.test.ts`
- `src/reporters/jsonl.ts` + `__test__/jsonl.test.ts`
- `src/__test__/load-cli-config.test.ts` - cover `--doctor` flag parsing.

## Schema

`schema/loop-the-loop.schema.json` describes the JSON config file, not CLI
flags. `--doctor` adds no new config keys. No schema change required.

## Reuse

- `Git.isClean()` and the `git rev-parse` preflight already implemented in
  `src/loop.ts` should be extracted into a small helper (or called via the
  existing `Git` wrapper) and reused by the environment-check section so
  doctor and loop stay in lockstep.
- Existing token-resolution code in
  `src/prompt-generators/github/github.ts` (token env-var lookup,
  `tokenEnv`/`token` config keys) is the source of truth for which env
  vars are inspected by the GitHub `check()`. Same pattern for GitLab.
- Reporter `create()` already calls `mkdir({ recursive: true })`; the
  reporter `check()` should call the same code path so the doctor's view
  matches what the loop would actually do.

## Verification

After implementation:

1. `pnpm tsc && pnpm test` - all unit tests including new ones pass with
   100% coverage maintained.
2. `pnpm lint` - clean.
3. `pnpm format` - no diff.
4. Manual smoke against a known-good config:
   ```sh
   node dist/cli.js --doctor examples/some-config.json
   ```
   Expect exit 0 and all `[ok]` for the components in use.
5. Manual smoke with a deliberately broken config:
   - Unset `GITHUB_TOKEN` and run `--doctor` against a github-backed config
     -> expect `[fail]` with a token-missing message and exit code 1.
   - Point `outputDir` at `/root/no-such-dir` -> expect environment check
     `[fail]` and exit code 1.
   - Set a config with `codex-cli` agent on a machine where `codex` is not
     installed -> expect `[fail]` on the binary check and exit 1.
6. Live API tests (`*-live.test.ts`) for github/gitlab/bugzilla/codex
   `check()` paths gated on env tokens, matching the existing convention.
