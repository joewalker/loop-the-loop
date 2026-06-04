# Step 11: S3-backed pipeline handoff

## Goal

Let pipeline reader generators consume upstream reports or state snapshots
from S3-backed storage when pipeline steps do not share a local output
directory.

This is intentionally last because local artifact handoff covers the common
case, and distributed handoff has lower product value than local pipelines,
budgets, parallelism, dashboard, and CI claim coordination.

## Work

- Extend handoff substitutions so `{{steps.review.report}}` and
  `{{steps.review.state}}` can resolve to remote artifact locations.
- Add reader support for S3-backed JSONL reports.
- Add reader support for remote loop-state snapshots through the loop-state
  backend abstraction rather than direct local `readFile`.
- Define how pipeline steps publish report artifacts to S3 if the reporter is
  still local-only.
- Decide whether this requires remote reporters, artifact upload after each
  step, or both.
- Add authentication and diagnostic checks through `--doctor`.

## Dependencies

- Step 05, for local reader generators and handoff substitutions.
- Step 06, for pipeline orchestration.
- Step 10, for remote state backend configuration and snapshot access.

## Done when

- A pipeline can run steps on hosts that do not share a filesystem and still
  pass upstream data to downstream readers.
- Local handoff behavior remains unchanged.
- Missing, malformed, or unauthorized remote artifacts fail clearly.

## Related plans

- [Pluggable loop state for CI and concurrent runs](remote-loop-state.md)
- [Wiring loops together into pipelines](pipeline.md)
