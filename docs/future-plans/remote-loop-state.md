# Plan: pluggable loop state for CI and concurrent runs

## Context

Today loop state (`completed`, `failed`, `inProgress`) is persisted to a single JSON file in `outputDir` via [src/util/loop-state.ts](../../src/util/loop-state.ts). The file is read on startup and fully rewritten on every `begin`/`end`. There is no abstraction layer, no atomicity beyond a single-host write, and no way for multiple concurrent runs to share progress.

The goal is to let several CI runs, possibly concurrent across hosts, collaborate on the same in-progress and completed state. The first remote backend is S3-compatible object storage (AWS S3, Cloudflare R2, MinIO), using ETag-based optimistic concurrency. The filesystem backend stays as the default with identical observable behavior to today's code.

Related plan: [concurrency.md](concurrency.md) covers in-process parallelism (N prompts in flight from a single process). The two are complementary. To keep both lines of work landable in either order, this plan adopts an `inProgress` shape of `Record<runId, Array<itemId>>`: the outer map covers the cross-process collaboration case, and the inner array covers the in-process pool case. The concurrency plan's `inProgress: Array<string>` becomes a single key in this richer map.

User-confirmed design decisions:

- First remote backend: S3-compatible (S3, R2, MinIO). No GCS or Azure in this iteration.
- Concurrency model: `inProgress` becomes a map keyed by a per-run UUID.
- Config surface: a new top-level `loopState` block on `LoopCliConfig`, defaulting to filesystem.
- AWS SDK: use `@aws-sdk/client-s3` rather than hand-rolling SigV4 or pulling a tiny dep.
- Method naming on the new interface: `claim` / `complete` / `release`.
- Live tests against MinIO behind env-var gating, mirroring the project's `*-live.test.ts` pattern.
- Include a SIGINT/SIGTERM cleanup handler that calls `release(runId)` on graceful exit. No stale-claim pruning. No formal version migration for older state files (single-field permissive parse only).

## Design

### `LoopStateStore` interface

A new module [src/loop-states.ts](../../src/loop-states.ts) mirrors the structure of [src/reporters.ts](../../src/reporters.ts):

```ts
export interface LoopStateStore {
  isOutstanding(id: string): boolean;
  claim(runId: string, id: string): Promise<boolean>;
  complete(runId: string, id: string, result: InvokeResult): Promise<void>;
  release(runId: string): Promise<void>;
}
```

Semantics:

- `isOutstanding(id)` returns true unless `id` is in `completed` or `failed`. It does not consult the in-progress map; race arbitration is `claim()`'s job. Without this rule, prompt generators would spuriously skip items that another run might release.
- `claim(runId, id)` is the atomic race-arbiter. Returns `false` when another run has already completed or failed the item, or when the underlying optimistic-concurrency write loses too many retries. Returns `true` after recording the new claim.
- `complete(runId, id, result)` pushes to `completed` or `failed` per the `InvokeResult` status (glitch leaves the item outstanding, matching today), then removes the entry from `inProgress[runId]`.
- `release(runId)` clears `inProgress[runId]` entirely. Idempotent. Called from the loop's `finally` and from SIGINT/SIGTERM handlers.

### Persisted shape

```json
{
  "version": 2,
  "completed": ["id-a", "id-b"],
  "failed": [{ "id": "id-c", "reason": "..." }],
  "inProgress": { "<runId>": ["<itemId>", "<itemId>"] }
}
```

Loader is permissive on a single point: if `inProgress` is a string (v1, single-process serial) or an array (the shape proposed in [concurrency.md](concurrency.md) before this plan lands), it is dropped on load. `completed` and `failed` shapes are unchanged so older files load cleanly aside from that one field. No formal migration system.

### Filesystem backend

New file [src/loop-states/file.ts](../../src/loop-states/file.ts), class `FileLoopStateStore`. Same JSON file as today. Writes go to `${path}.tmp` then `rename` to `${path}` so a crashed write never leaves a half-written file. Internal save serialization (`#saveChain: Promise<void>`) so concurrent in-process `claim`/`complete` calls do not race on `writeFile`. Documented as single-host; multi-host filesystem sharing is out of scope.

### S3 backend

New file [src/loop-states/s3.ts](../../src/loop-states/s3.ts), class `S3LoopStateStore`. Uses `@aws-sdk/client-s3` via `GetObjectCommand` and `PutObjectCommand`. The whole state blob is the S3 object body. Optimistic concurrency loop on every `claim` / `complete` / `release`:

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

`createLoopState(spec, { outputDir, jobName }): Promise<LoopStateStore>` lives in [src/loop-states.ts](../../src/loop-states.ts) and mirrors `createReporter`.

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

Signal-handler cleanup is best-effort. Stale in-progress entries are cosmetic only because race arbitration is at `claim` time, not based on in-progress presence.

### PromptGenerator interface

Rename the parameter type from `LoopState` to `LoopStateStore`. The method signature is unchanged because generators only call `isOutstanding`. The batch generator currently builds a passthrough via `Object.create` on the class; replace with a plain object that forwards `claim`/`complete`/`release`/`isOutstanding` and overrides `isOutstanding` to return `true`. Forwarded methods bind `this` to the original store.

## Files to modify

### 1. Types - [src/types.ts](../../src/types.ts)

Add `LoopStateSpec`, `S3LoopStateConfig`, and `readonly loopState?: LoopStateSpec` on `LoopCliConfig`.

### 2. JSON schema - [schema/loop-the-loop.schema.json](../../schema/loop-the-loop.schema.json)

Add `loopStateSpec`, `fileLoopStateConfig`, `s3LoopStateConfig` definitions. Reference `loopStateSpec` from the top-level `properties`.

### 3. Factory module - new [src/loop-states.ts](../../src/loop-states.ts)

`LoopStateStore` interface, `createLoopState` factory, internal `loopStateConstructors` map (`'file'` and `'s3'` keys), `LoopStateSpec` re-export. Same shape as [src/reporters.ts](../../src/reporters.ts).

### 4. Filesystem backend - new [src/loop-states/file.ts](../../src/loop-states/file.ts)

`FileLoopStateStore` with `#path`, `#completed`, `#failed`, `#inProgress: Map<string, Array<string>>`, `#saveChain`. Static async `create({ path })`. tmp-file rename for atomicity. Permissive load that drops a non-object `inProgress`.

### 5. S3 backend - new [src/loop-states/s3.ts](../../src/loop-states/s3.ts)

`S3LoopStateStore` with an `S3Client` field. Constructor accepts `{ s3Client?: S3Client }` to allow tests to inject a mock; default constructs a real client from `S3LoopStateConfig`. Retry helper `#runWithRetry(label, mutate)` that wraps the GET/PUT loop.

### 6. Runtime - [src/loop.ts](../../src/loop.ts)

- Replace `LoopState.create(path)` with `createLoopState(config.loopState ?? 'file', { outputDir, jobName: name })`.
- Generate `runId` via `crypto.randomUUID()`.
- Install one-shot SIGINT and SIGTERM listeners that call `loopState.release(runId)`.
- Wrap the main `for await` in `try { ... } finally { off; await loopState.release(runId); }`.
- Replace `await loopState.begin(prompt.id)` with the claim-or-skip pattern shown above, and `await loopState.end(prompt.id, result)` with `await loopState.complete(runId, prompt.id, result)`.

### 7. PromptGenerator interface - [src/prompt-generators.ts](../../src/prompt-generators.ts)

Change the `LoopState` import to `LoopStateStore` and update the `generate(loopState: LoopStateStore)` type. Refresh the JSDoc to note that under cross-process collaboration, `isOutstanding(id)` reflects completed and failed items only; generators must not assume that another runner has not already claimed an outstanding id.

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

- `src/loop-states/__test__/file.test.ts`: port the existing `loop-state.test.ts` cases (load empty, load failed, load completed, glitch leaves outstanding, malformed JSON throws, nested directory creation). Add: two runs with different runIds both call `claim` on the same id, second returns `false`; `release(runId)` is idempotent; `complete` after `release` is a no-op; tmp-file rename leaves the original intact when the rename step is intercepted.

- `src/loop-states/__test__/s3.test.ts`: unit tests with an injected mock `S3Client`. Cases: GET 404 then PUT with `IfNoneMatch: '*'` succeeds; GET returns body and ETag then PUT with `IfMatch: <etag>` succeeds; PUT returns 412 once then succeeds on retry (assert backoff timing with fake timers); PUT returns 412 ten times and the operation throws `LoopStateConflictError`; auth error on GET is rethrown unchanged.

- `src/loop-states/__test__/s3-live.test.ts`: file-level `// @module-tag live`. Reads `MINIO_ENDPOINT`, `MINIO_BUCKET`, AWS credential env, and skips when any are absent. Exercises the same scenarios as the unit tests but against MinIO, and a final case that runs two concurrent `claim` calls and asserts exactly one returns true.

- `src/__test__/loop.test.ts`: extend with a "lost race" case using a fake `LoopStateStore` whose `claim` returns `false`; assert the loop skips the prompt without calling the agent or reporter.

Existing tests that must be updated:

- [src/util/__test__/loop-state.test.ts](../../src/util/__test__/loop-state.test.ts) is being removed; assertions referencing the v1 `inProgress: 'active-item'` string in `loop.test.ts` (around lines ~332-362, the "keep the prompt outstanding if writing the report fails" case) need updating to the new map shape.

- `schema.test.ts`: validate a config that sets `loopState: ['s3', { bucket: 'b', key: 'k' }]` and a config that sets `loopState: 'file'` and one that sets `loopState: ['file', { path: 'state.json' }]`. Reject `loopState: ['s3', {}]` (missing required fields).

The existing tests use a default `loopState`, so most do not need changes beyond the import-name rename in prompt generators.

## Out of scope

- GCS and Azure Blob backends. They use the same optimistic-concurrency model, so adding them later is mechanical.
- Sharded state for very large jobs. The whole state blob is rewritten on every operation; this is fine up to a few tens of thousands of completed items. A follow-up could introduce per-item keys with a manifest.
- Stale-claim pruning with leases or TTLs. Stale `inProgress` entries are cosmetic because race arbitration is at `claim` time.
- Cross-process locking for the filesystem backend. Single-host only; users who need multi-host should use S3.
- Schema versioning beyond the single permissive load described above.

## Verification

After implementing:

1. `pnpm tsc && pnpm test` - all tests pass, including the new file and S3 unit tests; live S3 tests skip when env vars are absent.
2. `pnpm lint` - clean.
3. `pnpm format` - no diff.
4. Coverage stays at 100%; istanbul ignores only on `S3Client` construction paths that cannot be hit without an injected client.
5. Manual smoke:
   - Run an existing JSON config that omits `loopState` and confirm the on-disk file is identical in `completed`/`failed` to today's shape, with `inProgress` now an object keyed by a UUID while a prompt is mid-flight.
   - Run a config with `loopState: ['s3', { bucket: '<b>', key: '<k>', endpoint: '<minio>', forcePathStyle: true }]` against a local MinIO and verify the bucket object updates after each prompt.
   - Start two `loop-the-loop` processes concurrently against the same MinIO bucket and key with overlapping work. Confirm completed items are not duplicated, and one process logs `Skip (claimed elsewhere)` for items the other claims first.
   - Kill a running process mid-prompt (Ctrl-C) and verify the SIGINT handler removes that runId from `inProgress`. A subsequent run picks up the unfinished item.

## Notes and risks

- `@aws-sdk/client-s3` adds roughly 1MB to installed size. Real cost for a project with four production deps today, accepted per the user choice. The alternative was a hand-rolled SigV4 (about 120 lines) or `aws4fetch` (3KB).
- R2 historically had occasional ETag quirks on cross-region replication. We treat any non-precondition error as fatal and surface it. R2 live tests would be useful but are out of scope.
- The full state blob is rewritten on every operation. A 10k-item completed array is around 200KB, still cheap. Beyond 50k items, consider sharded keys.
- Signal-handler cleanup uses `process.once('SIGINT' | 'SIGTERM', ...)` and is best-effort. Async cleanup inside a signal handler is unreliable in Node; correctness does not depend on it because `claim` resolves races on its own.
- The interaction with [concurrency.md](concurrency.md) is intentional: that plan's `inProgress: Array<string>` becomes the single inner array for one runId in this plan's map. Either plan can land first; the second lander updates the loader's permissive parse to drop the prior shape and writes the new shape.
