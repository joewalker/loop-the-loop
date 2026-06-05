# Step 09: Dashboard

## Goal

Show the current and historical status of loops and pipelines, including
prompt progress, claims, results, cost totals, and step-level pipeline status.

## Work

- Define the dashboard data model from existing local report files, local state
  snapshots, and pipeline step metadata.
- Add a read-only local dashboard that can inspect an output directory.
- Show prompt status counts, active claims, failures, cost totals, and recent
  results.
- For pipelines, show the step flow, per-step status, step cost, attempt and
  rework counts, and downstream blocked state.
- Decide whether real-time updates use file polling first or a new event
  stream. File polling is likely sufficient for the first version.

## Dependencies

- Step 01, for strict state snapshots.
- Step 03, for cost fields and totals.
- Step 06, for pipeline artifact conventions.
- Step 07, for pipeline-wide budget status if included in the first dashboard
  version.
- Step 08 is useful but not required. The first dashboard can work for
  sequential pipelines and ordinary loops.

## Done when

- A user can point the dashboard at a local output directory and understand
  what is done, active, failed, skipped, or blocked.
- The dashboard does not require remote state.
- The first version is read-only.
- Dashboard tests or smoke checks cover ordinary loops and pipelines.

## Related plans

- [Runtime dashboard](dashboard.md)
