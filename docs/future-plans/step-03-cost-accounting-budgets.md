# Step 03: Cost accounting and budgets

## Goal

Record cost and token metadata for every prompt result when available, persist
run totals across resumes, and optionally stop a run after it crosses a
configured USD budget.

## Work

- Add a pure pricing helper for configured per-model prices.
- Extract provider cost from Claude SDK results.
- Extract token usage from OpenAI SDK results and estimate USD only when the
  user has configured pricing for the resolved model.
- Extract token usage from Codex CLI JSONL events and estimate USD only when
  pricing is configured.
- Persist per-result cost in loop state outcomes and full reporter output.
- Add YAML reporter cost serialization.
- Add `maxBudgetUsd` to runtime config, CLI parsing, and schema.
- Use `LoopRunResult` for budget stops instead of return-string text.

## Dependencies

- Step 01, for strict state shape and structured loop results.

## Done when

- Cost is recorded on success, error, and glitch results when the agent can
  determine it.
- `costSource: 'unavailable'` records token data without advancing
  `totalUsd`.
- Budget stops happen after the result that crosses the cap has been fully
  reported and completed in state.
- Resume stops immediately if persisted `totalUsd` is already at or above the
  configured budget.
- No built-in price table is shipped.

## Related plans

- [Per-prompt cost accounting and run budgets](cost-accounting.md)
