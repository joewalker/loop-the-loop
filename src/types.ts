import type { Agent, AgentType } from './agents/agents.js';
import type {
  PromptGenerator,
  PromptGeneratorSpec,
} from './prompt-generators/prompt-generators.js';

/**
 * We ran a prompt through an Agent and it worked out okay
 */
export interface SuccessfulInvocationResult {
  readonly status: 'success';
  readonly output: string;
}

/**
 * We ran a prompt through an Agent and there was a transient problem which
 * indicates a problem with the agent rather than the prompt (for example
 * an 'out of tokens' error or a 'network down' error.).
 * Given a glitch the caller should probably stop and work out a configuration
 * which will work or wait until a transient problem is resolved
 */
export interface GlitchedInvocationResult {
  readonly status: 'glitch';
  readonly reason: string;
}

/**
 * We ran a prompt through and an Agent and it broke in a way that indicates
 * a problem with the prompt rather than the agent. This prompt should probably
 * not be tried again.
 */
export interface ErrorInvocationResult {
  readonly status: 'error';
  readonly reason: string;
}

/**
 * The outcome of invoking the agent on a single file
 */
export type InvokeResult =
  | SuccessfulInvocationResult
  | GlitchedInvocationResult
  | ErrorInvocationResult;

/**
 * Type definition for the main start point for the agentic loop
 */
export interface AgenticLoopCliConfig {
  /**
   * The task name is used in reports and as part of a filename when managing
   * state.
   */
  readonly name: string;

  /**
   * Directory into which we can write a report and a state tracking file
   */
  readonly outputDir?: string;

  /**
   * The agent to which we send prompts
   */
  readonly agent: Agent | AgentType;

  /**
   * The source of prompts to sent to the selected agent
   */
  readonly promptGenerator: PromptGenerator | PromptGeneratorSpec;

  /**
   * Maximum number of prompts to process. Unlimited when null/undefined.
   */
  readonly maxTurns?: number;

  /**
   * Pause between each prompt. Can help with rate limiting.
   */
  readonly interPromptPause?: number;
}
