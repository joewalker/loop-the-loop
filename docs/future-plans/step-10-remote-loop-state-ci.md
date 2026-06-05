# Step 10: Remote loop state for CI coordination

## Goal

Allow multiple CI runs or hosts to coordinate prompt claims and completions against a shared loop-state backend.

This is not a prerequisite for local pipeline budgets, branch parallelism, or the dashboard. It serves the distributed-run use case.

## Work

- Add a top-level `loopState` config block.
- Add an S3-compatible loop-state backend for claim, complete, release, and snapshot operations.
- Use optimistic concurrency with ETags.
- Keep the filesystem backend as the default for local runs.
- Add SIGINT and SIGTERM cleanup that releases the current run id on graceful interruption.
- Add unit tests with an injected S3 client and live tests gated behind MinIO environment variables.

## Dependencies

- Step 01, for the strict state backend contract.
- Step 04, because in-process claim behavior should be proven before extending the same model across hosts.

## Done when

- Two CI processes sharing the same remote state do not duplicate completed prompt ids.
- Losing a remote optimistic-concurrency race retries or fails clearly.
- Remote snapshots expose the same shape as local snapshots.
- Local filesystem behavior remains the default.

## Related plans

- [Pluggable loop state for CI and concurrent runs](remote-loop-state.md)
