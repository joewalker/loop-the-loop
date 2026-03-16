
# agentic-loop

A framework for running generated prompts through coding agents in an automated loop.

## Getting Started

```sh
pnpm install
pnpm test
```

`pnpm install` automatically builds the project. You can rebuild manually with `pnpm tsc`.

## Examples / Usage

Examples:

* [react-review.ts](src/examples/react-review.ts) loops over the JSX files in the repository and checks them against vercel-react-best-practices producing a report


Available agents: `claude-sdk`, `codex-cli`.

Custom prompt generators can also be used.

They should implement a `generate()` method that returns `AsyncIterable<Prompt>`.

## How it Works

The loop iterates over prompts from `promptGenerator.generate()`, passes each to the agent, commits successful results to git, and resumes from saved state if interrupted. Transient failures (rate limits, network errors) are retried up to a limit; prompt-level errors stop the loop immediately.
