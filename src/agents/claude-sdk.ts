import {
  query,
  type McpServerConfig,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';

import type { Agent, InvokeOptions } from '../agents.js';
import type {
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
          const msg = message as Record<string, unknown>;
          const toolName =
            'tool_name' in msg ? String(msg['tool_name']) : 'unknown';
          const status = 'status' in msg ? String(msg['status']) : '';
          logger.tool(`Summary: ${toolName} -> ${status}`);
        }

        if (message.type === 'system') {
          const msg = message as { subtype?: string; message?: string };
          logger.system(`[${msg.subtype ?? 'system'}] ${msg.message ?? ''}`);
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
            return ClaudeSDKAgent.#successResult(finalText, structuredOutput);
          }

          const resultMsg = message as Record<string, unknown>;
          if (message.subtype === 'error_max_turns') {
            const numTurns =
              typeof resultMsg['num_turns'] === 'number'
                ? resultMsg['num_turns']
                : (this.#config.maxTurns ?? DEFAULT_MAX_TURNS);
            const reason = `Prompt failed: agent exhausted all ${numTurns} turns without completing. Increase maxTurns in the claude-sdk agent config to allow more work per prompt.`;
            logger.error(reason);
            return { status: 'error', reason };
          }

          const reason = this.#buildErrorReason(
            this.#describeResultError(message.subtype, resultMsg),
            stderrChunks,
          );
          logger.error(`Agent result: ${reason}`);
          const status = classifyResultStatus(
            message.subtype,
            resultMsg,
            reason,
          );
          return { status, reason };
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

  static #successResult(
    output: string,
    structuredOutput: unknown,
  ): SuccessfulInvocationResult {
    return {
      status: 'success',
      output,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    };
  }

  /**
   * Builds a descriptive error message from a non-success result message,
   * including the subtype and any error/message fields present on the result.
   */
  #describeResultError(
    subtype: string | undefined,
    resultMsg: Record<string, unknown>,
  ): string {
    const parts: Array<string> = [`subtype=${subtype ?? 'unknown'}`];
    if (typeof resultMsg['error'] === 'string' && resultMsg['error']) {
      parts.push(`error=${resultMsg['error']}`);
    }
    if (typeof resultMsg['message'] === 'string' && resultMsg['message']) {
      parts.push(`message=${resultMsg['message']}`);
    }
    return `Agent invocation failed (${parts.join(', ')})`;
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

  return {
    ...loadedTools,
    ...allowedTools,
    ...systemPrompt,
    ...outputSchema,
    ...disallowedTools,
    ...mcpServers,
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
