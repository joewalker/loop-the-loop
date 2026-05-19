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

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];
const DEFAULT_MAX_TURNS = 100;

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
   * permission. When omitted the agent falls back to its own defaults.
   */
  readonly allowedTools?: ReadonlyArray<string>;

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
            return ClaudeSDKAgent.#successResult(textParts, structuredOutput);
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
          const status = this.#isTokenLimitError(reason) ? 'glitch' : 'error';
          return { status, reason };
        }
      }

      // If we get here without a result message, treat the collected text as the output
      return textParts.length > 0
        ? ClaudeSDKAgent.#successResult(textParts, structuredOutput)
        : { status: 'error', reason: 'No output received from agent' };
    } catch (err) {
      const reason = this.#buildErrorReason(
        err instanceof Error ? err.message : String(err),
        stderrChunks,
      );
      logger.error(`Agent exception: ${reason}`);
      const status = this.#isTokenLimitError(reason) ? 'glitch' : 'error';
      return { status, reason };
    }
  }

  static #successResult(
    textParts: ReadonlyArray<string>,
    structuredOutput: unknown,
  ): SuccessfulInvocationResult {
    return {
      status: 'success',
      output: textParts.join('\n'),
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

  #isTokenLimitError(text: string): boolean {
    // TODO: This is a bit wooly. Is there a error id associated with this?
    return (
      text.includes('token') ||
      text.includes('rate_limit') ||
      text.includes('quota')
    );
  }
}

/**
 * Split a user-provided tool list into the two shapes the Claude Agent SDK
 * expects. The SDK's `tools` option restricts which tools are *loaded* and
 * accepts only bare names (e.g. `"Bash"`). Its `allowedTools` option is the
 * auto-approval list and accepts both bare names and permission patterns
 * (e.g. `"Bash(gh issue create *)"`).
 *
 * The caller writes a single flat list mixing the two forms; this helper
 * pulls bare names (stripping any `(...)` suffix) for `tools`, deduplicates
 * them, and returns the original list unchanged for `allowedTools`.
 */
export function configureQueryOptions(
  config: ClaudeSDKAgentConfig,
  allowSourceUpdate = false,
): Options {
  const tools = config.allowedTools ?? DEFAULT_TOOLS;
  const bareNames = new Set<string>();
  for (const tool of tools) {
    const parenIdx = tool.indexOf('(');
    const bare = (parenIdx === -1 ? tool : tool.slice(0, parenIdx)).trim();
    if (bare.length > 0) {
      bareNames.add(bare);
    }
  }

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

  const disallowedTools =
    config.disallowedTools !== undefined
      ? { disallowedTools: [...config.disallowedTools] }
      : {};

  const mcpServers =
    config?.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {};

  return {
    tools: [...bareNames],
    allowedTools: [...tools],
    ...systemPrompt,
    ...outputSchema,
    ...disallowedTools,
    ...mcpServers,
    permissionMode: allowSourceUpdate ? 'acceptEdits' : 'default',
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
  };
}
