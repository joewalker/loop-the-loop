# Plan: pluggable loop state for CI and concurrent runs

## Context

Today loop state is persisted to a single JSON file in `outputDir` via [src/util/loop-state.ts](../../src/util/loop-state.ts). The current canonical shape is version 2: terminal outcomes live in `results`, active ownership lives in `claims`, and accumulated cost lives in `totalUsd`. The file is read on startup and fully rewritten on every state change. There is a `LoopState` interface in [src/loop-states.ts](../../src/loop-states.ts), but only the filesystem implementation exists today.

The goal is to let several CI runs, possibly concurrent across hosts, collaborate on the same claim and result state. The first remote backend is S3-compatible object storage (AWS S3, Cloudflare R2, MinIO), using ETag-based optimistic concurrency. The filesystem backend stays as the default with identical observable behavior to today's code.

Related plan: [concurrency.md](concurrency.md) covers in-process parallelism (N prompts in flight from a single process). The two are complementary and share the same state model. In-process workers and cross-process runners both call `claim(runId, id)` before doing work and `complete(runId, id, result)` afterwards. The only difference is where optimistic concurrency is enforced: the filesystem backend serializes writes inside one process, while the S3 backend uses object ETags across processes and hosts.

User-confirmed design decisions:

- First remote backend: S3-compatible (S3, R2, MinIO). No GCS or Azure in this iteration.
- Concurrency model: `claims` is the active ownership map, keyed by prompt id with a `runId` value.
- Config surface: a new top-level `loopState` block on `LoopCliConfig`, defaulting to filesystem.
- AWS SDK: use `@aws-sdk/client-s3` rather than hand-rolling SigV4 or pulling a tiny dep.
- Method naming on the new interface: `claim` / `complete` / `release`.
- Live tests against MinIO behind env-var gating, mirroring the project's `*-live.test.ts` pattern.
- Include a SIGINT/SIGTERM cleanup handler that calls `release(runId)` on graceful exit. No automatic stale-claim pruning in this iteration. No formal version migration beyond permissive loading of old local state files.

## Design

### `LoopState` interface

The existing module [src/loop-states.ts](../../src/loop-states.ts) mirrors the structure of [src/reporters.ts](../../src/reporters.ts):

```ts
export interface LoopState {
  isOutstanding(id: string): boolean;
  claim(runId: string, id: string): Promise<boolean>;
  complete(runId: string, id: string, result: LoopStateResult): Promise<void>;
  release(runId: string): Promise<void>;
  getSnapshot(): Promise<LoopStateSnapshot>;
}
```

Semantics:

- `isOutstanding(id)` returns true unless `id` exists in `results`. It does not consult `claims`; prompt generators should only use it to skip terminal outcomes.
- `claim(runId, id)` is the atomic race-arbiter. Returns `false` when the id already has a terminal outcome in `results`, when another run owns `claims[id]`, or when the underlying optimistic-concurrency write loses too many retries. Returns `true` after recording or confirming the claim for this run.
- `complete(runId, id, result)` records terminal `success` / `error` outcomes in `results`, adds priced cost to `totalUsd`, and removes `claims[id]`. Glitches add priced cost but do not create a terminal outcome, so the id remains outstanding.
- `release(runId)` clears every claim whose value has that `runId`. Idempotent. Called from the loop's `finally` and from SIGINT/SIGTERM handlers.
- `getSnapshot()` returns the canonical persisted shape for readers, budget checks, and diagnostics without exposing backend-specific storage.

### Persisted shape

```json
{
  "version": 2,
  "results": {
    "id-a": { "status": "success" },
    "id-c": { "status": "error", "reason": "..." }
  },
  "claims": {
    "id-b": { "runId": "<runId>", "claimedAt": "2026-06-03T12:00:00.000Z" }
  },
  "totalUsd": 0
}
```

Loader compatibility is one-way. If old `completed` / `failed` arrays are present and `results` is absent, build `results` from them. If old `inProgress` values are present, ignore them; they were resume hints, not cross-process claims. New writes always use `results`, `claims`, and `totalUsd`.

### Filesystem backend

Move the current filesystem implementation to [src/loop-states/file.ts](../../src/loop-states/file.ts), class `FileLoopState`. Same JSON file as today and same canonical v2 shape. Writes go to `${path}.tmp` then `rename` to `${path}` so a crashed write never leaves a half-written file. Internal save serialization (`#saveChain: Promise<void>`) so concurrent in-process `claim`/`complete` calls do not race on `writeFile`. Documented as single-host; multi-host filesystem sharing is out of scope.

### S3 backend

New file [src/loop-states/s3.ts](../../src/loop-states/s3.ts), class `S3LoopState`. Uses `@aws-sdk/client-s3` via `GetObjectCommand` and `PutObjectCommand`. The whole state blob is the S3 object body. Optimistic concurrency loop on every `claim` / `complete` / `release`:

1. `GetObjectCommand` to fetch body and ETag, or treat `NoSuchKey` as empty state with no ETag.
2. Mutate state in memory.
3. `PutObjectCommand` with `IfMatch: <etag>`, or `IfNoneMatch: '*'` when there was no prior ETag.
4. On `PreconditionFailed` (412), refetch and retry. Exponential backoff with jitter: 50ms, 100ms, 200ms, capped at 5000ms. Max 10 attempts, then throw a typed `LoopStateConflictError` that includes the runId and the operation name.
5. Auth and network errors are rethrown as-is.

Credentials come from the standard AWS SDK credential chain (env, shared config, IAM role) so CI does not need any extra wiring or config keys. Endpoint, region, bucket, and key are configurable.

### Config schema

Add `LoopStateSpec` to [src/types.ts](../../src/types.ts):

```ts
export type LoopStateSpec =
  | 'file'
  | ['file', { readonly path?: string }]
  | ['s3', S3LoopStateConfig];

export interface S3LoopStateConfig {
  readonly bucket: string;
  readonly key: string;
  readonly endpoint?: string;
  readonly region?: string;
  readonly forcePathStyle?: boolean;
}
```

Add `readonly loopState?: LoopStateSpec` to `LoopCliConfig` next to `reporter`. Default = `'file'` with path `join(outputDir, ${jobName}-loop-state.json)`, which preserves today's behavior byte-for-byte.

`createLoopState(spec, { outputDir, jobName }): Promise<LoopState>` lives in [src/loop-states.ts](../../src/loop-states.ts) and mirrors `createReporter`.

Update [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json) with a `loopStateSpec` definition (tuple shape mirroring `reporterSpec`) plus `fileLoopStateConfig` and `s3LoopStateConfig` definitions.

### Run-id lifecycle

`loopImpl` generates `const runId = crypto.randomUUID()` at startup. The main loop becomes:

```ts
const loopState = await createLoopState(
  config.loopState ?? 'file',
  { outputDir, jobName: name },
);
const cleanup = () => { void loopState.release(runId); };
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
try {
  for await (const prompt of promptGenerator.generate(loopState)) {
    if (!(await loopState.claim(runId, prompt.id))) {
      logger.state(`Skip (claimed elsewhere): ${prompt.id}`);
      continue;
    }
    // invoke agent, append to reporter, complete()
    await loopState.complete(runId, prompt.id, result);
  }
} finally {
  process.off('SIGINT', cleanup);
  process.off('SIGTERM', cleanup);
  await loopState.release(runId);
}
```

Signal-handler cleanup is best-effort. A stale `claims` entry can block a later run from claiming that prompt id, so this plan relies on graceful `release(runId)` for normal interruption cleanup and documents manual state cleanup for hard crashes. Lease expiry and stale-claim pruning are deferred.

### PromptGenerator interface

Keep the parameter type as the `LoopState` interface from [src/loop-states.ts](../../src/loop-states.ts). The method signature is unchanged because generators only call `isOutstanding`. The batch generator currently builds a passthrough via `Object.create` on the class; replace with a plain object that forwards `claim`/`complete`/`release`/`isOutstanding` and overrides `isOutstanding` to return `true`. Forwarded methods bind `this` to the original state object.

## Files to modify

### 1. Types - [src/types.ts](../../src/types.ts)

Add `LoopStateSpec`, `S3LoopStateConfig`, and `readonly loopState?: LoopStateSpec` on `LoopCliConfig`.

### 2. JSON schema - [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json)

Add `loopStateSpec`, `fileLoopStateConfig`, `s3LoopStateConfig` definitions. Reference `loopStateSpec` from the top-level `properties`.

### 3. Factory module - [src/loop-states.ts](../../src/loop-states.ts)

Extend the existing `LoopState` interface and `createLoopState` factory with an internal `loopStateConstructors` map (`'file'` and `'s3'` keys), plus a `LoopStateSpec` re-export. Same shape as [src/reporters.ts](../../src/reporters.ts).

### 4. Filesystem backend - new [src/loop-states/file.ts](../../src/loop-states/file.ts)

`FileLoopState` with `#path`, `#results: Map<string, PromptOutcome>`, `#claims: Map<string, PromptClaim>`, `#totalUsd`, and `#saveChain`. Static async `create({ path })`. Tmp-file rename for atomicity. Permissive load migrates old `completed` / `failed` arrays into `results` and ignores old `inProgress`.

### 5. S3 backend - new [src/loop-states/s3.ts](../../src/loop-states/s3.ts)

`S3LoopState` with an `S3Client` field. Constructor accepts `{ s3Client?: S3Client }` to allow tests to inject a mock; default constructs a real client from `S3LoopStateConfig`. Retry helper `#runWithRetry(label, mutate)` that wraps the GET/PUT loop.

### 6. Runtime - [src/loop.ts](../../src/loop.ts)

- Replace `createLoopState(path)` with `createLoopState(config.loopState ?? 'file', { outputDir, jobName: name })`.
- Generate `runId` via `crypto.randomUUID()`.
- Install one-shot SIGINT and SIGTERM listeners that call `loopState.release(runId)`.
- Wrap the main `for await` in `try { ... } finally { off; await loopState.release(runId); }`.
- Keep the existing claim-or-skip pattern, and route all state reads needed by diagnostics or budget checks through `getSnapshot()`.

### 7. PromptGenerator interface - [src/prompt-generators.ts](../../src/prompt-generators.ts)

Refresh the JSDoc to note that under cross-process collaboration, `isOutstanding(id)` reflects terminal outcomes only; generators must not assume that another runner has not already claimed an outstanding id.

### 8. Prompt generators

Six generators only need an import-name change: [github.ts](../../src/prompt-generators/github.ts), [per-file.ts](../../src/prompt-generators/per-file.ts), [json.ts](../../src/prompt-generators/json.ts), [bugzilla.ts](../../src/prompt-generators/bugzilla.ts), [gitlab.ts](../../src/prompt-generators/gitlab.ts), [test.ts](../../src/prompt-generators/test.ts).

[batch.ts](../../src/prompt-generators/batch.ts) needs more: replace `makePassthroughLoopState` so that it builds a plain object rather than using `Object.create` on a class. The passthrough forwards `claim`, `complete`, `release` to the inner store and overrides `isOutstanding` to return `true`.

### 9. CLI loader - [src/util/load-cli-config.ts](../../src/util/load-cli-config.ts)

If `loopState` requires `outputDir`-relative path resolution for the `file` variant (matching how `outputDir` itself is resolved), normalize it here. No new CLI flag.

### 10. Package - [package.json](../../package.json)

Add `@aws-sdk/client-s3` to `dependencies`. Per AGENTS.md the user runs `pnpm add` interactively; do not run it from the agent.

### 11. Delete after migration

- [src/util/loop-state.ts](../../src/util/loop-state.ts)
- [src/util/__test__/loop-state.test.ts](../../src/util/__test__/loop-state.test.ts) - port the cases to `file.test.ts`.

## Tests

New tests to add:

- `src/loop-states/__test__/file.test.ts`: port the existing `loop-state.test.ts` cases (load empty, migrate old completed / failed arrays, glitch leaves outstanding, malformed JSON throws, nested directory creation). Add: two runs with different runIds both call `claim` on the same id, second returns `false`; `release(runId)` is idempotent; old `inProgress` is ignored on load; tmp-file rename leaves the original intact when the rename step is intercepted.

- `src/loop-states/__test__/s3.test.ts`: unit tests with an injected mock `S3Client`. Cases: GET 404 then PUT with `IfNoneMatch: '*'` succeeds; GET returns body and ETag then PUT with `IfMatch: <etag>` succeeds; PUT returns 412 once then succeeds on retry (assert backoff timing with fake timers); PUT returns 412 ten times and the operation throws `LoopStateConflictError`; auth error on GET is rethrown unchanged.

- `src/loop-states/__test__/s3-live.test.ts`: file-level `// @module-tag live`. Reads `MINIO_ENDPOINT`, `MINIO_BUCKET`, AWS credential env, and skips when any are absent. Exercises the same scenarios as the unit tests but against MinIO, and a final case that runs two concurrent `claim` calls and asserts exactly one returns true.

- `src/__test__/loop.test.ts`: extend with a "lost race" case using a fake `LoopState` whose `claim` returns `false`; assert the loop skips the prompt without calling the agent or reporter.

Existing tests that must be updated:

- [src/util/__test__/loop-state.test.ts](../../src/util/__test__/loop-state.test.ts) is being moved; any tests that still assert old `completed` / `failed` / `inProgress` writes should instead assert the canonical `results` / `claims` / `totalUsd` snapshot.

- `schema.test.ts`: validate a config that sets `loopState: ['s3', { bucket: 'b', key: 'k' }]` and a config that sets `loopState: 'file'` and one that sets `loopState: ['file', { path: 'state.json' }]`. Reject `loopState: ['s3', {}]` (missing required fields).

The existing tests use a default `loopState`, so most do not need changes beyond the import-name rename in prompt generators.

## Out of scope

- GCS and Azure Blob backends. They use the same optimistic-concurrency model, so adding them later is mechanical.
- Sharded state for very large jobs. The whole state blob is rewritten on every operation; this is fine up to a few tens of thousands of completed items. A follow-up could introduce per-item keys with a manifest.
- Automatic stale-claim pruning with leases or TTLs. A stale `claims` entry can block work; manual cleanup is acceptable for this iteration.
- Cross-process locking for the filesystem backend. Single-host only; users who need multi-host should use S3.
- Schema versioning beyond the single permissive load described above.

## Verification

After implementing:

1. `pnpm tsc && pnpm test` - all tests pass, including the new file and S3 unit tests; live S3 tests skip when env vars are absent.
2. `pnpm lint` - clean.
3. `pnpm format` - no diff.
4. Coverage stays at 100%; istanbul ignores only on `S3Client` construction paths that cannot be hit without an injected client.
5. Manual smoke:
   - Run an existing JSON config that omits `loopState` and confirm the on-disk file uses `results`, `claims`, and `totalUsd`. While a prompt is mid-flight, `claims` contains an entry for that prompt id with the current `runId`.
   - Run a config with `loopState: ['s3', { bucket: '<b>', key: '<k>', endpoint: '<minio>', forcePathStyle: true }]` against a local MinIO and verify the bucket object updates after each prompt.
   - Start two `loop-the-loop` processes concurrently against the same MinIO bucket and key with overlapping work. Confirm completed items are not duplicated, and one process logs `Skip (claimed elsewhere)` for items the other claims first.
   - Interrupt a running process mid-prompt with Ctrl-C and verify the SIGINT handler removes that runId from `claims`. A subsequent run picks up the unfinished item.

## Notes and risks

- `@aws-sdk/client-s3` adds roughly 1MB to installed size. Real cost for a project with four production deps today, accepted per the user choice. The alternative was a hand-rolled SigV4 (about 120 lines) or `aws4fetch` (3KB).
- R2 historically had occasional ETag quirks on cross-region replication. We treat any non-precondition error as fatal and surface it. R2 live tests would be useful but are out of scope.
- The full state blob is rewritten on every operation. A 10k-item `results` object is around a few hundred KB, still cheap. Beyond 50k items, consider sharded keys.
- Signal-handler cleanup uses `process.once('SIGINT' | 'SIGTERM', ...)` and is best-effort. Async cleanup inside a signal handler is unreliable in Node. Hard crashes can leave stale claims, which this plan treats as an operator cleanup problem rather than adding leases in the first S3 backend.
- The interaction with [concurrency.md](concurrency.md) is intentional: both plans share the `claims` map. In-process concurrency stores multiple prompt ids claimed by the same runId; cross-process concurrency stores prompt ids claimed by different runIds.
