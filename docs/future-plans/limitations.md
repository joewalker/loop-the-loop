
1. Conditional routing / rework loops (RESOLVED)

This was the biggest conceptual gap: the archived pipeline.md modelled a pipeline as a DAG, which structurally cannot express the "update fix" loop-back in the headline "find bug, fix bug, review fix, update fix, create pr" example.

Resolved by designing rework as a first-class feature. The DAG is dropped in favour of fixed-point passes over a set of steps with a designated output, pull-based verdict routing on structuredOutput, and attempt-scoped ids with a cap. See docs/future-plans/conditional-routing-design.md, and the integrated changes in step-05, step-06, and step-08.

2. The reporter-format constraint for handoff is dropped

The archived plan is explicit that the default yaml-report cannot be consumed by the reader generators — handoff requires jsonl-report (or the loop-state reader). The new step-05 and step-06 never mention this. It's a real, user-facing footgun: configure a pipeline with the default reporter and downstream steps silently can't read upstream output.

3. Stale-claim cleanup caveat is not surfaced

Both concurrency.md and remote-loop-state.md carefully flag that graceful release(runId) on SIGINT/SIGTERM is best-effort, that hard crashes leave stale claims that block later runs, and that lease/TTL pruning is deliberately deferred to manual operator cleanup. The new step-04 and step-10 mention the cleanup handlers but not the failure mode or the deferral. This is an operational limitation worth keeping visible.

4. "Per-worker pause is not a global rate limiter"

The archived concurrency plan is careful to state that interPromptPause under concurrency is per-worker and is not equivalent to a global token-bucket rate limit (which is out of scope). The new step-04 keeps "interPromptPause as a per-worker pause" but loses the caveat that users needing real rate limiting must configure it on the agent. Also dropped: the staggered worker startup detail (spreading the initial burst across the pause window).

5. Scope-guard boundaries that prevented creep

The archived cost and remote-state plans listed deliberate non-goals that the new steps don't restate: USD-only (no other currencies, no token-budget caps), no budgetAction: warn|stop selector, no built-in price table location, no GCS/Azure backends, no sharded state for very large jobs. Some are obviously implied, but the new plans lose these as explicit guardrails, which is where scope tends to drift.

6. A couple of design decisions now left implicit

- Where a pipeline lives in config — the archived plan deliberately nests it under promptGenerator as ["pipeline", {...}] rather than a new top-level key, to keep the single-loop common case simple. Step-06 implies detection via isPipelineSpec but never states the placement decision or the createPromptGenerator guard that rejects a stray pipeline spec.
- The agent prices config surface (per-agent in the openai/codex configs) from cost-accounting is implied by "configured per-model prices" but not located.

# Things that are deliberate changes, not gaps (worth confirming)

- Backwards compatibility was dropped on purpose — the new roadmap says so up front, so the archived plans' careful migration of old completed/failed/inProgress shapes is intentionally gone, and step-05 correctly reads only strict v2.
- The injected {{steps.review.report}} handoff substitution is actually promoted in the new plans (step-05) — the archived pipeline.md had deferred it in favour of deterministic filenames and flagged the outputDir-relative asymmetry as a footgun. The new plan resolves that. An improvement, not a regression.
- The dashboard step is more detailed than the near-empty archived dashboard.md.

If you want, I can draft short "out of scope / known limitations" notes for steps 4, 6, and 10 to close items 1–4 above, since those are the substantive ones rather than just lost detail.
