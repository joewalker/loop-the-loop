# Step 08: Cross-branch pipeline parallelism

## Goal

Run independent steps within a pipeline pass concurrently while preserving
source update safety and deterministic step-level results.

The pipeline model is fixed-point passes, not a DAG (Step 06), so concurrency
is expressed within a pass rather than as a ready set of steps whose
dependencies have completed.

## Work

- Within a fixed-point pass, run steps that have no `dependsOn` ordering
  between them concurrently, up to a configured limit.
- Add a pipeline-level concurrency limit for steps.
- Run independent non-source-updating steps concurrently.
- Treat any `allowSourceUpdate: true` step as a global barrier that runs alone.
- Decide whether non-source-updating steps may run while the working tree is
  dirty from another step. The conservative answer is no.
- Preserve the existing within-step `concurrency` behavior from Step 04.
- Aggregate step results in a deterministic order for reporting even when
  execution completes out of order.

## Dependencies

- Step 04, for concurrency semantics and stop behavior.
- Step 06, for the fixed-point pipeline orchestrator and routing model.
- Step 07, if shared pipeline budgets must stop step scheduling.

## Done when

- Independent steps in a pass can overlap under a configured limit.
- Source-updating steps never interleave with any other step.
- A failed step prevents work that depends on it from progressing.
- Shared budget stops prevent new steps from starting and let active safe work
  drain according to the selected policy.

## Related plans

- [Optional parallel prompt execution](../archived-plans/concurrency.md)
- [Conditional routing and rework loops](conditional-routing-design.md)
- [Wiring loops together into pipelines](../archived-plans/pipeline.md)
