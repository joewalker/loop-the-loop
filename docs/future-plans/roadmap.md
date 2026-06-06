# Roadmap

This roadmap orders the larger planned changes by dependency and product value. The goal is to make correctness-focused runtime foundations first, then build up to richer local workflows, and leave distributed and S3 handoff work until the local model is proven.

Backwards compatibility with old pre-v2 state files is not a goal at this stage. Plans should prefer strict forward contracts and clear failures over legacy migration paths.

## Sequence

1. [Runtime contracts and state hardening](step-01-runtime-contracts-state-hardening.md) - completed
2. [`--doctor`](step-02-doctor.md) - completed
3. [Cost accounting and budgets](step-03-cost-accounting-budgets.md) - completed
4. [In-process concurrency](step-04-in-process-concurrency.md) - completed
5. [Reader generators plus local handoff substitution](step-05-reader-generators-local-handoff.md) - completed
6. [Pipelines with routing and rework](step-06-sequential-pipelines.md) - completed
7. [Pipeline-wide budgets](step-07-pipeline-wide-budgets.md) - completed
8. [Cross-branch pipeline parallelism](step-08-cross-branch-pipeline-parallelism.md)
9. [Dashboard](step-09-dashboard.md)
10. [Remote loop state for CI coordination](step-10-remote-loop-state-ci.md)
11. [S3-backed pipeline handoff](step-11-s3-backed-pipeline-handoff.md)

Steps 1 through 7 are complete on `main`. The as-built Step 3 plan lives in [step-03-cost-accounting-budgets-plans.md](step-03-cost-accounting-budgets-plans.md), the as-built Step 4 plan in [step-04-in-process-concurrency-plans.md](step-04-in-process-concurrency-plans.md), the as-built Step 5 plan in [step-05-reader-generators-local-handoff-plans.md](step-05-reader-generators-local-handoff-plans.md), the as-built Step 6 plan in [step-06-sequential-pipelines-plans.md](step-06-sequential-pipelines-plans.md), and the as-built Step 7 plan in [step-07-pipeline-wide-budgets-plans.md](step-07-pipeline-wide-budgets-plans.md). See [next.md](next.md) for the as-built contracts and the context that carries into Step 8.

## Definition of done for each step

Beyond each step's own "Done when" list, every step follows the standard completion gate in [AGENTS.md](../../AGENTS.md): `pnpm tsc && pnpm test` pass, `pnpm lint` is clean, `pnpm format` leaves no diff, and coverage stays at 100%.

In addition, any step that changes user-facing surface keeps three artifacts in lockstep within the same change:

- Schema: when a step adds, removes, or renames a field loadable from a CLI JSON config (a top-level `LoopCliConfig` field, an agent or generator task type, a loop-state or pipeline spec), `schema/loop-the-loop.schema.json` moves with the runtime types, per AGENTS.md. This applies to steps 3, 4, 5, 6, 7, 8, 10, and 11. A step that adds only a CLI flag with no config key, such as step 2's `--doctor`, needs no schema change.
- Examples: a step that adds a new config shape adds or updates a config under `src/examples/`, which the schema test in `src/__test__/schema.test.ts` validates automatically.
- User docs: a step that adds a user-facing flag, config field, or command updates the README and any other affected docs so the feature is discoverable.

## Detailed designs

Current detailed design that the step documents above defer to:

- [Conditional routing and rework loops](conditional-routing-design.md) - the detailed design behind the routing and rework model in steps 5, 6, and 8.

The implementation detail from the earlier standalone plans (component shapes, decided constants, file lists, and test outlines) has been folded into the step documents above, which are now the single source of truth.
