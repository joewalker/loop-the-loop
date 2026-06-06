# cost-budget example

Demonstrates cost accounting and budgets:

- `prices` on the openai-sdk agent supplies per-million-token rates for the
  resolved model, so each result carries an estimated USD cost
  (`costSource: estimated`). Without `prices` the agent records token counts
  only (`costSource: unavailable`).
- `maxBudgetUsd` caps the lifetime spend across resumes. The run stops after
  the prompt whose completion takes the persisted total at or above the cap.

claude-sdk needs no `prices`: it reports a real provider cost directly
(`costSource: provider`).
