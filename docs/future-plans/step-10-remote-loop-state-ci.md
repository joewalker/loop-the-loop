# Step 10: Remote loop state for CI coordination

## Goal

Allow multiple CI runs or hosts to coordinate prompt claims and completions against a shared loop-state backend.

This is not a prerequisite for local pipeline budgets, branch parallelism, or the dashboard. It serves the distributed-run use case.

## Work

- Add a top-level `loopState` config block.
- Add an S3-compatible loop-state backend for claim, complete, release, and snapshot operations.
- Use optimistic concurrency with ETags.
- Keep the filesystem backend as the default for local runs.
- Add SIGINT and SIGTERM cleanup that releases the current run id on graceful interruption. This release is best-effort: async cleanup inside a Node signal handler is unreliable, so a hard crash or `kill -9` can leave the run's claims behind.
- Add unit tests with an injected S3 client and live tests gated behind MinIO environment variables.

## S3 backend

New `src/loop-states/s3.ts`, class `S3LoopState`, uses `@aws-sdk/client-s3` (`GetObjectCommand` / `PutObjectCommand`) with the whole state blob as the object body. Every `claim` / `complete` / `release` runs an optimistic-concurrency loop:

1. `GET` body and ETag, or treat `NoSuchKey` as empty state with no ETag.
2. Mutate state in memory.
3. `PUT` with `IfMatch: <etag>`, or `IfNoneMatch: '*'` when there was no prior ETag.
4. On `PreconditionFailed` (412), refetch and retry with exponential backoff plus jitter (50ms, 100ms, 200ms, capped at 5000ms), max 10 attempts, then throw a typed `LoopStateConflictError` carrying the runId and the operation name.
5. Auth and network errors are rethrown as-is.

Credentials come from the standard AWS SDK chain (env, shared config, IAM role), so CI needs no extra wiring. The constructor accepts an injected `S3Client` for tests; otherwise it builds one from the config.

## Config

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

Add `readonly loopState?: LoopStateSpec` to `LoopCliConfig`, defaulting to `'file'` writing `${outputDir}/${jobName}-loop-state.json` (today's behaviour). `createLoopState` (shaped in Step 01) registers the `s3` constructor. Schema gains a `loopStateSpec` mirroring `reporterSpec`, plus `fileLoopStateConfig` and `s3LoopStateConfig`.

## Run-id lifecycle

`loopImpl` generates `runId = crypto.randomUUID()` at startup (Step 01). One-shot SIGINT and SIGTERM handlers call `release(runId)`, and the main loop's `finally` also releases. Async cleanup inside a Node signal handler is unreliable, so this is best-effort.

The batch generator's passthrough state must forward `claim` / `complete` / `release` to the inner store and override `isOutstanding` to return `true`. Replace the `Object.create`-on-class approach with a plain forwarding object so the pluggable backends work through it.

## Dependencies

- Step 01, for the strict state backend contract.
- Step 04, because in-process claim behavior should be proven before extending the same model across hosts.

## Done when

- Two CI processes sharing the same remote state do not duplicate completed prompt ids.
- Losing a remote optimistic-concurrency race retries or fails clearly.
- Remote snapshots expose the same shape as local snapshots.
- Local filesystem behavior remains the default.

## Known limitations

- Stale-claim cleanup is best-effort only. Graceful SIGINT and SIGTERM release covers normal interruption, but a hard crash leaves the run's `claims` entries behind, and a stale claim blocks a later run from claiming that prompt id until it is cleared.
- Lease expiry and TTL-based stale-claim pruning are deliberately deferred. For this iteration, recovering from a hard crash is a manual operator cleanup task (remove the stale claims from the shared state), not an automatic feature.

## Out of scope

- GCS and Azure Blob backends. They use the same optimistic-concurrency model, so adding them later is mechanical, but only the S3-compatible backend ships here.
- Sharded state for very large jobs. The whole state blob is rewritten on every operation, which is fine up to a few tens of thousands of completed items; per-item keys with a manifest are a possible follow-up.
- Cross-process locking for the filesystem backend. It stays single-host; users needing multi-host coordination should use the S3 backend.

## Notes and risks

- `@aws-sdk/client-s3` adds roughly 1MB to installed size. The user adds the dependency interactively per AGENTS.md.
- R2 has had occasional ETag quirks on cross-region replication; any non-precondition error is treated as fatal and surfaced.

## Tests

- `src/loop-states/__test__/s3.test.ts` with an injected mock `S3Client`: GET 404 then PUT `IfNoneMatch: '*'` succeeds; GET body and ETag then PUT `IfMatch` succeeds; 412 once then retry succeeds (assert backoff with fake timers); 412 ten times throws `LoopStateConflictError`; an auth error on GET is rethrown unchanged.
- `src/loop-states/__test__/s3-live.test.ts` gated on `MINIO_ENDPOINT`, `MINIO_BUCKET`, and AWS credential env: the same scenarios against MinIO, plus two concurrent `claim` calls where exactly one wins.
- `loop.test.ts`: a lost-race case (a fake `LoopState` whose `claim` returns `false`) skips the prompt without calling the agent or reporter.
- `schema.test.ts`: `loopState` `'s3'` and `'file'` variants validate; `['s3', {}]` missing required fields fails.

## Files

- New `src/loop-states/s3.ts` and its tests.
- `src/types.ts`: `LoopStateSpec`, `S3LoopStateConfig`, and `loopState` on `LoopCliConfig`.
- `src/loop-states.ts`: register the `s3` constructor.
- `src/loop.ts`: install the SIGINT / SIGTERM release handlers.
- `src/prompt-generators/batch.ts`: the plain forwarding passthrough state.
- `package.json`: `@aws-sdk/client-s3` (the user adds it interactively).
- `schema/loop-the-loop.schema.json`: `loopStateSpec`, `fileLoopStateConfig`, `s3LoopStateConfig`.
