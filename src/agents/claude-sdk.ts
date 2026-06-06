import {
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKToolUseSummaryMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { Agent, InvokeOptions } from '../agents.js';
import type { CheckResult } from '../doctor.js';
import type {
  CostInfo,
  InvokeResult,
  OutputSchema,
  SuccessfulInvocationResult,
} from '../types.js';

// istanbul ignore file

const DEFAULT_MAX_TURNS = 100;

/**
 * Shape accepted by the Claude Agent SDK's `tools` option. Either an
 * explicit list of built-in tool names (or `[]` to disable all built-in
 * tools) or the `claude_code` preset to load the full default set.
 */
export type ClaudeSDKLoadedTools =
  | ReadonlyArray<string>
  | { readonly type: 'preset'; readonly preset: 'claude_code' };

export interface ClaudeSDKAgentConfig {
  /**
   * Optional system prompt prepended to the conversation.
   */
  readonly systemPrompt?: string;

  /**
   * When provided the agent should return structured data conforming to
   * this JSON Schema rather than (or in addition to) free-form text.
   * Not all agents support this; unsupported agents may ignore it.
   */
  readonly outputSchema?: OutputSchema;

  /**
   * Tool names that should be auto-allowed without prompting for
   * permission. Both bare names (e.g. `"Read"`) and permission patterns
   * (e.g. `"Bash(gh issue create *)"`) are accepted and are forwarded
   * unchanged to the SDK's `allowedTools` option.
   *
   * This list controls auto-approval only and does NOT restrict which
   * tools the model can see. To control which built-in tools are loaded,
   * use `loadedTools`. When `loadedTools` is omitted the SDK falls back
   * to its own default set (the `claude_code` preset).
   */
  readonly allowedTools?: ReadonlyArray<string>;

  /**
   * Controls which built-in tools are loaded into the model's context
   * (the SDK's `tools` option):
   *
   * - An array of tool names enables only those built-in tools.
   * - `[]` (an empty array) disables all built-in tools.
   * - `{ type: 'preset', preset: 'claude_code' }` loads the full
   *   Claude Code preset.
   *
   * When omitted the agent passes no `tools` option to the SDK, which
   * means the SDK uses its own default (the `claude_code` preset). This
   * is independent of `allowedTools`, which only controls auto-approval.
   */
  readonly loadedTools?: ClaudeSDKLoadedTools;

  /**
   * Tool names that are explicitly blocked. The agent must ensure these
   * tools cannot be invoked.
   */
  readonly disallowedTools?: ReadonlyArray<string>;

  /**
   * MCP (Model Context Protocol) server configurations.
   * Keys are server names, values are server configurations.
   */
  readonly mcpServers?: Record<string, McpServerConfig>;

  /**
   * Maximum number of agent turns (tool-use/response rounds) allowed per
   * prompt invocation. Defaults to `DEFAULT_MAX_TURNS` when omitted.
   */
  readonly maxTurns?: number;

  /**
   * Claude model to use. Accepts an alias (`sonnet`, `opus`, `haiku`) or a
   * full model id (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`). When
   * omitted the SDK falls back to its CLI default.
   */
  readonly model?: string;

  /**
   * Fallback model used when the primary model is unavailable (e.g. rate
   * limited or temporarily down). Forwarded to the SDK's `fallbackModel`.
   */
  readonly fallbackModel?: string;

  /**
   * Reasoning effort applied per turn. The SDK silently downgrades
   * unsupported levels per model; see the SDK docs for which models
   * support which level.
   */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /**
   * Extended-thinking configuration. `{ type: 'adaptive' }` lets the
   * model decide (default on Opus 4.6+); `{ type: 'enabled', budgetTokens: N }`
   * fixes a budget; `{ type: 'disabled' }` turns thinking off.
   */
  readonly thinking?:
    | { readonly type: 'adaptive' }
    | { readonly type: 'enabled'; readonly budgetTokens: number }
    | { readonly type: 'disabled' };

  /**
   * Additional absolute directories the agent may read/write. Forwarded
   * unchanged to the SDK's `additionalDirectories`.
   */
  readonly additionalDirectories?: ReadonlyArray<string>;
}

/**
 * An implementation of the Agent interface that uses Claude via the official
 * SDK.
 */
export class ClaudeSDKAgent implements Agent {
  static readonly agentName = 'claude-sdk';

  static async create(config?: ClaudeSDKAgentConfig): Promise<Agent> {
    return new ClaudeSDKAgent(config ?? {});
  }

  readonly #config: ClaudeSDKAgentConfig;

  constructor(config: ClaudeSDKAgentConfig) {
    this.#config = config;
  }

  async invoke(
    prompt: string,
    invokeOptions: InvokeOptions,
  ): Promise<InvokeResult> {
    const { logger, allowSourceUpdate } = invokeOptions;
    const options = configureQueryOptions(this.#config, allowSourceUpdate);

    const stderrChunks: Array<string> = [];
    try {
      const textParts: Array<string> = [];
      let structuredOutput: unknown;

      const messages = query({
        prompt,
        options: {
          ...options,
          stderr: (data: string) => {
            stderrChunks.push(data);
          },
        },
      });

      for await (const message of messages) {
        if (message.type === 'assistant') {
          // The SDK message shape includes message.content with text blocks.
          // We access these dynamically since the SDK types may not fully resolve.
          const content = (
            message as unknown as {
              message: { content: Array<Record<string, unknown>> };
            }
          ).message.content;
          for (const block of content) {
            if (typeof block['text'] === 'string') {
              textParts.push(block['text']);
              logger.agent(block['text']);
            }
            if (block['type'] === 'tool_use') {
              logger.tool(
                `${String(block['name'])}(${JSON.stringify(block['input'])})`,
              );
            }
          }
        }

        if (message.type === 'tool_use_summary') {
          logger.tool(formatToolUseSummary(message));
        }

        if (message.type === 'system') {
          logger.system(formatSystemMessage(message));
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            logger.success('Agent completed successfully');
            const resultMsg = message as Record<string, unknown>;
            if (resultMsg['structured_output'] !== undefined) {
              structuredOutput = resultMsg['structured_output'];
            }
            // Prefer the SDK's final-answer `result` field over the accumulated
            // intermediate assistant text. The text-block accumulation is kept
            // only as a fallback when the SDK omits `result`.
            const finalText =
              typeof resultMsg['result'] === 'string'
                ? resultMsg['result']
                : textParts.join('\n');
            return ClaudeSDKAgent.#successResult(
              finalText,
              structuredOutput,
              extractClaudeCost(resultMsg),
            );
          }

          const resultMsg = message as Record<string, unknown>;
          if (message.subtype === 'error_max_turns') {
            const numTurns =
              typeof resultMsg['num_turns'] === 'number'
                ? resultMsg['num_turns']
                : (this.#config.maxTurns ?? DEFAULT_MAX_TURNS);
            const reason = `Prompt failed: agent exhausted all ${numTurns} turns without completing. Increase maxTurns in the claude-sdk agent config to allow more work per prompt.`;
            logger.error(reason);
            return {
              status: 'error',
              reason,
              cost: extractClaudeCost(resultMsg),
            };
          }

          const reason = this.#buildErrorReason(
            describeResultError(message.subtype, resultMsg),
            stderrChunks,
          );
          logger.error(`Agent result: ${reason}`);
          const status = classifyResultStatus(
            message.subtype,
            resultMsg,
            reason,
          );
          return { status, reason, cost: extractClaudeCost(resultMsg) };
        }
      }

      // If we get here without a result message, treat the collected text as the output
      return textParts.length > 0
        ? ClaudeSDKAgent.#successResult(textParts.join('\n'), structuredOutput)
        : { status: 'error', reason: 'No output received from agent' };
    } catch (err) {
      const reason = this.#buildErrorReason(
        err instanceof Error ? err.message : String(err),
        stderrChunks,
      );
      logger.error(`Agent exception: ${reason}`);
      const status = isTokenLimitError(reason) ? 'glitch' : 'error';
      return { status, reason };
    }
  }

  /**
   * Preflight probe used by `--doctor`.
   *
   * Probes, in order: the SDK module loaded (`query` is callable),
   * credentials are present in the environment, the stored config has a
   * valid shape, and (only when credentials are present) a minimal live
   * `query()` succeeds. Probe failures are reported as results rather than
   * thrown.
   */
  async *check(): AsyncIterable<CheckResult> {
    yield typeof query === 'function'
      ? { name: 'SDK module loaded', status: 'ok' }
      : { name: 'SDK module loaded', status: 'fail' };

    const hasCredentials =
      hasEnv('ANTHROPIC_API_KEY') || hasEnv('CLAUDE_CODE_OAUTH_TOKEN');
    yield hasCredentials
      ? { name: 'credentials present', status: 'ok' }
      : {
          name: 'credentials present',
          status: 'fail',
          message: 'set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN',
        };

    const badField = invalidConfigField(this.#config);
    yield badField === undefined
      ? { name: 'config shape valid', status: 'ok' }
      : {
          name: 'config shape valid',
          status: 'fail',
          message: `invalid ${badField}`,
        };

    if (!hasCredentials) {
      yield { name: 'query probe', status: 'skip', message: 'no credentials' };
      return;
    }
    yield await this.#probeQuery();
  }

  /**
   * Run the smallest possible live `query()` and iterate its first message.
   * Any error (network, auth, quota) is reported as a fail with the cause.
   */
  async #probeQuery(): Promise<CheckResult> {
    try {
      const messages = query({
        prompt: 'ping',
        options: {
          ...(this.#config.model !== undefined
            ? { model: this.#config.model }
            : {}),
          maxTurns: 1,
          tools: [],
          allowedTools: [],
          permissionMode: 'default',
        },
      });
      for await (const _message of messages) {
        break;
      }
      return { name: 'query probe', status: 'ok' };
    } catch (err) {
      return {
        name: 'query probe',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      };
    }
  }

  static #successResult(
    output: string,
    structuredOutput: unknown,
    cost?: CostInfo,
  ): SuccessfulInvocationResult {
    return {
      status: 'success',
      output,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
  }

  /**
   * Combines an error message with any captured stderr output to provide
   * more diagnostic context when the Claude Code process fails.
   */
  #buildErrorReason(
    message: string,
    stderrChunks: ReadonlyArray<string>,
  ): string {
    const stderr = stderrChunks.join('').trim();
    if (stderr.length === 0) {
      return message;
    }
    return `${message}\nstderr: ${stderr}`;
  }
}

/**
 * Return whether an environment variable is set to a non-empty value.
 */
function hasEnv(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.length > 0;
}

/**
 * Return whether a value is a plain (non-array) object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a `CostInfo` from a claude-sdk result message. The SDK reports a
 * real USD figure (`total_cost_usd`) so `costSource` is always `'provider'`.
 * The model is taken from `modelUsage` only when it has exactly one key.
 */
export function extractClaudeCost(
  resultMsg: Record<string, unknown>,
): CostInfo {
  const usage = asRecord(resultMsg['usage']);
  const modelUsage = asRecord(resultMsg['modelUsage']);
  const models = Object.keys(modelUsage);
  const model = models.length === 1 ? models[0] : undefined;

  return {
    usd:
      typeof resultMsg['total_cost_usd'] === 'number'
        ? resultMsg['total_cost_usd']
        : 0,
    costSource: 'provider',
    ...numericField('inputTokens', usage['input_tokens']),
    ...numericField('outputTokens', usage['output_tokens']),
    ...numericField('cacheReadTokens', usage['cache_read_input_tokens']),
    ...numericField(
      'cacheCreationTokens',
      usage['cache_creation_input_tokens'],
    ),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Narrow an unknown value to a record, defaulting to an empty object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/**
 * Return `{ [key]: value }` when `value` is a finite number, otherwise an
 * empty object so the field is omitted from the spread.
 */
function numericField(key: string, value: unknown): Record<string, number> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { [key]: value }
    : {};
}

/**
 * Validate the doctor-relevant fields of a `ClaudeSDKAgentConfig` and return
 * the name of the first field with the wrong shape, or undefined when the
 * config is well-formed. Used by `check()` to flag a misconfigured agent
 * before any network call.
 */
function invalidConfigField(config: ClaudeSDKAgentConfig): string | undefined {
  if (
    config.outputSchema !== undefined &&
    !isPlainObject(config.outputSchema)
  ) {
    return 'outputSchema (expected an object)';
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    return 'model (expected a string)';
  }
  if (
    config.allowedTools !== undefined &&
    !Array.isArray(config.allowedTools)
  ) {
    return 'allowedTools (expected an array)';
  }
  if (config.loadedTools !== undefined) {
    const loaded = config.loadedTools;
    const valid =
      Array.isArray(loaded) ||
      (isPlainObject(loaded) && loaded['type'] === 'preset');
    if (!valid) {
      return 'loadedTools (expected an array or a preset object)';
    }
  }
  return undefined;
}

/**
 * Build a descriptive failure reason from a non-success SDK result
 * message. Surfaces the structured fields the SDK actually populates
 * (`errors: string[]`, `terminal_reason`, `stop_reason`) so callers can
 * tell what went wrong instead of seeing only `subtype=...`.
 *
 * Per `SDKResultError` in `@anthropic-ai/claude-agent-sdk/sdk.d.ts`, the
 * diagnostic text lives on `errors: string[]`. The legacy `error` and
 * `message` field reads are kept as a defensive fallback in case the
 * SDK shape changes or a non-standard transport synthesises a result.
 * See joewalker/loop-the-loop#6.
 */
export function describeResultError(
  subtype: string | undefined,
  resultMsg: Record<string, unknown>,
): string {
  const parts: Array<string> = [`subtype=${subtype ?? 'unknown'}`];

  const rawErrors = resultMsg['errors'];
  if (Array.isArray(rawErrors)) {
    const errorStrings = rawErrors.filter(
      (e): e is string => typeof e === 'string' && e.length > 0,
    );
    if (errorStrings.length > 0) {
      parts.push(`errors=${errorStrings.join('; ')}`);
    }
  }

  const terminalReason = resultMsg['terminal_reason'];
  if (typeof terminalReason === 'string' && terminalReason) {
    parts.push(`terminal_reason=${terminalReason}`);
  }

  const stopReason = resultMsg['stop_reason'];
  if (typeof stopReason === 'string' && stopReason) {
    parts.push(`stop_reason=${stopReason}`);
  }

  // Defensive fallback: older or alternative shapes may put diagnostic
  // text on `error` or `message` instead of (or in addition to) the
  // `errors` array.
  if (typeof resultMsg['error'] === 'string' && resultMsg['error']) {
    parts.push(`error=${resultMsg['error']}`);
  }
  if (typeof resultMsg['message'] === 'string' && resultMsg['message']) {
    parts.push(`message=${resultMsg['message']}`);
  }

  return `Agent invocation failed (${parts.join(', ')})`;
}

/**
 * Classify a non-success SDK result as either a transient `glitch`
 * (which the loop tolerates up to `MAX_CONSECUTIVE_GLITCHES`) or a
 * fatal `error` (which aborts the loop immediately).
 *
 * The SDK exposes structured failure shapes that are far more reliable
 * than substring sniffing, so this helper checks those first:
 *
 * - The `error_max_budget_usd` result subtype signals that the
 *   configured cost cap was reached and should be treated as transient.
 * - The `blocking_limit` and `rapid_refill_breaker` terminal reasons
 *   are the SDK's typed rate-limit signals.
 *
 * Only when no structured signal applies do we fall back to substring
 * matching via `isTokenLimitError`. See joewalker/loop-the-loop#8.
 */
export function classifyResultStatus(
  subtype: string | undefined,
  resultMsg: Record<string, unknown>,
  reason: string,
): 'glitch' | 'error' {
  if (subtype === 'error_max_budget_usd') {
    return 'glitch';
  }
  const terminalReason = resultMsg['terminal_reason'];
  if (
    terminalReason === 'blocking_limit' ||
    terminalReason === 'rapid_refill_breaker'
  ) {
    return 'glitch';
  }
  return isTokenLimitError(reason) ? 'glitch' : 'error';
}

/**
 * Return whether SDK error text looks like a transient token/quota or
 * rate-limit failure. The patterns are deliberately narrow because the
 * bare word `token` matches far too many unrelated errors (tokenisers,
 * OAuth tokens, JWTs, "Unexpected token" JSON parse errors, etc.) and
 * would otherwise cause the loop to retry real prompt errors up to
 * `MAX_CONSECUTIVE_GLITCHES` times.
 *
 * Matching is case-insensitive so that capitalised HTTP status text
 * like `"HTTP 429: Rate limit exceeded"` is recognised as a glitch.
 * See joewalker/loop-the-loop#8 and #14.
 */
export function isTokenLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('tokens remaining') ||
    lower.includes('token limit') ||
    lower.includes('token quota') ||
    lower.includes('context window') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('429')
  );
}

/**
 * Render a `tool_use_summary` SDK message as a single line for the
 * verbose logger.
 *
 * The SDK shape is `{ type: 'tool_use_summary', summary, preceding_tool_use_ids,
 * uuid, session_id }` (see `SDKToolUseSummaryMessage` in the SDK types).
 * Earlier code read `tool_name` and `status` here, which the SDK does not
 * populate, so every line read "Summary: unknown -> ". See
 * joewalker/loop-the-loop#9.
 */
export function formatToolUseSummary(
  message: SDKToolUseSummaryMessage,
): string {
  const n = message.preceding_tool_use_ids.length;
  const noun = n === 1 ? 'use' : 'uses';
  return `Summary (${n} tool ${noun}): ${message.summary}`;
}

/**
 * Render a `type: 'system'` SDK message as a single line for the verbose
 * logger.
 *
 * The `type: 'system'` union has many subtypes and none of them carry a
 * top-level `message: string` field, so the previous "[subtype] message"
 * format always printed an empty body. This helper narrows on the known
 * subtypes and picks a descriptive field per shape, with a JSON-stringify
 * fallback so newly-added subtypes still surface something useful. See
 * joewalker/loop-the-loop#9.
 */
export function formatSystemMessage(
  message: Extract<SDKMessage, { type: 'system' }>,
): string {
  switch (message.subtype) {
    case 'init': {
      const mcpCount = message.mcp_servers.length;
      return `[init] model=${message.model}, tools=${message.tools.length}, mcp_servers=${mcpCount}, permissionMode=${message.permissionMode}`;
    }
    case 'status': {
      const parts = [`status=${message.status ?? 'idle'}`];
      if (message.compact_result !== undefined) {
        parts.push(`compact_result=${message.compact_result}`);
      }
      if (
        message.compact_error !== undefined &&
        message.compact_error.length > 0
      ) {
        parts.push(`compact_error=${message.compact_error}`);
      }
      return `[status] ${parts.join(', ')}`;
    }
    case 'session_state_changed':
      return `[session_state_changed] state=${message.state}`;
    case 'task_started':
      return `[task_started] ${message.description}`;
    case 'task_progress': {
      const summary =
        message.summary !== undefined ? ` - ${message.summary}` : '';
      return `[task_progress] ${message.description}${summary}`;
    }
    case 'task_notification':
      return `[task_notification] ${message.status}: ${message.summary}`;
    case 'task_updated': {
      const patchKeys = Object.keys(message.patch);
      return `[task_updated] ${patchKeys.join(', ')}`;
    }
    case 'compact_boundary':
      return `[compact_boundary] trigger=${message.compact_metadata.trigger}, pre_tokens=${message.compact_metadata.pre_tokens}`;
    default: {
      // Forward-compat fallback: serialize the message minus bookkeeping
      // fields so any subtype we haven't enumerated still surfaces useful
      // detail in the verbose log.
      const {
        type: _type,
        uuid: _uuid,
        session_id: _sid,
        ...rest
      } = message as Record<string, unknown> & {
        type: unknown;
        uuid: unknown;
        session_id: unknown;
      };
      const subtype =
        typeof rest['subtype'] === 'string' ? rest['subtype'] : 'system';
      return `[${subtype}] ${JSON.stringify(rest)}`;
    }
  }
}

/**
 * Translate a `ClaudeSDKAgentConfig` into the `Options` object accepted
 * by the Claude Agent SDK's `query()`.
 *
 * The SDK exposes two related but independent options:
 *
 * - `tools` (the load list): controls which built-in tools are loaded
 *   into the model's context. Accepts bare names, `[]` to disable all
 *   built-in tools, or the `claude_code` preset. We surface this as
 *   `loadedTools` on `ClaudeSDKAgentConfig` and only forward it when the
 *   caller has set it explicitly. When omitted the SDK falls back to
 *   its own default set (the `claude_code` preset).
 *
 * - `allowedTools` (the auto-approval list): the set of tool names or
 *   permission patterns whose invocations are auto-approved without
 *   prompting. This is forwarded unchanged from `config.allowedTools`.
 *
 * Earlier versions of this function derived the SDK's `tools` option
 * from `allowedTools` by extracting bare names. That conflated the two
 * concerns and meant an empty `allowedTools` accidentally disabled
 * every built-in tool (see joewalker/loop-the-loop#11).
 */
export function configureQueryOptions(
  config: ClaudeSDKAgentConfig,
  allowSourceUpdate = false,
): Options {
  const systemPrompt =
    config.systemPrompt !== undefined
      ? { systemPrompt: config.systemPrompt }
      : {};

  const outputSchema =
    config.outputSchema !== undefined
      ? {
          outputFormat: {
            type: 'json_schema' as const,
            schema: config.outputSchema,
          },
        }
      : {};

  const allowedTools =
    config.allowedTools !== undefined
      ? { allowedTools: [...config.allowedTools] }
      : {};

  const loadedTools =
    config.loadedTools !== undefined
      ? { tools: normalizeLoadedTools(config.loadedTools) }
      : {};

  const disallowedTools =
    config.disallowedTools !== undefined
      ? { disallowedTools: [...config.disallowedTools] }
      : {};

  const mcpServers =
    config?.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {};

  const model = config.model !== undefined ? { model: config.model } : {};

  const fallbackModel =
    config.fallbackModel !== undefined
      ? { fallbackModel: config.fallbackModel }
      : {};

  const effort = config.effort !== undefined ? { effort: config.effort } : {};

  const thinking =
    config.thinking !== undefined ? { thinking: { ...config.thinking } } : {};

  const additionalDirectories =
    config.additionalDirectories !== undefined
      ? { additionalDirectories: [...config.additionalDirectories] }
      : {};

  return {
    ...loadedTools,
    ...allowedTools,
    ...systemPrompt,
    ...outputSchema,
    ...disallowedTools,
    ...mcpServers,
    ...model,
    ...fallbackModel,
    ...effort,
    ...thinking,
    ...additionalDirectories,
    permissionMode: allowSourceUpdate ? 'acceptEdits' : 'default',
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
  };
}

/**
 * Convert a `ClaudeSDKLoadedTools` value (which may use `ReadonlyArray`)
 * into the mutable shape the SDK's `Options.tools` expects.
 */
function normalizeLoadedTools(
  loadedTools: ClaudeSDKLoadedTools,
): Array<string> | { type: 'preset'; preset: 'claude_code' } {
  if (Array.isArray(loadedTools)) {
    return [...loadedTools];
  }
  return { ...(loadedTools as { type: 'preset'; preset: 'claude_code' }) };
}
