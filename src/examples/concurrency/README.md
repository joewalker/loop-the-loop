# concurrency example

Runs up to four prompts at once in a single process.

- `concurrency` controls how many prompts are in flight together. The default
  is 1 (serial), which behaves exactly as before.
- `interPromptPause` stays a per-worker pause: each slot pauses after its own
  prompt before pulling the next, and the initial burst is staggered across the
  pause window so the workers do not all fire at the same instant.

Concurrency greater than 1 is rejected with `allowSourceUpdate` (git commits
cannot safely interleave) and with the batch prompt generator (its summary
prompts read the report file and would race with in-flight batch items).
