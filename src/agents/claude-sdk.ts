import { query } from '@anthropic-ai/claude-agent-sdk';

import type { InvokeResult, SuccessfulInvocationResult } from '../types.js';
import type { Agent, InvokeOptions } from './agents.js';

// istanbul ignore file

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];
const DEFAULT_MAX_TURNS = 5;

const permissionMode = 'acceptEdits'; // 'bypassPermissions'

/**
 * An implementation of the Agent interface that uses Claude via the official
 * SDK.
 */
export class ClaudeSDKAgent implements Agent {
  static readonly agentName = 'claude-sdk';

  async invoke(prompt: string, options?: InvokeOptions): Promise<InvokeResult> {
    try {
      const textParts: Array<string> = [];
      let structuredOutput: unknown;

      const messages = query({
        prompt,
        options: {
          allowedTools: options?.allowedTools
            ? [...options.allowedTools]
            : DEFAULT_TOOLS,
          permissionMode,
          maxTurns: DEFAULT_MAX_TURNS,
          ...(options?.systemPrompt !== undefined
            ? { systemPrompt: options.systemPrompt }
            : {}),
          ...(options?.outputSchema !== undefined
            ? {
                outputFormat: {
                  type: 'json_schema' as const,
                  schema: options.outputSchema,
                },
              }
            : {}),
          ...(options?.disallowedTools !== undefined
            ? { disallowedTools: [...options.disallowedTools] }
            : {}),
          ...(options?.mcpServers !== undefined
            ? { mcpServers: options.mcpServers }
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
            }
          }
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            const resultMsg = message as Record<string, unknown>;
            if (resultMsg['structured_output'] !== undefined) {
              structuredOutput = resultMsg['structured_output'];
            }
            return ClaudeSDKAgent.#successResult(textParts, structuredOutput);
          }

          const reason =
            'error' in message ? String(message.error) : 'Unknown error';
          const status = this.#isTokenLimitError(reason) ? 'glitch' : 'error';
          return { status, reason };
        }
      }

      // If we get here without a result message, treat the collected text as the output
      return textParts.length > 0
        ? ClaudeSDKAgent.#successResult(textParts, structuredOutput)
        : { status: 'error', reason: 'No output received from agent' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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

  #isTokenLimitError(text: string): boolean {
    // TODO: This is a bit wooly. Is there a error id associated with this?
    return (
      text.includes('token') ||
      text.includes('rate_limit') ||
      text.includes('quota')
    );
  }
}
