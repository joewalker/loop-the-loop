
# loop-the-loop

A framework for running generated prompts through coding agents in an automated loop. You define a source of prompts (a prompt generator), an agent to process them, and a reporter to capture the results. The loop handles sequencing, state persistence, git commits, and error recovery.

## Getting Started

```sh
pnpm install
pnpm test
```

`pnpm install` automatically builds the project. You can rebuild manually with `pnpm tsc`.

## Running the Loop

There are two ways to run a loop: from a JSON config file via the CLI, or programmatically from TypeScript.

### CLI

```sh
pnpm tsc
node dist/cli.js config.json
```

Or, if compiled with Deno:

```sh
deno compile --allow-read --allow-write --allow-run --allow-env --allow-net --output=dist/loop-the-loop src/cli.ts
./dist/loop-the-loop config.json
```

The config file is a JSON object matching the `LoopCliConfig` type. For example:

```json
{
  "name": "react-review",
  "agent": "claude-sdk",
  "promptGenerator": [
    "per-file",
    {
      "filePattern": "**/src/**/*.tsx",
      "excludePatterns": ["**/__test__/**"],
      "promptTemplate": "Review {{file}} for React best practices."
    }
  ],
  "maxPrompts": 10,
  "reporter": "yaml-report"
}
```

### Programmatic

```typescript
import { loop } from 'loop-the-loop';

loop({
  name: 'my-task',
  agent: 'claude-sdk',
  promptGenerator: [
    'per-file',
    {
      filePattern: 'src/**/*.ts',
      promptTemplate: 'Analyse {{file}} for potential bugs.',
    },
  ],
}).catch(console.error);
```

See `src/examples/review.ts` and `src/examples/bugzilla-retriage.ts` for complete working examples.

## Configuration

The top-level configuration object (`LoopCliConfig`, defined in `src/types.ts`) accepts the following fields:

Field         | Required | Default | Description
-------------------|-----|------|----------------
`name`             | yes |      | Task name, used for report filenames and git commit messages
`agent`            | yes |      | Which agent to use (see Agents below)
`promptGenerator`  | yes |      | Which prompt generator to use (see Prompt Generators below)
`outputDir`        | no  | cwd  | Directory for report and state files. CLI JSON configs default this to the config file directory; programmatic calls default to cwd
`reporter`         | no  | YAML | Which reporter to use (see Reporters below)
`maxPrompts`       | no  | ∞    | Stop after processing this many prompts
`interPromptPause` | no  | 5    | Seconds to pause between prompts (helps with rate limits)
`systemPrompt`     | no  |      | System prompt passed to the agent. In CLI JSON configs, `{{include:path}}` macros resolve relative to the config file; programmatic calls resolve relative to cwd
`outputSchema`     | no  |      | JSON Schema for structured output (agent support varies)
`allowedTools`     | no  | see agent | Tool names auto-allowed without permission prompts
`disallowedTools`  | no  |      | Tool names to block entirely

## How the Loop Works

1. The working directory must be git-clean (no uncommitted changes).
2. State is loaded from `{name}-loop-state.json`, or created fresh.
3. For each prompt yielded by the prompt generator:
   - The agent is invoked with the prompt and any configured options.
   - The result is appended to the reporter.
   - On success: all changes are committed to git automatically.
   - On glitch (transient error like rate limits): the loop continues, but aborts after 5 consecutive glitches.
   - On error (prompt-level failure): the loop stops immediately.
   - State is saved after every prompt, so interrupted runs resume where they left off.

## Agents

An agent wraps an LLM or CLI tool. The loop calls its `invoke()` method once per prompt.

Specify an agent in configuration as:
- A string name: `"claude-sdk"`
- A name with config: `["claude-sdk", { "mcpServers": { ... } }]`

### `claude-sdk`

Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). This is the primary agent for most tasks.

- Default tools: `Read`, `Glob`, `Grep`
- Default max turns: 5
- Permission mode: `acceptEdits`
- Supports: `systemPrompt`, `outputSchema`, `allowedTools`, `disallowedTools`, MCP servers

Config example with MCP servers:

```json
["claude-sdk", { "mcpServers": { "my-server": { "command": "node", "args": ["server.js"] } } }]
```

Source: `src/agents/claude-sdk.ts`

### `codex-cli`

Invokes the Codex CLI (`codex exec`) as an external process.

- Sandbox mode: read-only
- Custom model via `CODEX_MODEL` environment variable
- Does not support `allowedTools`, `disallowedTools`, or `outputSchema` (warns and ignores)

Config example:

```json
"codex-cli"
```

Source: `src/agents/codex-cli.ts`

## Prompt Generators

A prompt generator yields prompts for the loop to process. Each prompt has an `id` (for tracking) and a `prompt` string (sent to the agent).

Specify a prompt generator as a tuple: `["generator-name", { ...config }]`.

### `per-file`

Generates one prompt per file matching a glob pattern. The `{{file}}` placeholder in the template is replaced with each file path.

Field        | Required | Description
------------------|-----|------------
`filePattern`     | yes | Glob pattern for files to process (e.g. `"src/**/*.ts"`)
`promptTemplate`  | yes | Template string; `{{file}}` is replaced with the file path
`excludePatterns` | no  | Glob patterns to exclude
`basePath`.       | no  | Base directory for resolving `{{include:...}}` paths. Programmatic callers default to cwd; CLI JSON configs default omitted values to the config file directory

Prompt templates support `{{include:path}}` macros that inline the contents of a file (resolved relative to `basePath`). Includes are recursive and circular references are detected.

Config example:

```json
[
  "per-file", {
    "filePattern": "**/src/**/*.tsx",
    "excludePatterns": ["**/__test__/**", "**/node_modules/**"],
    "promptTemplate": "Review {{file}} for accessibility issues.\n\n{{include:prompts/a11y-checklist.md}}"
  }
]
```

Source: `src/prompt-generators/per-file.ts`

### `bugzilla`

Queries a Bugzilla instance and generates one prompt per matching bug. Bug field placeholders in the template are replaced with values from each bug.

Field     |   Required | Description
-----------------|-----|------------
`search`         | yes | Search parameters (see below)
`promptTemplate` | yes | Template with bug placeholders (see below)
`bugzilla`       | no  | Connection options. Defaults to `bugzilla.mozilla.org` with no API key
`basePath`       | no  | Base directory for resolving `{{include:...}}` paths. Programmatic callers default to cwd; CLI JSON configs default omitted values to the config file directory

Available template placeholders: `{{id}}`, `{{summary}}`, `{{url}}`, `{{component}}`, `{{product}}`, `{{severity}}`, `{{status}}`, `{{assignee}}`, `{{whiteboard}}`.

Search parameters (`search` field):

Field         | Description
--------------|------------
`product`     | Restrict to a single product
`components`  | Array of component names (OR match)
`bugStatus`   | Array of statuses: `UNCONFIRMED`, `NEW`, `ASSIGNED`, `REOPENED`, `RESOLVED`, `VERIFIED`, `CLOSED`
`keywords`.   | Array of keywords (OR match)
`assignedTo`  | Filter by assignee
`bugSeverity` | Array of severity values (e.g. `S1`, `S2`)
`advanced`    | Array of `{ field, matchType, value }` for advanced field-based queries
`change`      | Detect changes: `{ field, from, to, value }`
`dryRun`      | When true, skip the actual query and return an empty set
`logQuery`    | When true, log the query URL to stdout

Config example:

```json
[
  "bugzilla", {
    "search": {
      "product": "Core",
      "components": ["DOM: Workers"],
      "bugStatus": ["NEW", "ASSIGNED"],
      "advanced": [{ "field": "creation_ts", "matchType": "lessthan", "value": "2024-01-01" }]
    },
    "promptTemplate": "Triage bug {{id}}: {{summary}}\nURL: {{url}}\nSeverity: {{severity}}"
  }
]
```

Source: `src/prompt-generators/bugzilla.ts`, `src/prompt-generators/bugzilla/`

### `json`

Iterates over elements of a JSON array or object and generates one prompt per element. The data can be supplied inline or loaded from a file.

Field            | Required | Description
-----------------|----------|------------
`data`           | one of `data`/`dataFile` | Inline JSON value (array or object) to iterate over
`dataFile`       | one of `data`/`dataFile` | Path to a JSON file to read. Resolved relative to `basePath`
`promptTemplate` | yes      | Template string with placeholder substitution (see below)
`path`           | no       | Dot-notation path into the JSON to reach the array or object to iterate (e.g. `"results.bugs"`). Defaults to the root value
`idField`        | no       | Field name on each element to use as the unique ID for state tracking. Defaults to the array index or object key
`basePath`       | no       | Base directory for resolving `{{include:...}}` paths and `dataFile`. Programmatic callers default to cwd; CLI JSON configs default omitted values to the config file directory

Template placeholders for object elements: `{{fieldName}}` for any top-level field, `{{id}}` for the resolved tracking ID, `{{index}}` for the 0-based position. For non-object elements (strings, numbers), use `{{value}}`. The `{{include:path}}` macro is also supported.

Config example with a file:

```json
[
  "json", {
    "dataFile": "data/bugs.json",
    "path": "results.bugs",
    "idField": "id",
    "promptTemplate": "Triage bug {{id}}: {{summary}}\nSeverity: {{severity}}\n\n{{include:prompts/triage.md}}"
  }
]
```

Config example with inline data:

```json
[
  "json", {
    "data": [
      { "id": "foo", "description": "First task" },
      { "id": "bar", "description": "Second task" }
    ],
    "idField": "id",
    "promptTemplate": "Complete task {{id}}: {{description}}"
  }
]
```

Source: `src/prompt-generators/json.ts`

### `batch`

Wraps any other prompt generator and processes its items in fixed-size batches, injecting a summary prompt after each batch. This is useful when you want to run 50 bugs through an analysis agent, synthesise the results, then run the next 50 and synthesise again.

Field                   | Required | Default | Description
------------------------|----------|---------|------------
`source`                | yes      |         | The inner generator, specified as a `["generator-name", { ...config }]` tuple or a `PromptGenerator` instance
`summaryPromptTemplate` | yes      |         | Template for the summary prompt injected after each batch (see below)
`reportFile`            | yes      |         | Path to the report file the loop is writing to; injected as `{{reportFile}}` in the summary template
`batchSize`             | no       | 50      | Number of source items per batch
`basePath`              | no       | cwd     | Base directory for resolving `{{include:...}}` paths in `summaryPromptTemplate`

The summary prompt is injected after every `batchSize` items, and again at the end for any leftover items. Summary prompts are tracked in LoopState under IDs of the form `batch-summary-after-{lastItemId}`, so they are skipped on resume if already completed.

Available template placeholders in `summaryPromptTemplate`:

Placeholder      | Description
-----------------|------------
`{{batchSize}}`  | Number of items in this batch
`{{batchIds}}`   | Newline-separated list of item IDs in this batch
`{{reportFile}}` | Path to the report file (same as the `reportFile` config field)

The summary prompt tells the agent where to find the results rather than including them directly. The agent reads the report file using its `Read` or `Grep` tools and focuses on the listed IDs.

Config example:

```json
[
  "batch", {
    "source": [
      "bugzilla", {
        "search": { "product": "Core", "components": ["DOM: Workers"], "bugStatus": ["NEW"] },
        "promptTemplate": "Analyse bug {{id}}: {{summary}}. What is the root cause?"
      }
    ],
    "batchSize": 50,
    "summaryPromptTemplate": "The results for {{batchSize}} bugs are in {{reportFile}}.\nThe bug IDs are:\n{{batchIds}}\n\nRead the report and write a synthesis identifying common root causes and patterns.",
    "reportFile": "output/dom-analysis-report.yaml"
  }
]
```

Note: if a run crashes after all items in a batch are processed but before the summary prompt runs, the summary will not be retried on resume (the source skips all completed items, so the batch boundary is never reached again). In practice this is rare since items and summaries are processed sequentially.

Source: `src/prompt-generators/batch.ts`

## Reporters

A reporter persists results after each agent invocation. Results are appended incrementally, so partial runs still produce useful output.

Specify a reporter by name: `"yaml-report"`, `"jsonl-report"`, or `"default"` (which is YAML).

### `yaml-report` (default)

Writes a multi-document YAML file (`{name}-report.yaml`). Each entry is a separate YAML document delimited by `---`, making the output human-readable and parseable by any YAML multi-document loader.

Source: `src/reporters/yaml.ts`

### `jsonl-report`

Writes a JSON Lines file (`{name}-report.jsonl`). Each line is a self-contained JSON object combining the prompt and result, making it easy to process with standard JSON tooling or stream incrementally.

Source: `src/reporters/jsonl.ts`

## Building Custom Extensions

The framework is designed around three extension points: agents, prompt generators, and reporters. Each follows the same pattern: implement an interface, add a static factory method, and register it.

### Custom Agent

Implement the `Agent` interface from `src/agents/agents.ts`:

```typescript
import type { InvokeResult } from '../types.js';
import type { Agent, InvokeOptions } from './agents.js';

export class MyAgent implements Agent {
  static readonly agentName = 'my-agent';

  static async create(config?: MyConfig): Promise<Agent> {
    return new MyAgent(config);
  }

  async invoke(prompt: string, options?: InvokeOptions): Promise<InvokeResult> {
    // Call your LLM / tool / API here.
    // Return one of:
    //   { status: 'success', output: '...' }            - prompt succeeded
    //   { status: 'glitch', reason: '...' }              - transient failure (rate limit, network)
    //   { status: 'error', reason: '...' }               - prompt-level failure (do not retry)
  }
}
```

Then register it in the `agentCreators` map in `src/agents/agents.ts`:

```typescript
const agentCreators = {
  // ...existing agents...
  [MyAgent.agentName]: MyAgent.create,
};
```

### Custom Prompt Generator

Implement the `PromptGenerator` interface from `src/prompt-generators/prompt-generators.ts`:

```typescript
import type { LoopState } from '../util/loop-state.js';
import type { Prompt, PromptGenerator } from './prompt-generators.js';

export class MyPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'my-generator';

  static async create(config: MyConfig): Promise<PromptGenerator> {
    return new MyPromptGenerator(config);
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const items = await fetchItems(this.config);
    for (const item of items) {
      // Skip items that were already processed in a previous run
      if (loopState.isOutstanding(item.id)) {
        yield { id: item.id, prompt: buildPrompt(item) };
      }
    }
  }
}
```

Then register it in the `promptGeneratorCreators` map in `src/prompt-generators/prompt-generators.ts`:

```typescript
const promptGeneratorCreators = {
  // ...existing generators...
  [MyPromptGenerator.promptGeneratorName]: MyPromptGenerator.create,
};
```

### Custom Reporter

Implement the `Reporter` interface from `src/reporters/reporters.ts`:

```typescript
import type { Prompt } from '../prompt-generators/prompt-generators.js';
import type { InvokeResult } from '../types.js';
import type { Reporter } from './reporters.js';

export class MyReporter implements Reporter {
  static readonly reporterName = 'my-report';
  static readonly fileExtension = 'csv';

  static async create(basePath: string): Promise<Reporter> {
    return new MyReporter(`${basePath}.${MyReporter.fileExtension}`);
  }

  async append(prompt: Prompt, result: InvokeResult): Promise<void> {
    // Serialize and persist the prompt + result pair.
  }
}
```

Then register it in the `reporterConstructors` map in `src/reporters/reporters.ts`:

```typescript
const reporterConstructors = {
  // ...existing reporters...
  [MyReporter.reporterName]: MyReporter.create,
};
```

### Key Types

All extension-relevant types are exported from the package root (`src/index.ts`):

- `Agent`, `InvokeOptions` -- the agent contract and its per-invocation options
- `PromptGenerator`, `Prompt` -- the prompt generator contract and its output type
- `InvokeResult`, `SuccessfulInvocationResult`, `GlitchedInvocationResult`, `ErrorInvocationResult` -- the three-state result type
- `OutputSchema` -- JSON Schema type for structured output
- `BatchTask`, `PerFileTask`, `BugzillaTask`, `JsonTask` -- config types for the built-in generators
- `YamlReporter`, `JsonlReporter` -- the built-in reporter classes

### Include Macros

Both prompt templates and system prompts support `{{include:path}}` macros. Prompt template includes are resolved relative to `basePath`. For CLI JSON configs, omitted `basePath` values default to the config file directory and `systemPrompt` includes are expanded relative to that same directory. Programmatic callers that omit `basePath` continue to resolve includes relative to cwd. Circular includes are detected and throw an error. This is useful for sharing common instructions across prompts.

See `src/util/expand-prompt.ts` for the implementation.

## Examples

See the `examples` folder for more examples.
