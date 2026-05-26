import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  ToolCallError,
  ToolTimeoutError,
  UserError,
  run,
  type AgentOutputType,
  type JsonSchemaDefinition,
  type ModelSettings,
  type RunItem,
  type Tool,
} from '@openai/agents';
import {
  Capabilities,
  compaction,
  filesystem,
  localBindMountStrategy,
  mount,
  SandboxAgent,
  shell,
  type Capability,
  type ManifestInput,
  type SandboxAgentOptions,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

import type { Agent, InvokeOptions } from '../agents.js';
import type { Logger } from '../loggers.js';
import type {
  InvokeResult,
  OutputSchema,
  SuccessfulInvocationResult,
} from '../types.js';

// istanbul ignore file

const DEFAULT_MAX_TURNS = 100;
const SANDBOX_ROOT = '/workspace';
const SANDBOX_REPO_PATH = `${SANDBOX_ROOT}/repo`;
const OUTPUT_SCHEMA_NAME = 'LoopTheLoopOutput';

type OpenAISandboxAgentOptions = SandboxAgentOptions<unknown, AgentOutputType>;

export interface OpenAISDKAgentConfig {
  /**
   * Optional system prompt appended to the built-in workspace guidance.
   */
  readonly systemPrompt?: string;

  /**
   * When provided the agent should return structured data conforming to
   * this JSON Schema rather than free-form text.
   */
  readonly outputSchema?: OutputSchema;

  /**
   * Optional OpenAI model name. When omitted, the Agents SDK default is used.
   */
  readonly model?: string;

  /**
   * Optional model-specific settings forwarded to the Agents SDK.
   */
  readonly modelSettings?: ModelSettings;

  /**
   * Maximum number of agent turns per prompt invocation. Defaults to 100.
   */
  readonly maxTurns?: number;
}

/**
 * An implementation of the Agent interface that uses the OpenAI Agents SDK.
 */
export class OpenAISDKAgent implements Agent {
  static readonly agentName = 'openai-sdk';

  static async create(config?: OpenAISDKAgentConfig): Promise<Agent> {
    return new OpenAISDKAgent(config ?? {});
  }

  readonly #config: OpenAISDKAgentConfig;

  constructor(config: OpenAISDKAgentConfig = {}) {
    this.#config = config;
  }

  async invoke(
    prompt: string,
    invokeOptions: InvokeOptions,
  ): Promise<InvokeResult> {
    const { logger, allowSourceUpdate } = invokeOptions;
    const sourceUpdatesAllowed = allowSourceUpdate === true;

    try {
      const agent = new SandboxAgent(
        buildSandboxAgentOptions(
          this.#config,
          sourceUpdatesAllowed,
          process.cwd(),
        ),
      );
      const result = await run(agent, prompt, {
        maxTurns: this.#config.maxTurns ?? DEFAULT_MAX_TURNS,
        sandbox: {
          client: new UnixLocalSandboxClient(),
        },
      });

      logRunItems(result.newItems, logger);
      const invokeResult = normalizeFinalOutput(result.finalOutput);

      if (invokeResult.status === 'success') {
        logger.success('OpenAI SDK agent completed successfully');
      } else {
        logger.error(invokeResult.reason);
      }

      return invokeResult;
    } catch (error) {
      const reason = describeOpenAIError(error);
      const status = classifyOpenAIError(error, reason);
      logger.error(`OpenAI SDK agent exception: ${reason}`);
      return { status, reason };
    }
  }
}

/**
 * Build the SandboxAgent constructor options for a single Loop invocation.
 */
export function buildSandboxAgentOptions(
  config: OpenAISDKAgentConfig,
  allowSourceUpdate: boolean,
  cwd: string,
): OpenAISandboxAgentOptions {
  const options: OpenAISandboxAgentOptions = {
    name: 'Loop the Loop OpenAI SDK Agent',
    instructions: buildInstructions(config.systemPrompt, allowSourceUpdate),
    defaultManifest: buildSandboxManifest(cwd, allowSourceUpdate),
    capabilities: buildCapabilities(allowSourceUpdate),
  };

  if (config.model !== undefined) {
    options.model = config.model;
  }

  if (config.modelSettings !== undefined) {
    options.modelSettings = config.modelSettings;
  }

  if (config.outputSchema !== undefined) {
    options.outputType = toOpenAIOutputType(config.outputSchema);
  }

  return options;
}

/**
 * Build the sandbox manifest that exposes the current checkout to the agent.
 *
 * When `allowSourceUpdate` is false the repo mount is marked read-only so the
 * SDK editor tools (apply_patch, createFile, updateFile, deleteFile) refuse to
 * touch the host repo. Shell-level writes are filtered separately - see
 * `buildCapabilities` and `isDestructiveShellCommand` for that layer.
 */
export function buildSandboxManifest(
  cwd: string,
  allowSourceUpdate: boolean,
): ManifestInput {
  return {
    root: SANDBOX_ROOT,
    entries: {
      repo: mount({
        source: cwd,
        readOnly: !allowSourceUpdate,
        mountStrategy: localBindMountStrategy(),
      }),
    },
  };
}

/**
 * Choose sandbox capabilities for the current invocation mode.
 *
 * When `allowSourceUpdate` is false the shell capability is wrapped so that
 * `write_stdin` is dropped (it would let the agent feed mutating commands to a
 * long-running interactive shell, bypassing per-call inspection) and
 * `exec_command` is intercepted to reject commands that match the destructive
 * heuristic in `isDestructiveShellCommand`. The shell filter is best-effort -
 * see `isDestructiveShellCommand` for the security caveat.
 */
export function buildCapabilities(
  allowSourceUpdate: boolean,
): Array<Capability> {
  if (allowSourceUpdate) {
    return Capabilities.default();
  }

  return [
    filesystem({
      configureTools: tools =>
        tools.filter(tool => tool.name !== 'apply_patch'),
    }),
    shell({
      configureTools: tools => wrapShellToolsForReadOnly(tools),
    }),
    compaction(),
  ];
}

/**
 * Wrap shell-capability tools for read-only mode.
 *
 * Drops `write_stdin` entirely (no interactive feed bypass) and overrides
 * `exec_command`'s `invoke` so commands matching `isDestructiveShellCommand`
 * are rejected before the shell ever runs.
 */
export function wrapShellToolsForReadOnly(
  tools: ReadonlyArray<Tool<unknown>>,
): Array<Tool<unknown>> {
  const result: Array<Tool<unknown>> = [];
  for (const tool of tools) {
    if (tool.type !== 'function') {
      result.push(tool);
      continue;
    }
    if (tool.name === 'write_stdin') {
      continue;
    }
    if (tool.name === 'exec_command') {
      result.push(readOnlyExecCommand(tool));
      continue;
    }
    result.push(tool);
  }
  return result;
}

/**
 * Build a read-only-mode replacement for an exec_command FunctionTool whose
 * `invoke` rejects destructive commands before the shell sees them.
 */
function readOnlyExecCommand(
  original: Tool<unknown> & { readonly type: 'function' },
): Tool<unknown> {
  const guardedInvoke: typeof original.invoke = async (
    runContext,
    input,
    details,
  ) => {
    const cmd = extractExecCommandCmd(input);
    if (cmd !== undefined && isDestructiveShellCommand(cmd)) {
      return [
        'exec_command rejected: source updates are disabled for this invocation.',
        'The repository is mounted read-only and destructive shell commands',
        '(rm, mv, sed -i, output redirection, package installs, mutating git',
        'subcommands, etc.) are blocked. Use only read-only commands like rg,',
        'cat, ls, find.',
      ].join(' ');
    }
    return original.invoke(runContext, input, details);
  };
  return { ...original, invoke: guardedInvoke };
}

/**
 * Extract the `cmd` field from an exec_command tool input payload. Returns
 * undefined when the payload is not valid JSON or has no string `cmd` field;
 * callers fall through to the underlying tool which already handles invalid
 * input.
 */
function extractExecCommandCmd(input: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const cmd = parsed['cmd'];
  return typeof cmd === 'string' ? cmd : undefined;
}

/**
 * Heuristic detector for shell commands that would mutate the host file
 * system.
 *
 * Best-effort. This catches the obvious bypasses listed in issue #35
 * (output redirection, sed -i, rm, mv, tee, ...) but the space of shell
 * command shapes is unbounded and a determined model can craft new
 * bypasses. This is not a security boundary - for hard isolation use a
 * sandbox client that enforces filesystem permissions at the OS level (for
 * example the Docker sandbox).
 */
export function isDestructiveShellCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) {
    return false;
  }
  // Output redirection: > or >>. Allow numeric FD-redirects like 2>&1 and
  // pure stderr-merge "&>" but otherwise treat redirection as a write.
  if (/(?:^|[^0-9&])>>?(?!&)/u.test(trimmed)) {
    return true;
  }
  // In-place editor flags.
  if (/\b(?:sed|perl|ruby|awk|gawk)\b[^\n;|&]*\s-i(?:\b|$)/u.test(trimmed)) {
    return true;
  }
  // Destructive command tokens at the start of a sub-command.
  const destructive = [
    'rm',
    'mv',
    'cp',
    'tee',
    'dd',
    'truncate',
    'chmod',
    'chown',
    'chgrp',
    'ln',
    'touch',
    'mkdir',
    'rmdir',
    'install',
    'patch',
    'shred',
  ];
  const tokenStart = String.raw`(?:^|[;&|\x60"'$(])`;
  const tokenRe = new RegExp(
    `${tokenStart}\\s*(?:sudo(?:\\s+-\\S+)*\\s+)?(?:env(?:\\s+\\S+=\\S+)+\\s+)?(?:${destructive.join('|')})\\b`,
    'iu',
  );
  if (tokenRe.test(trimmed)) {
    return true;
  }
  // Mutating git subcommands.
  if (
    /\bgit\b[^\n;|&]*\s(?:add|rm|mv|commit|checkout|switch|reset|restore|stash|apply|am|merge|rebase|pull|fetch|clone|init|tag|push|clean|gc|prune|worktree)\b/u.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Mutating package-manager invocations.
  if (
    /\b(?:pnpm|npm|yarn|pnpx|npx|pip|pip3|cargo|brew|apt|apt-get|dnf|yum)\b\s+(?:i\b|install|add|remove|rm\b|update|upgrade|patch|publish)/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Convert Loop's JSON Schema shape into the wrapper shape expected by the
 * OpenAI Agents SDK.
 */
export function toOpenAIOutputType(
  outputSchema: OutputSchema,
): JsonSchemaDefinition {
  return {
    type: 'json_schema',
    name:
      typeof outputSchema['title'] === 'string' &&
      outputSchema['title'].trim().length > 0
        ? sanitizeOutputSchemaName(outputSchema['title'])
        : OUTPUT_SCHEMA_NAME,
    strict: outputSchema['additionalProperties'] === false,
    schema: outputSchema as JsonSchemaDefinition['schema'],
  };
}

/**
 * Convert a final SDK output value into Loop's InvokeResult shape.
 */
export function normalizeFinalOutput(finalOutput: unknown): InvokeResult {
  if (finalOutput === undefined) {
    return {
      status: 'error',
      reason: 'No output received from OpenAI SDK agent',
    };
  }

  if (typeof finalOutput === 'string') {
    return {
      status: 'success',
      output: finalOutput,
    };
  }

  return {
    status: 'success',
    output: stringifyStructuredOutput(finalOutput),
    structuredOutput: finalOutput,
  } satisfies SuccessfulInvocationResult;
}

/**
 * Classify an OpenAI Agents SDK failure as transient or fatal for the loop.
 */
export function classifyOpenAIError(
  error: unknown,
  reason = describeOpenAIError(error),
): 'glitch' | 'error' {
  if (error instanceof MaxTurnsExceededError) {
    return 'error';
  }

  if (
    error instanceof ModelRefusalError ||
    error instanceof ModelBehaviorError ||
    error instanceof UserError
  ) {
    return 'error';
  }

  if (error instanceof ToolTimeoutError) {
    return 'glitch';
  }

  if (
    error instanceof ToolCallError &&
    (error.error instanceof ToolTimeoutError ||
      isTransientOpenAIError(describeOpenAIError(error.error)))
  ) {
    return 'glitch';
  }

  return isTransientOpenAIError(reason) ? 'glitch' : 'error';
}

/**
 * Render an SDK error with useful structured fields when available.
 */
export function describeOpenAIError(error: unknown): string {
  if (error instanceof MaxTurnsExceededError) {
    return 'OpenAI SDK agent exhausted the configured maxTurns budget';
  }

  if (error instanceof ModelRefusalError) {
    return `OpenAI model refused to produce output: ${error.refusal}`;
  }

  if (error instanceof ToolTimeoutError) {
    return `OpenAI SDK tool '${error.toolName}' timed out after ${String(error.timeoutMs)}ms`;
  }

  if (error instanceof ToolCallError) {
    return `${error.name}: ${error.message}; cause: ${describeOpenAIError(error.error)}`;
  }

  if (error instanceof Error) {
    const fields = describeErrorFields(error);
    return fields.length > 0
      ? `${error.name}: ${error.message} (${fields.join(', ')})`
      : `${error.name}: ${error.message}`;
  }

  return String(error);
}

/**
 * Log a completed run's diagnostic items through Loop's existing logger.
 */
export function logRunItems(
  items: ReadonlyArray<RunItem>,
  logger: Logger,
): void {
  if (!logger.enabled) {
    return;
  }

  for (const item of items) {
    const formatted = formatRunItem(item);
    if (formatted === undefined) {
      continue;
    }

    logger[formatted.kind](formatted.text);
  }
}

interface FormattedRunItem {
  readonly kind: 'agent' | 'tool' | 'system';
  readonly text: string;
}

/**
 * Build the system instructions that adapt Loop prompts to the sandbox mount.
 */
function buildInstructions(
  systemPrompt: string | undefined,
  allowSourceUpdate: boolean,
): string {
  const sourceUpdateGuidance = allowSourceUpdate
    ? 'You may edit files in the mounted repository when the task requires it.'
    : [
        'Source updates are disabled for this invocation.',
        'Do not edit, create, move, or delete files in the mounted repository.',
        'The apply_patch tool is not available, the repo is mounted read-only, and destructive shell commands (rm, mv, sed -i, output redirection, etc.) will be rejected.',
      ].join(' ');
  const baseInstructions = [
    `The project checkout is mounted at ${SANDBOX_REPO_PATH}.`,
    `Treat repo-relative paths in user prompts as relative to ${SANDBOX_REPO_PATH}.`,
    `Run repository shell commands with ${SANDBOX_REPO_PATH} as the working directory.`,
    sourceUpdateGuidance,
  ].join('\n');

  return systemPrompt === undefined
    ? baseInstructions
    : `${baseInstructions}\n\n${systemPrompt}`;
}

/**
 * Convert a JSON Schema title into a valid SDK schema name.
 */
function sanitizeOutputSchemaName(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9_-]+/gu, '_');
  return sanitized.length > 0 ? sanitized : OUTPUT_SCHEMA_NAME;
}

/**
 * Render structured SDK output as the string form required by InvokeResult.
 */
function stringifyStructuredOutput(output: unknown): string {
  try {
    const text = JSON.stringify(output);
    return text === undefined ? String(output) : text;
  } catch {
    return String(output);
  }
}

/**
 * Return whether an SDK/API error string looks retryable.
 */
function isTransientOpenAIError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('tokens remaining') ||
    lower.includes('token limit') ||
    lower.includes('token quota') ||
    lower.includes('context window') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('429') ||
    lower.includes('api connection') ||
    lower.includes('connection error') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  );
}

/**
 * Extract common OpenAI API diagnostic fields from an Error object.
 */
function describeErrorFields(error: Error): Array<string> {
  const record = error as unknown as Record<string, unknown>;
  const fields: Array<string> = [];

  for (const field of ['status', 'code', 'type', 'param']) {
    const value = record[field];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      fields.push(`${field}=${String(value)}`);
    }
  }

  return fields;
}

/**
 * Convert an Agents SDK run item into one Loop logger line.
 */
function formatRunItem(item: RunItem): FormattedRunItem | undefined {
  const serialized = serializeRunItem(item);
  const rawItem = serialized['rawItem'];
  const rawItemRecord = isRecord(rawItem) ? rawItem : undefined;
  const rawType = rawItemRecord?.['type'];
  const itemType = serialized['type'];

  if (rawItemRecord?.['role'] === 'assistant') {
    const text = extractAssistantText(rawItemRecord);
    return text === undefined ? undefined : { kind: 'agent', text };
  }

  if (rawItemRecord !== undefined && typeof rawType === 'string') {
    if (rawType.endsWith('_call')) {
      return { kind: 'tool', text: formatToolCall(rawItemRecord, rawType) };
    }

    if (rawType.endsWith('_output') || rawType.endsWith('_result')) {
      return { kind: 'tool', text: formatToolResult(rawItemRecord, rawType) };
    }
  }

  return typeof itemType === 'string'
    ? { kind: 'system', text: `[${itemType}]` }
    : undefined;
}

/**
 * Safely serialize a RunItem to the public JSON shape when possible.
 */
function serializeRunItem(item: RunItem): Record<string, unknown> {
  const maybeSerializable = item as unknown as {
    toJSON?: () => unknown;
  };
  const serialized = maybeSerializable.toJSON?.() ?? item;
  return isRecord(serialized) ? serialized : {};
}

/**
 * Extract text and refusals from an assistant message item.
 */
function extractAssistantText(
  rawItem: Record<string, unknown>,
): string | undefined {
  const content = rawItem['content'];
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: Array<string> = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }

    if (typeof block['text'] === 'string') {
      textParts.push(block['text']);
    }

    if (typeof block['refusal'] === 'string') {
      textParts.push(`refusal: ${block['refusal']}`);
    }
  }

  return textParts.length === 0 ? undefined : textParts.join('\n');
}

/**
 * Render a model tool call as a compact diagnostic line.
 */
function formatToolCall(
  rawItem: Record<string, unknown>,
  rawType: string,
): string {
  if (rawType === 'function_call' && typeof rawItem['name'] === 'string') {
    return `${rawItem['name']}(${String(rawItem['arguments'] ?? '')})`;
  }

  if (rawType === 'shell_call') {
    const action = rawItem['action'];
    if (isRecord(action) && Array.isArray(action['commands'])) {
      return `shell(${action['commands'].join(' ')})`;
    }
  }

  if (rawType === 'apply_patch_call') {
    const operation = rawItem['operation'];
    if (isRecord(operation) && typeof operation['path'] === 'string') {
      return `apply_patch(${operation['path']})`;
    }
  }

  return rawType;
}

/**
 * Render a tool result as a compact diagnostic line.
 */
function formatToolResult(
  rawItem: Record<string, unknown>,
  rawType: string,
): string {
  const status = rawItem['status'];
  if (typeof status === 'string') {
    return `${rawType}: ${status}`;
  }

  const output = rawItem['output'];
  if (typeof output === 'string' && output.length > 0) {
    return `${rawType}: ${output}`;
  }

  return rawType;
}

/**
 * Narrow an unknown value to an object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
