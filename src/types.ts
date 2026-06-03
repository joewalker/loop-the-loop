import type { AgentSpec } from './agents.js';
import type { LoggerSpec } from './loggers.js';
import type { PromptGeneratorSpec } from './prompt-generators.js';
import type { ReporterSpec } from './reporters.js';

/**
 * A JSON Schema object describing the expected shape of structured output.
 */
export type OutputSchema = Record<string, unknown>;

/**
 * Cost and token usage metadata for an agent invocation. `costSource:
 * 'unavailable'` means usage may be known but no USD figure was produced.
 */
export interface CostInfo {
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly model?: string;
  readonly costSource: 'provider' | 'estimated' | 'unavailable';
}

/**
 * We ran a prompt through an Agent and it worked out okay
 */
export interface SuccessfulInvocationResult {
  readonly status: 'success';
  readonly output: string;
  readonly cost?: CostInfo;
  /**
   * When an `outputSchema` was provided, the SDK returns the parsed object
   * that conforms to the schema. Present only when structured output was
   * requested and the agent supports it.
   */
  readonly structuredOutput?: unknown;
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
  readonly cost?: CostInfo;
}

/**
 * We ran a prompt through and an Agent and it broke in a way that indicates
 * a problem with the prompt rather than the agent. This prompt should probably
 * not be tried again.
 */
export interface ErrorInvocationResult {
  readonly status: 'error';
  readonly reason: string;
  readonly cost?: CostInfo;
}

/**
 * The outcome of invoking the agent on a single file
 */
export type InvokeResult =
  | SuccessfulInvocationResult
  | GlitchedInvocationResult
  | ErrorInvocationResult;

/**
 * Type definition for the main start point for the loop
 */
export interface LoopCliConfig {
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
  readonly agent: AgentSpec;

  /**
   * The source of prompts to sent to the selected agent
   */
  readonly promptGenerator: PromptGeneratorSpec;

  /**
   * How we report on the responses from the agent to the various prompts
   */
  readonly reporter?: ReporterSpec;

  /**
   * Maximum number of prompts to process. Unlimited when null/undefined.
   */
  readonly maxPrompts?: number;

  /**
   * Pause between each prompt. Can help with rate limiting.
   */
  readonly interPromptPause?: number;

  /**
   * When true, the loop checks that the working directory is clean before
   * starting, allows agents to make source changes, and commits after each
   * successful prompt. When false (the default), git state is ignored and
   * no commits are made.
   */
  readonly allowSourceUpdate?: boolean;

  /**
   * Controls verbose diagnostic logging to stderr. Accepts a concrete
   * `VerboseLogger` instance, the string `'verbose'` (which creates an
   * enabled logger), or `undefined` (quiet, the default).
   */
  readonly logger?: LoggerSpec;
}
