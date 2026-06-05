# Design: conditional routing and rework loops in pipelines

## Context

The motivating example for pipelines is "find bug, fix bug, review fix, update
fix, create pr". The "update fix" arm is a rework loop: a verify step that
judges a fix inadequate sends the item back to the fix step, and the item
cycles through fix and verify until it either passes or is abandoned. The
archived pipeline plan declared this out of scope because it modelled a
pipeline as a directed acyclic graph (DAG), and a DAG cannot express the
fix to verify to fix cycle. The current roadmap inherited that gap without
restating it, so the headline use case is not actually expressible.

This document settles the design so rework loops are a first-class feature
rather than a documented limitation.

## Decision summary

1. Drop the DAG abstraction. A pipeline is a set of named steps plus a
   designated terminal step. There is no acyclicity requirement and no
   topological sort.
2. Each step stays exactly what it is today: one `loop()` over one prompt
   generator. Fan-in uses the existing `batch` generator. Reader generators
   from step-05 do the cross-step handoff.
3. The orchestrator runs every step and then re-runs the set in repeated
   passes until a full pass produces zero new outstanding outcomes anywhere.
   This is a fixed-point evaluation, not an ordered single walk.
4. Routing is emergent and pull-based. A producing step's agent emits a
   machine-readable verdict in `structuredOutput`; each consuming step's
   reader filters on that field to pull only the items meant for it. There is
   no central route table.
5. Re-entry uses attempt-scoped ids. Rework mints `bug-123#2`, `bug-123#3`,
   and so on, so the append-only loop-state contract and `isOutstanding`
   resume gate are preserved unchanged.
6. Termination is bounded by a per-reader attempt cap, backed by the
   fixed-point convergence check, with a safety pass ceiling as
   defense in depth.

## The execution model

A pipeline configuration names a set of steps and one terminal step (the
`output` step). The terminal step identifies the final artifact and is used
for reporting; it does not impose an execution order.

Execution runs in passes. In each pass the orchestrator runs every step's
`loop()` once. A step that has no new outstanding work yields nothing and
returns immediately, so a settled step is cheap to re-run. After a pass the
orchestrator checks whether any step recorded at least one new terminal
outcome during that pass. If a whole pass adds nothing new, the pipeline has
reached a fixed point and stops.

`dependsOn`, if retained at all, is demoted from a correctness constraint to
an optional ordering hint within a pass: running an upstream step before a
downstream step in the same pass lets work propagate in fewer passes. Cyclic
hints (fix depends on verify and verify depends on fix) are now legal because
the model no longer forbids cycles. When no ordering is given, steps run in
configuration order.

This replaces the archived plan's DAG validation. Cycle detection is deleted.
Cycle support is the feature.

## Routing via structuredOutput

A step that makes a decision emits it in `structuredOutput`, for example
`{ "verdict": "approve" }` or `{ "verdict": "rework", "reason": "..." }`.
Routing is then expressed entirely in what each consuming step reads and
filters:

- The fix step pulls new bugs from the review step, plus verify results whose
  `structuredOutput.verdict` is `rework`, re-emitted at the next attempt.
- The verify step pulls every fix output.
- The commit step pulls verify results whose `structuredOutput.verdict` is
  `approve`.
- The giveup step pulls verify results whose verdict is `rework` but whose
  attempt count has reached the cap.
- The terminal step pulls commit and giveup outputs for the summary.

There is no central router. The flow is reconstructed from each step's sources
and filters, the same way the archived DAG's edges were already distributed
across `dependsOn` declarations.

Results with status `error` or `glitch` never carry a forward verdict and so
never route onward through a verdict filter. A failure sink step can pull them
explicitly by filtering on `status`.

## Reporter constraint

Routing on `structuredOutput` requires the `jsonl` reader against a
`jsonl-report`. The `loop-state` reader carries only `status`, `reason`, and
`cost`, not `structuredOutput`, so it can route on success or failure but never
on a verdict. A pipeline that uses verdict-based rework must therefore use
`jsonl-report` as its reporter. This constraint must be documented and, where
practical, checked (a verdict filter pointed at a non-jsonl source should fail
clearly).

Storing `structuredOutput` in loop-state is deliberately deferred. It would be
useful once a dashboard exists, but it is not needed now, and keeping
loop-state slim keeps the state file a fast index. This can be added later
without changing the routing model.

## Attempt-scoped ids and re-entry

Each step keeps its own loop-state, and `isOutstanding(id)` skips any id with a
terminal outcome. Rework therefore cannot reuse a bare id, because the fix step
has already recorded a terminal outcome for it. Ids carry an attempt suffix
instead: `bug-123`, then `bug-123#2`, then `bug-123#3`. Attempt 1 is the bare
id with no suffix.

Only the step that loops work back increments the attempt. The fix step's
rework reader parses the `#N` suffix off the upstream verify result and emits
`#(N+1)`. Every other step preserves the incoming id verbatim, so verify,
commit, and the summary all operate on whatever id they were handed. The base
id (the part before `#`) correlates all attempts of one item across steps and
is what downstream consumers strip to group attempts.

Because the minted id has no terminal outcome in the fix step's loop-state,
`isOutstanding` lets it through. Because the increment is a deterministic
function of the upstream id, re-running the reader in a later pass computes the
same `#(N+1)` and `isOutstanding` then suppresses it once it is done. Passes
are therefore idempotent and resume needs no new state.

A worked trace of one item that needs one rework:

```
Pass 1
  fix     bug-1            (from review)            -> fix-report: bug-1
  verify  bug-1            (from fix)               -> verify-report: bug-1 verdict=rework
Pass 2
  fix     bug-1            skipped (terminal in fix loop-state)
  fix     bug-1#2          (rework reader: verdict=rework, attempt 1 < cap)
                                                    -> fix-report: bug-1#2
  verify  bug-1#2          (from fix)               -> verify-report: bug-1#2 verdict=approve
Pass 3
  fix     nothing new (rework reader recomputes bug-1#2, but it is already
          terminal so isOutstanding suppresses it; bug-1#2 verdict=approve is
          not a rework match)
  commit  bug-1#2          (verdict=approve)        -> commit-report: bug-1#2
Pass 4
  nothing new anywhere -> fixed point, stop
```

## Termination

Three layers guarantee the pipeline halts.

The primary bound is a per-reader attempt cap. The rework reader carries
`maxAttempts`; it emits a re-attempt only while the current attempt is below
the cap. The complementary giveup reader carries `minAttempts` set to the same
value; it pulls rework items only once they have reached the cap. The two
readers partition rework items: below the cap they go back to fix, at the cap
they become a first-class terminal "exhausted rework" outcome recorded by the
giveup step. "We tried three times and it still fails" is a reportable result,
not a hang.

The cap guarantees the id space stops growing, which guarantees the
fixed-point check (a pass that adds zero new outcomes) is eventually reached.

A safety `maxPasses` ceiling is the final backstop against a misconfiguration
that somehow keeps producing new work. Reaching it stops the pipeline and
reports the condition rather than looping forever.

## New primitives on the readers

B1 needs only modest additions to the step-05 reader generators. The filter
surface stays declarative and minimal.

- Field-path matching in `filter`. Today the reader supports
  `filter: { "status": "success" }`. Extend the key space to dotted paths
  including `structuredOutput.*`, for example
  `filter: { "structuredOutput.verdict": "rework" }`. Matching is equality
  only. No operators, no expression language.
- Two scalar attempt knobs on a reader: `maxAttempts` (emit only while the
  parsed attempt is below this value) and `minAttempts` (emit only once the
  parsed attempt is at or above this value).
- An `incrementAttempt` boolean (default false) on the loop-back reader, which
  makes it emit the id at `#(N+1)` rather than verbatim.

Fan-in is the existing `batch` generator composing several readers. No central
router and no new scheduling subsystem are introduced.

## Configuration sketch

The pipeline still lives nested under `promptGenerator` as
`["pipeline", { ... }]`, with an explicit `output` key naming the terminal
step rather than relying on a magic step name. The reporter is `jsonl-report`
because verdict routing requires it.

```json
["pipeline", {
  "output": "summary",
  "steps": {
    "review": {
      "promptGenerator": ["per-file",
        { "filePattern": "src/**/*.ts", "promptTemplate": "{{include:review.md}}" }]
    },
    "fix": {
      "promptGenerator": ["batch", { "sources": [
        ["jsonl", {
          "dataFile": "{{steps.review.report}}",
          "filter": { "status": "success" },
          "promptTemplate": "{{include:fix.md}}"
        }],
        ["jsonl", {
          "dataFile": "{{steps.verify.report}}",
          "filter": { "structuredOutput.verdict": "rework" },
          "maxAttempts": 3,
          "incrementAttempt": true,
          "promptTemplate": "{{include:fix-rework.md}}"
        }]
      ]}]
    },
    "verify": {
      "agent": ["claude-sdk", { "model": "claude-opus-4-8", "allowedTools": [] }],
      "promptGenerator": ["jsonl",
        { "dataFile": "{{steps.fix.report}}", "promptTemplate": "{{include:verify.md}}" }]
    },
    "commit": {
      "allowSourceUpdate": true,
      "promptGenerator": ["jsonl", {
        "dataFile": "{{steps.verify.report}}",
        "filter": { "structuredOutput.verdict": "approve" },
        "promptTemplate": "{{include:commit.md}}"
      }]
    },
    "giveup": {
      "promptGenerator": ["jsonl", {
        "dataFile": "{{steps.verify.report}}",
        "filter": { "structuredOutput.verdict": "rework" },
        "minAttempts": 3,
        "promptTemplate": "{{include:giveup.md}}"
      }]
    },
    "summary": {
      "promptGenerator": ["batch", { "sources": [
        ["jsonl", { "dataFile": "{{steps.commit.report}}", "promptTemplate": "{{include:summary.md}}" }],
        ["jsonl", { "dataFile": "{{steps.giveup.report}}", "promptTemplate": "{{include:summary.md}}" }]
      ]}]
    }
  }
}]
```

The `{{steps.<name>.report}}` substitution is the step-05 handoff variable, so
renaming a step updates its consumers rather than silently breaking a
hard-coded filename.

## Cost and budget

Attempt-scoped ids make cost accounting correct for free. Each rework round is
a distinct id with its own `complete()` call, so a step's `totalUsd` sums all
attempts including the ones that failed and were retried. The pipeline-wide
budget in step-07 therefore reflects the true cost of rework, including the
work that did not land. Re-open semantics would have overwritten the prior
attempt's outcome and made both per-item cost and resume accounting ambiguous,
which is a further reason the append-only model was chosen.

## Impact on existing roadmap steps

These changes are integrated into the step documents:

- step-05 now lists the filter field-path extension, the
  `maxAttempts`/`minAttempts` knobs, and `incrementAttempt` as hard
  requirements of the routing model rather than nice-to-haves.
- step-06 no longer validates a DAG or topologically sorts. It validates the
  step set, requires a terminal `output` step, and runs to a fixed point.
  Cycle detection is removed; cycle support is the feature. Strict failure
  handling still applies: an `error`/`glitch` that no sink consumes stops the
  pipeline under the strict default.
- step-08 expresses parallelism as running independent steps within a pass
  concurrently, rather than as a ready set of steps whose dependencies have
  completed, while preserving the `allowSourceUpdate` global barrier.
- limitations.md item 1 is marked resolved and points at this document.

## Out of scope and future work

- `structuredOutput` in loop-state. Deferred until a dashboard makes it useful.
  Adding it later does not change the routing model; it only gives the
  `loop-state` reader a second routing channel.
- A central route table or a flow-visualisation view. The flow is emergent from
  reader filters in the first version.
- Predicate operators in filters (ranges, negation, boolean composition).
  Equality matching plus the two attempt knobs cover the rework case. A richer
  surface can be added later if a real need appears.
- Parallel rework of a single item across attempts. Attempts of one item are
  inherently sequential; only distinct items run concurrently, governed by
  step-04 and step-08.

## Open questions

None outstanding. The filter surface is declarative and minimal (resolved), and
verdict routing is `jsonl-report`-only for now with `structuredOutput` in
loop-state deferred (resolved).
