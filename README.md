# Loop the Loop

A framework for running generated prompts through coding agents in an automated loop. You define a source of prompts (a prompt generator), an agent to process them, and a reporter to capture the results. The loop handles sequencing, state persistence, git commits, and error recovery.

## Running the Loop

There are two ways to run a loop: from a JSON config file via the CLI, or programmatically from TypeScript.

### CLI

The CLI requires Node.js 22 or newer.

Run it without installing:

```sh
pnpx loop-the-loop config.json
npx loop-the-loop config.json
```

Or install it first:

```sh
pnpm add --global loop-the-loop
loop-the-loop config.json

npm install --global loop-the-loop
loop-the-loop config.json
```

From a local checkout:

```sh
pnpm build
node dist/cli.js config.json
```

Or, if compiled with Deno:

```sh
deno compile --allow-read --allow-write --allow-run --allow-env --allow-net --output=dist/loop-the-loop src/cli.ts
./dist/loop-the-loop config.json
```

CLI flags:

Flag             | Description
-----------------|------------
`--help`         | Print usage and exit
`--version`      | Print version and exit
`--verbose`      | Stream diagnostic events to stderr
`--max-prompts N`| Stop after N prompts (overrides `maxPrompts` in the config)
`--dry-run`      | Swap the configured agent for a `test` agent that returns "dry run" for every prompt, and force verbose logging so the prompts that would have been sent are visible. Useful for inspecting prompt generation without invoking a real backend.
`--doctor`       | Validate the configured agent, prompt generator, reporter, output directory, resumable state file, and git prerequisites, then exit without running the loop. In the spirit of `gh auth status`, it turns silent runtime failures into a single readable up-front report: it exits 0 when every check passes and 1 when any check fails. `--dry-run` is ignored under `--doctor` because the probe must hit the real configured components.

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

See [`src/examples/review.ts`](https://github.com/joewalker/loop-the-loop/blob/main/src/examples/review.ts) and [`src/examples/bugzilla-retriage.ts`](https://github.com/joewalker/loop-the-loop/blob/main/src/examples/bugzilla-retriage.ts) for complete working examples.

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

Agent-specific options (system prompt, output schema, tool allow/deny lists, MCP servers) live on the agent config tuple. See [Agents](#agents) below.

## Schema

A JSON Schema describing the CLI config lives at `schema/loop-the-loop.schema.json`. Editors that understand JSON Schema (VS Code and the JetBrains family among them) will surface inline diagnostics and autocompletion if you add a `$schema` pointer to the top of your config file.

The simplest pointer uses the published copy on GitHub:

```json
{
  "$schema": "https://raw.githubusercontent.com/joewalker/loop-the-loop/refs/heads/main/schema/loop-the-loop.schema.json",
  "name": "my-task"
}
```

Consumers working from a local checkout or an installed package can point at the file on disk instead, which is useful when working offline or when you want to pin to the version you have installed:

```json
{
  "$schema": "./node_modules/loop-the-loop/schema/loop-the-loop.schema.json"
}
```

The schema is also useful for command-line validators such as `ajv-cli` if you want to validate configs in CI.

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
- A name with config: `["claude-sdk", { "allowedTools": [...] }]`

### `claude-sdk`

Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). This is the primary agent for most tasks.

- Default loaded tools: the SDK's `claude_code` preset (the full default Claude Code tool set)
- Default max-turn budget per prompt: 100 (override via `maxTurns`)
- Permission mode: `acceptEdits`

Config fields (all optional):

Field             | Description
------------------|------------
`systemPrompt`    | System prompt prepended to the conversation. Supports `{{include:path}}` macros.
`outputSchema`    | JSON Schema describing the expected shape of structured output.
`allowedTools`    | Tool names or permission patterns auto-allowed without permission prompts. Auto-approval only; does not restrict which built-in tools the SDK loads.
`loadedTools`     | Restrict which built-in tools the SDK loads. Either an array of tool names, `[]` to disable all built-in tools, or `{ "type": "preset", "preset": "claude_code" }` for the default preset. When omitted the SDK's default preset is used.
`disallowedTools` | Tool names that are explicitly blocked.
`mcpServers`      | MCP (Model Context Protocol) server configurations, keyed by server name.
`maxTurns`        | Maximum tool-use/response rounds per prompt.

Config example:

```json
["claude-sdk", {
  "allowedTools": ["Bash(gh issue *)"],
  "loadedTools": ["Read", "Glob", "Grep", "Bash"],
  "mcpServers": { "my-server": { "command": "node", "args": ["server.js"] } }
}]
```

Source: `src/agents/claude-sdk.ts`

### `openai-sdk`

Uses the OpenAI Agents SDK (`@openai/agents`) with a `SandboxAgent` and the
local Unix sandbox client.

- Default model: the OpenAI Agents SDK default (override via `model`)
- Default max-turn budget per prompt: 100 (override via `maxTurns`)
- Repository mount: the current working directory is available at `/workspace/repo`
- Source updates: when `allowSourceUpdate` is true, the sandbox can edit the mounted repository. When false, the wrapper removes the direct `apply_patch` tool and instructs the agent not to modify files.

Config fields (all optional):

Field           | Description
----------------|------------
`systemPrompt`  | System prompt appended to the built-in workspace guidance. Supports `{{include:path}}` macros.
`outputSchema`  | JSON Schema describing the expected shape of structured output.
`model`         | OpenAI model name. When omitted, the Agents SDK default is used.
`modelSettings` | Model-specific settings forwarded to the Agents SDK.
`maxTurns`      | Maximum tool-use/response rounds per prompt.

Config example:

```json
["openai-sdk", {
  "model": "gpt-5.5",
  "maxTurns": 100,
  "systemPrompt": "{{include:prompts/openai-system.md}}"
}]
```

Source: `src/agents/openai-sdk.ts`

### `codex-cli`

Invokes the Codex CLI (`codex exec`) as an external process.

- The `codex` binary must be installed, authenticated, and available on `PATH`
- Sandbox mode: read-only by default; workspace-write when `allowSourceUpdate` is true
- Custom model via `CODEX_MODEL` environment variable
- Optional `timeoutMs` config aborts an invocation after the given number of milliseconds

Config example:

```json
"codex-cli"
```

With a timeout:

```json
["codex-cli", { "timeoutMs": 600000 }]
```

Source: `src/agents/codex-cli.ts`

### `test`

A stub agent that returns a configured list of canned responses instead of calling a real backend. Useful for exercising a loop config end-to-end (prompt generator, reporter, state file, git wiring) without spending tokens, and as the backing agent for `--dry-run`.

The `test` agent must be configured via the `[name, config]` tuple form; the bare `"test"` name is rejected.

Config fields:

Field       | Required | Description
------------|----------|------------
`responses` | yes      | Canned `InvokeResult` values returned in order. Each entry is `{ "status": "success", "output": "..." }`, `{ "status": "glitch", "reason": "..." }`, or `{ "status": "error", "reason": "..." }`.
`repeat`    | no       | `"none"` (default) returns an error result after the list is exhausted; `"cycle"` wraps back to the first response and keeps going.

Config example (used internally by `--dry-run`):

```json
["test", {
  "responses": [{ "status": "success", "output": "dry run" }],
  "repeat": "cycle"
}]
```

Source: `src/agents/test.ts`

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

Prompt templates support `{{include:path}}` macros that inline the contents of a file. Includes are recursive and circular references are detected. See [Include Macros](#include-macros) for how the lookup base directory is chosen.

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

Available template placeholders: `{{id}}`, `{{summary}}`, `{{url}}`, `{{component}}`, `{{product}}`, `{{severity}}`, `{{status}}`, `{{assignee}}`, `{{whiteboard}}`.

Search parameters (`search` field):

Field         | Description
--------------|------------
`product`     | Restrict to a single product
`ids`         | Array of specific bug IDs
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

### `github`

Queries GitHub issue search and generates one prompt per matching issue. The search uses GitHub's native issue search syntax; the generator adds `repo:<repository>` and `is:issue` so pull requests are excluded and the search stays scoped to one repository.

Field     |   Required | Description
-----------------|-----|------------
`search`         | yes | Search parameters (see below)
`promptTemplate` | yes | Template with issue placeholders (see below)
`github`         | no  | Connection options. Defaults to `https://api.github.com` and token lookup from `GITHUB_TOKEN` then `GH_TOKEN`

Available template placeholders: `{{id}}`, `{{number}}`, `{{repository}}`, `{{owner}}`, `{{repo}}`, `{{title}}`, `{{url}}`, `{{state}}`, `{{author}}`, `{{assignee}}`, `{{assignees}}`, `{{labels}}`, `{{milestone}}`, `{{commentCount}}`, `{{createdAt}}`, `{{updatedAt}}`, `{{closedAt}}`, `{{body}}`.

Search parameters (`search` field):

Field        | Description
-------------|------------
`repository` | Repository to search in `owner/repo` form
`query`      | GitHub issue search syntax, for example `is:open label:bug no:assignee`
`sort`       | Optional GitHub search sort field, for example `updated`, `created`, or `comments`
`order`      | Optional sort order: `asc` or `desc`
`perPage`    | Results per API page, from 1 to 100
`maxResults` | Maximum number of issues to return across all pages. When omitted, returns up to GitHub's 1,000-result search limit; larger values are capped at 1,000
`dryRun`     | When true, skip the actual query and return an empty set
`logQuery`   | When true, log the query URL to stdout

Connection options (`github` field):

Field        | Description
-------------|------------
`origin`     | GitHub REST API origin. Defaults to `https://api.github.com`. For GitHub Enterprise, use the API origin, for example `https://github.example.com/api/v3`
`tokenEnv`   | Environment variable name from which to read a bearer token. Defaults to `GITHUB_TOKEN` then `GH_TOKEN`
`token`      | Bearer token value. Prefer `tokenEnv` for CLI configs so secrets do not need to be written into JSON
`apiVersion` | GitHub REST API version header. Defaults to `2022-11-28`
`userAgent`  | User-Agent header value. Defaults to `loop-the-loop`

Config example:

```json
[
  "github", {
    "github": {
      "tokenEnv": "GITHUB_TOKEN"
    },
    "search": {
      "repository": "octocat/Hello-World",
      "query": "is:open label:bug no:assignee",
      "sort": "updated",
      "order": "desc",
      "maxResults": 25
    },
    "promptTemplate": "Triage {{id}}: {{title}}\nURL: {{url}}\nLabels: {{labels}}\nComment count: {{commentCount}}\n\n{{body}}"
  }
]
```

Source: `src/prompt-generators/github.ts`, `src/prompt-generators/github/`

### `gitlab`

Queries GitLab project issues and generates one prompt per matching issue. The search uses GitLab's project issues endpoint; project paths are URL-encoded into `/projects/:id/issues`.

Field     |   Required | Description
-----------------|-----|------------
`search`         | yes | Search parameters (see below)
`promptTemplate` | yes | Template with issue placeholders (see below)
`gitlab`         | no  | Connection options. Defaults to `https://gitlab.com/api/v4` and token lookup from `GITLAB_TOKEN` then `GL_TOKEN`

Available template placeholders: `{{id}}`, `{{iid}}`, `{{project}}`, `{{title}}`, `{{url}}`, `{{state}}`, `{{author}}`, `{{assignee}}`, `{{assignees}}`, `{{labels}}`, `{{milestone}}`, `{{commentCount}}`, `{{createdAt}}`, `{{updatedAt}}`, `{{closedAt}}`, `{{description}}`.

Search parameters (`search` field):

Field              | Description
-------------------|------------
`project`          | Project to search, as a numeric project ID or namespaced path such as `gitlab-org/gitlab`
`state`            | Optional issue state: `opened`, `closed`, or `all`
`labels`           | Array of label names. GitLab returns issues that have all labels
`search`           | Search text matched against issue title and description
`milestone`        | Milestone title. GitLab also accepts `None` and `Any`
`authorUsername`   | Filter by author username
`assigneeUsername` | Filter by assignee username
`scope`            | Optional scope: `created_by_me`, `assigned_to_me`, or `all`
`orderBy`          | Optional GitLab sort field, for example `created_at`, `updated_at`, `priority`, or `due_date`
`sort`             | Optional sort order: `asc` or `desc`
`createdAfter`     | Return issues created on or after an ISO 8601 timestamp
`createdBefore`    | Return issues created on or before an ISO 8601 timestamp
`updatedAfter`     | Return issues updated on or after an ISO 8601 timestamp
`updatedBefore`    | Return issues updated on or before an ISO 8601 timestamp
`issueType`        | Filter to an issue type, for example `issue`, `incident`, `task`, or `test_case`
`confidential`     | Filter confidential or public issues
`perPage`          | Results per API page, from 1 to 100
`maxResults`       | Maximum number of issues to return across all pages
`dryRun`           | When true, skip the actual query and return an empty set
`logQuery`         | When true, log the query URL to stdout

Connection options (`gitlab` field):

Field       | Description
------------|------------
`origin`    | GitLab REST API origin. Defaults to `https://gitlab.com/api/v4`. For GitLab Self-Managed, use the API origin, for example `https://gitlab.example.com/api/v4`
`tokenEnv`  | Environment variable name from which to read an access token. Defaults to `GITLAB_TOKEN` then `GL_TOKEN`
`token`     | Access token value. Prefer `tokenEnv` for CLI configs so secrets do not need to be written into JSON
`userAgent` | User-Agent header value. Defaults to `loop-the-loop`

Config example:

```json
[
  "gitlab", {
    "gitlab": {
      "tokenEnv": "GITLAB_TOKEN"
    },
    "search": {
      "project": "gitlab-org/gitlab",
      "state": "opened",
      "labels": ["bug"],
      "orderBy": "updated_at",
      "sort": "desc",
      "maxResults": 25
    },
    "promptTemplate": "Triage {{id}}: {{title}}\nURL: {{url}}\nLabels: {{labels}}\nComment count: {{commentCount}}\n\n{{description}}"
  }
]
```

Source: `src/prompt-generators/gitlab.ts`, `src/prompt-generators/gitlab/`

### `json`

Iterates over elements of a JSON array or object and generates one prompt per element. The data can be supplied inline or loaded from a file.

Field            | Required | Description
-----------------|----------|------------
`data`           | one of `data`/`dataFile` | Inline JSON value (array or object) to iterate over
`dataFile`       | one of `data`/`dataFile` | Path to a JSON file to read. Resolved against the same base directory as `{{include:...}}` paths
`promptTemplate` | yes      | Template string with placeholder substitution (see below)
`path`           | no       | Dot-notation path into the JSON to reach the array or object to iterate (e.g. `"results.bugs"`). Defaults to the root value
`idField`        | no       | Field name on each element to use as the unique ID for state tracking. Defaults to the array index or object key

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

### `test`

Generates a fixed list of prompts from config. This is useful for exercising
loop behavior without querying external services or templating another data
source.

Field     | Required | Description
----------|----------|------------
`prompts` | yes      | Array of prompt strings to yield in order. Prompt IDs are stable stringified array indices.

Config example:

```json
[
  "test", {
    "prompts": [
      "Check that the first workflow succeeds.",
      "Check that the second workflow succeeds."
    ]
  }
]
```

Source: `src/prompt-generators/test.ts`

### `batch`

Wraps any other prompt generator and processes its items in fixed-size batches, injecting a summary prompt after each batch. This is useful when you want to run 50 bugs through an analysis agent, synthesise the results, then run the next 50 and synthesise again.

Field                   | Required | Default | Description
------------------------|----------|---------|------------
`source`                | yes      |         | The inner generator, specified as a `["generator-name", { ...config }]` tuple or a `PromptGenerator` instance
`summaryPromptTemplate` | yes      |         | Template for the summary prompt injected after each batch (see below)
`reportFile`            | yes      |         | Path to the report file the loop is writing to; injected as `{{reportFile}}` in the summary template
`batchSize`             | no       | 50      | Number of source items per batch

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

## Cost accounting and budgets

Every agent result can carry a cost record. The `costSource` field says how it was derived: `provider` means the backend reported a real USD figure (claude-sdk), `estimated` means Loop computed USD from token counts and the per-model `prices` you configured, and `unavailable` means token counts may be known but no USD figure was produced.

To get estimated costs from openai-sdk or codex-cli, add a `prices` map to the agent config keyed by model id, where each entry sets at least `inputPerMtok` and `outputPerMtok` (cache and reasoning rates default to multiples of those). claude-sdk reports cost directly and needs no `prices`.

Run totals persist in the loop-state file across resumes. Set a top-level `maxBudgetUsd`, or pass `--max-budget-usd N`, to cap lifetime spend: the loop stops after the prompt whose completion takes the total at or above the cap, and stops immediately at startup if the persisted total is already there. Results whose cost is `unavailable` record tokens but never advance the total. Omitting the cap is track-only mode.

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

Both prompt templates and the `claude-sdk` agent's `systemPrompt` support `{{include:path}}` macros that inline another file's contents. Relative paths are resolved against the config file directory for CLI JSON configs, and against the current working directory for programmatic callers (who can override by passing an explicit base path to the generator's constructor or `create()` factory). Includes are recursive and circular references are detected.

See `src/util/expand-prompt.ts` for the implementation.

## Examples

See the [`src/examples`](https://github.com/joewalker/loop-the-loop/tree/main/src/examples) folder for more examples.
