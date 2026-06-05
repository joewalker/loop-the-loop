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

## Related plans

- [Pluggable loop state for CI and concurrent runs](remote-loop-state.md)
