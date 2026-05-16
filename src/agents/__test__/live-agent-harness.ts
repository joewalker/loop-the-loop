import type { Agent, InvokeOptions } from 'loop-the-loop/agents';
import type { Logger } from 'loop-the-loop/loggers';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import { TestPromptGenerator } from 'loop-the-loop/prompt-generators/test';
import type { InvokeResult } from 'loop-the-loop/types';
import { LoopState } from 'loop-the-loop/util/loop-state';

export const CHEAP_TEST_PROMPT =
  'Compute 19 + 23. Reply with exactly the digits of the integer answer, with no words, no punctuation, and no Markdown.';
export const CHEAP_TEST_ANSWER = '42';

export type LiveAgentInvokeOptions = Omit<InvokeOptions, 'logger'> & {
  readonly logger?: Logger;
};

export interface LiveAgentPromptResult {
  readonly prompt: Prompt;
  readonly result: InvokeResult;
}

/**
 * Invoke an agent using the normal test prompt generator path.
 */
export async function invokeLiveTestPrompt(
  agent: Agent,
  prompt: string,
  options: LiveAgentInvokeOptions = {},
): Promise<LiveAgentPromptResult> {
  const generator = new TestPromptGenerator({ prompts: [prompt] });
  const loopState = new LoopState('ignored.json');
  const logger = options.logger ?? createSilentLogger();

  for await (const generatedPrompt of generator.generate(loopState)) {
    return {
      prompt: generatedPrompt,
      result: await agent.invoke(generatedPrompt.prompt, {
        ...options,
        logger,
      }),
    };
  }

  throw new Error('Test prompt generator did not yield a prompt');
}

/**
 * Normalize a terse scalar answer before asserting exact equality.
 */
export function normalizeScalarAnswer(output: string): string {
  return output
    .trim()
    .replace(/^```(?:text)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
}

/**
 * Create a logger that satisfies InvokeOptions without emitting output.
 */
function createSilentLogger(): Logger {
  const noop = (): void => {};
  return {
    enabled: false,
    agent: noop,
    tool: noop,
    success: noop,
    error: noop,
    system: noop,
    state: noop,
    info: noop,
  };
}
