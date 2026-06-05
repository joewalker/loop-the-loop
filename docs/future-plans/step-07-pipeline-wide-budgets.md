# Step 07: Pipeline-wide budgets

## Goal

Let a pipeline enforce a shared USD budget across all steps instead of treating `maxBudgetUsd` as a separate per-step cap.

## Work

- Add a pipeline-level budget accumulator that reads each step's state snapshot.
- Decide how inherited `maxBudgetUsd` interacts with a pipeline-wide cap. The preferred model is that a top-level cap is shared by the pipeline, while a step-level override can make a stricter local cap.
- Stop scheduling new steps when the aggregate total reaches the cap.
- For a currently running step, rely on the step's normal budget behavior and then update the aggregate after it completes.
- Surface the aggregate spend and stopping reason in the pipeline result.

## Dependencies

- Step 03, for per-step cost totals.
- Step 06, for the pipeline orchestrator.

## Done when

- A pipeline can stop before running a downstream step because upstream spend already crossed the shared cap.
- Step-level state remains the source of persisted per-prompt cost.
- The aggregate budget result is deterministic on resume.
- Tests cover inherited caps, step overrides, resume, and no-cost results.
