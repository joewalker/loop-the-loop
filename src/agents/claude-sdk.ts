import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { InvokeResult, SuccessfulInvocationResult } from '../types.js';
import type { Agent, InvokeOptions } from '../agents.js';

// istanbul ignore file

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];
const DEFAULT_MAX_TURNS = 100;

const permissionMode = 'acceptEdits'; // 'bypassPermissions'

export interface ClaudeSDKAgentConfig {
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
    return new ClaudeSDKAgent(config);
  }

  #config: ClaudeSDKAgentConfig;

  constructor(config?: ClaudeSDKAgentConfig) {
    this.#config = config ?? {};
  }

  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const {
      logger,
      allowedTools,
      systemPrompt,
      outputSchema,
      disallowedTools,
    } = options;

    const stderrChunks: Array<string> = [];
    try {
      const textParts: Array<string> = [];
      let structuredOutput: unknown;

      const toolSet = allowedTools ? [...allowedTools] : DEFAULT_TOOLS;
      const messages = query({
        prompt,
        options: {
          tools: toolSet,
          allowedTools: toolSet,
          permissionMode,
          maxTurns: this.#config.maxTurns ?? DEFAULT_MAX_TURNS,
          stderr: (data: string) => {
            stderrChunks.push(data);
          },
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(outputSchema !== undefined
            ? {
                outputFormat: {
                  type: 'json_schema' as const,
                  schema: outputSchema,
                },
              }
            : {}),
          ...(disallowedTools !== undefined
            ? { disallowedTools: [...disallowedTools] }
            : {}),
          ...(this.#config?.mcpServers !== undefined
            ? { mcpServers: this.#config.mcpServers }
            : {}),
        },
      });

      for await (const message of messages) {
        if (message.type === 'assistant') {
          // The SDK message shape includes message.content with text blocks.
          // We access these dynamically since the SDK types may not fully resolve.
          const content = (
            message as { message: { content: Array<Record<string, unknown>> } }
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
                : this.#config.maxTurns ?? DEFAULT_MAX_TURNS;
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
