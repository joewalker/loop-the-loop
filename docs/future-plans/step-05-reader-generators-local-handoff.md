# Step 05: Reader generators plus local handoff substitution

## Goal

Make one loop consume another loop's local output through normal prompt
generators, with handoff paths that stay correct when `outputDir`, pipeline
name, or step names change.

## Work

- Add a `jsonl` prompt generator that reads JSONL reporter output line by
  line.
- Add a `loop-state` prompt generator that reads the strict v2 state snapshot.
- Support filtering by status and selecting success, error, or all state
  outcomes.
- Support field-path filter keys, including `structuredOutput.*`, with
  equality matching only, so a consuming step can route on a producing step's
  verdict. This is what Step 06 routing reads.
- Add `maxAttempts` and `minAttempts` reader knobs plus an `incrementAttempt`
  flag so a reader can re-emit an item at the next attempt-scoped id (`id#N`).
  This is the primitive that makes bounded rework loops work in Step 06.
- Gate generated ids through the consuming step's own `loopState.isOutstanding`
  check.
- Add local handoff substitutions such as `{{steps.review.report}}` and
  `{{steps.review.state}}` for config fields like `dataFile` and `stateFile`.
- Define missing local report files as empty input when the upstream step
  completed with no prompts, while malformed present files remain errors.

## Dependencies

- Step 01, for the strict state snapshot shape.
- Step 03, so report and state readers can pass through cost fields.

## Done when

- The readers are useful in ordinary non-pipeline loop configs.
- Handoff paths resolve to the actual upstream local artifacts under
  `outputDir`.
- Renaming a step or pipeline updates handoff targets through substitution
  rather than silently breaking hard-coded filenames.
- A reader can filter on `structuredOutput` fields and re-emit at an
  incremented attempt id, which the Step 06 routing model relies on.
- Tests cover malformed JSONL, duplicate ids, filters, field-path matching,
  attempt-scoped re-emission, missing files, and resume skips.

## Related plans

- [Conditional routing and rework loops](conditional-routing-design.md)
- [Wiring loops together into pipelines](../archived-plans/pipeline.md)
