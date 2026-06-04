# Step 08: Cross-branch pipeline parallelism

## Goal

Run independent branches of a pipeline DAG concurrently while preserving source
update safety and deterministic step-level results.

## Work

- Add a scheduler that maintains a ready set of steps whose dependencies have
  completed.
- Add a pipeline-level concurrency limit for steps.
- Run independent non-source-updating steps concurrently.
- Treat any `allowSourceUpdate: true` step as a global barrier.
- Decide whether non-source-updating steps may run while the working tree is
  dirty from another step. The conservative answer is no.
- Preserve the existing within-step `concurrency` behavior from Step 04.
- Aggregate step results in dependency order for reporting even when execution
  completes out of order.

## Dependencies

- Step 04, for concurrency semantics and stop behavior.
- Step 06, for DAG validation and sequential orchestration.
- Step 07, if shared pipeline budgets must stop branch scheduling.

## Done when

- Independent branches can overlap under a configured limit.
- Source-updating steps never interleave with any other step.
- A failed branch prevents dependent branches from starting.
- Shared budget stops prevent new branches from starting and let active safe
  work drain according to the selected policy.

## Related plans

- [Optional parallel prompt execution](concurrency.md)
- [Wiring loops together into pipelines](pipeline.md)
