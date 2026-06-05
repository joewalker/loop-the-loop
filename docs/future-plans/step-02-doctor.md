# Step 02: `--doctor`

## Goal

Give users a preflight command that validates the configured agent, prompt generator, reporter, output directory, git requirements, and state file before the loop spends time or tokens.

The mental model is `gh auth status` / `glab auth status`: a self-diagnostic that turns silent runtime failures into a single readable up-front report. `--doctor` exits 0 when everything passes and 1 when any check fails, and never invokes the main loop. When `--doctor` is set, `--dry-run` is ignored, because the probe is only meaningful against the real configured components.

## Work

- Add an optional `check()` capability to agents, prompt generators, and reporters.
- Add `doctor(config)` to instantiate configured components and stream structured check results to stdout.
- Add the `--doctor` CLI flag.
- Run cross-cutting checks for output directory write access, state file readability, and source-update git prerequisites.
- Keep checks sequential so output remains deterministic and readable.

## Check capability

Each of the three core interfaces gains an optional `check(): AsyncIterable<CheckResult>`. Results are yielded one at a time so a slow probe does not block earlier fast probes from printing, mirroring the existing `PromptGenerator.generate()` streaming pattern. All three are optional so external and test implementations stay valid.

```ts
// src/doctor.ts (new file)
export interface CheckResult {
  readonly name: string;                         // "ANTHROPIC_API_KEY set"
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly message?: string;                     // human detail or error text
  readonly cause?: unknown;                      // underlying error if any
}
```

Implementations are written as `async function* check()` and may `await` between yields. A probe that throws yields a synthetic `fail` rather than propagating, so one failed probe does not abort the rest of that component's checks. `doctor()` yields a single `skip` for any component that omits `check()` ("no diagnostics defined"), so a missing check reads as skipped, never as success.

## Per-implementation probes

Agent probe depth is a cheap real API call where one exists.

- claude-sdk: SDK module loads; `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` present; `outputSchema`, `model`, and tool-list shape valid; a minimal 1-token `query()` probe, surfacing network/auth failures as `fail`.
- openai-sdk: SDK module loads; `OPENAI_API_KEY` present; `model`, `modelSettings`, schema shape valid; `openai.models.list()` as a read-only probe.
- codex-cli: `codex` binary resolvable on PATH; `CODEX_MODEL` set; `timeoutMs` a positive integer; `codex --version` reported.
- test: `responses` non-empty; trivially `ok`.

Prompt generators:

- batch: recursively delegate `check()` to each child source, prefixing names with `source[i].`.
- bugzilla: API key resolvable; `GET /rest/whoami` authenticates.
- github: token resolvable from `GITHUB_TOKEN` / `GH_TOKEN` or `tokenEnv` / `token`; `GET /user` returns 200.
- gitlab: token resolvable from `GITLAB_TOKEN` / `GL_TOKEN` or `tokenEnv` / `token`; `GET /user` against the configured origin returns 200.
- json: configured `dataFile` exists and is readable; inline `data` is trivially `ok`.
- jsonl / loop-state (Step 05): the handoff `dataFile` / `stateFile` exists and resolves to the right format, mirroring the `json` check.
- per-file: glob resolves with `globSync({ nodir: true })`; `warn` on zero matches; `fail` on invalid glob syntax.
- test: trivially `ok`.

Reporters (yaml, jsonl): `outputDir` writable via `fs.access(dir, W_OK)`; the target report file is appendable, calling the same `mkdir({ recursive: true })` path `create()` uses so the doctor view matches what the loop would do.

## Cross-cutting environment checks

`doctor()` emits an `environment` component covering:

- Output directory writable (`fs.access(config.outputDir, W_OK)`), checked independently of the reporter so a bad `outputDir` surfaces even with no reporter configured.
- Resumable state: if `${outputDir}/${name}-loop-state.json` exists, load it under the strict Step 01 contract; `fail` on a malformed or non-v2 file, `ok` otherwise, `skip` when absent.
- Git working tree, only when `allowSourceUpdate === true`: reuse the same preflight as `loopImpl` (`git rev-parse --is-inside-work-tree`, clean tree, `user.name` / `user.email` configured for commits). Extract that preflight into a shared helper so doctor and loop stay in lockstep.

## Output format

Plain text only; results stream live, each line self-contained:

```
[<status>] <component-kind> (<component-name>): <check-name>[ - <message>]
```

Status tags are space-padded to a fixed width (`[ok]   `, `[warn] `, `[fail]`, `[skip]`) so columns line up; no emoji (AGENTS.md). A trailing summary line counts `ok` / `warn` / `fail` / `skip`. Components run sequentially so the stream stays readable. `--verbose` adds the full cause stack via the existing logger. The `CheckResult` shape is structured so a `--json` mode can be added later without breaking changes.

## Dependencies

- Step 01, so state checks validate the strict state contract and can report malformed state files clearly.

## Done when

- `--doctor` exits 0 when all checks pass and 1 when any check fails.
- Missing optional checks are reported as `skip`, not as success.
- Real external probes are cheap and read-only where possible.
- Component construction failures are reported without preventing unrelated checks from running.

## Tests

- `src/__test__/doctor.test.ts`: orchestration with fakes; a component whose `check()` throws yields a synthetic `fail`; a component without `check()` yields one `skip`; a construction failure of one component still runs the others; the boolean return is `false` iff any `fail` was observed.
- Per-implementation unit tests for each agent, generator, and reporter `check()`.
- `--doctor` flag parsing in `load-cli-config.test.ts`.
- Live API tests (`*-live.test.ts`) for github / gitlab / bugzilla / codex `check()` gated on env tokens, matching the existing convention.

## Files

- New `src/doctor.ts` (the `CheckResult` type, `doctor()` orchestrator, text formatter, environment checks) and `src/__test__/doctor.test.ts`.
- `src/agents.ts`, `src/prompt-generators.ts`, `src/reporters.ts`: add the optional `check?`.
- `src/cli.ts`: dispatch to `doctor()` on `--doctor`; update the usage doc.
- `src/util/load-cli-config.ts`: parse `--doctor`; extend `USAGE`.
- Each agent, generator, and reporter implementation plus its test.

`--doctor` adds no config key, so `schema/loop-the-loop.schema.json` does not change.
