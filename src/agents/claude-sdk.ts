import { query } from '@anthropic-ai/claude-agent-sdk';

import type { InvokeResult } from '../types.js';
import type { Agent } from './agents.js';

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

  async invoke(prompt: string): Promise<InvokeResult> {
    try {
      const textParts: Array<string> = [];

      const messages = query({
        prompt,
        options: {
          allowedTools: DEFAULT_TOOLS,
          permissionMode,
          maxTurns: DEFAULT_MAX_TURNS,
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
            return { status: 'success', output: textParts.join('\n') };
          }

          const reason =
            'error' in message ? String(message.error) : 'Unknown error';
          const status = this.#isTokenLimitError(reason) ? 'glitch' : 'error';
          return { status, reason };
        }
      }

      // If we get here without a result message, treat the collected text as the output
      return textParts.length > 0
        ? { status: 'success', output: textParts.join('\n') }
        : { status: 'error', reason: 'No output received from agent' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const status = this.#isTokenLimitError(reason) ? 'glitch' : 'error';
      return { status, reason };
    }
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
