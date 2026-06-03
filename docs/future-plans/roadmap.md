# Roadmap

We have a number of large-ish improvements planned.

- [Add a `--doctor` CLI option](doctor-flag.md)
- [Add optional parallel prompt execution](concurrency.md)
- [Add the ability to track costs of each prompt run tracks cost, estimate total budgets, etc](cost-accounting.md):
- [Add a pluggable loop state for CI and concurrent runs](remote-loop-state.md)
- [Add the ability to wire together a number of prompts](pipeline.md) (e.g. find bug → fix bug → review fix → update fix → create pr)
- [Add a dashboard to see the status of each prompt and its progress in real-time](dashboard.md) (The detailed design of this step is TBD, pending completion of the prior steps)
