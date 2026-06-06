# reader-generators examples

Two readers that let one loop consume another loop's local output.

`jsonl-rework.json` reads a verify step's `jsonl-report`, pulls only the lines whose `structuredOutput.verdict` is `rework`, and re-emits each at the next attempt id (`bug-1` becomes `bug-1#2`). `maxAttempts` bounds the rework loop, so an item that still fails after three attempts is left for a giveup arm rather than cycling forever. Verdict routing requires `jsonl-report`, so the reporter is set explicitly.

`loop-state-retry.json` reads a prior step's strict v2 state file and pulls only the ids whose recorded outcome was an error, so a follow-up loop can retry just the failures. The `loop-state` reader carries `status` and `reason` but not the agent output or a verdict; use the `jsonl` reader when the upstream text or a structured verdict is needed.

Both `dataFile` and `stateFile` use a `{{steps.<name>.report|state}}` handoff substitution, which resolves to the named step's artifacts under `outputDir`. Renaming a step updates its consumers instead of breaking a hard-coded filename. A missing upstream file is treated as empty input, so a consumer is safe to run before its producer has emitted anything.
