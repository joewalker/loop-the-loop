# Pipeline example

`bugfix.json` is a review -> fix -> verify -> commit/giveup -> summary pipeline with a bounded rework loop.

The rework loop is split into two fix steps rather than one. `fix-new` handles freshly reported bugs from `review`; `fix-rework` pulls verify results whose `structuredOutput.verdict` is `rework`, re-emitting them at the next attempt (`#2`, `#3`) up to `maxAttempts`. `verify` fans in over both fix reports with a single `jsonl` reader whose `dataFile` is an array. When an item reaches the attempt cap, the complementary `giveup` reader (same `minAttempts` value) pulls it as a first-class "exhausted rework" terminal outcome instead of looping forever.

Verdict routing requires `jsonl-report`, because the `loop-state` reader does not carry `structuredOutput`. Every step here inherits the pipeline's `jsonl-report` reporter. Each step's artifacts are named `bugfix-<step>-*`.

The pipeline runs to a fixed point: every step runs once per pass and passes repeat until a whole pass adds no new outcomes anywhere.
