# Roadmap

This roadmap orders the larger planned changes by dependency and product value. The goal is to make correctness-focused runtime foundations first, then build up to richer local workflows, and leave distributed and S3 handoff work until the local model is proven.

Backwards compatibility with old pre-v2 state files is not a goal at this stage. Plans should prefer strict forward contracts and clear failures over legacy migration paths.

## Sequence

1. [Runtime contracts and state hardening](step-01-runtime-contracts-state-hardening.md)
2. [`--doctor`](step-02-doctor.md)
3. [Cost accounting and budgets](step-03-cost-accounting-budgets.md)
4. [In-process concurrency](step-04-in-process-concurrency.md)
5. [Reader generators plus local handoff substitution](step-05-reader-generators-local-handoff.md)
6. [Pipelines with routing and rework](step-06-sequential-pipelines.md)
7. [Pipeline-wide budgets](step-07-pipeline-wide-budgets.md)
8. [Cross-branch pipeline parallelism](step-08-cross-branch-pipeline-parallelism.md)
9. [Dashboard](step-09-dashboard.md)
10. [Remote loop state for CI coordination](step-10-remote-loop-state-ci.md)
11. [S3-backed pipeline handoff](step-11-s3-backed-pipeline-handoff.md)

## Detailed designs

Current detailed design that the step documents above defer to:

- [Conditional routing and rework loops](conditional-routing-design.md) - the detailed design behind the routing and rework model in steps 5, 6, and 8.

## Archived detailed plans

The earlier detailed plans now live in `docs/archived-plans/`. They remain useful design inputs, but the step documents above are the ordering source of truth. Where an older detailed plan still mentions legacy migration, a DAG pipeline model, or a different dependency order, the step documents win.

- [`--doctor` CLI option](../archived-plans/doctor-flag.md)
- [Optional parallel prompt execution](../archived-plans/concurrency.md)
- [Per-prompt cost accounting and run budgets](../archived-plans/cost-accounting.md)
- [Pluggable loop state for CI and concurrent runs](../archived-plans/remote-loop-state.md)
- [Wiring loops together into pipelines](../archived-plans/pipeline.md)
- [Runtime dashboard](../archived-plans/dashboard.md)
