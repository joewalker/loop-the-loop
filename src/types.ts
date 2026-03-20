import type { AgentSpec } from './agents/agents.js';
import type { PromptGeneratorSpec } from './prompt-generators/prompt-generators.js';
import type { ReporterSpec } from './reporters/reporters.js';

/**
 * A JSON Schema object describing the expected shape of structured output.
 */
export type OutputSchema = Record<string, unknown>;

/**
 * We ran a prompt through an Agent and it worked out okay
 */
export interface SuccessfulInvocationResult {
  readonly status: 'success';
  readonly output: string;
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
  readonly maxTurns?: number;

  /**
   * Pause between each prompt. Can help with rate limiting.
   */
  readonly interPromptPause?: number;

  /**
   * An optional system prompt to pass to the agent. Supports
   * `{{include:path}}` macros. When loaded from a CLI JSON config, these are
   * resolved relative to the config file. Programmatic callers continue to
   * resolve them relative to the current working directory.
   */
  readonly systemPrompt?: string;

  /**
   * An optional JSON Schema describing the expected shape of the agent's
   * output. When provided, the SDK returns structured data conforming to
   * the schema instead of (or in addition to) free-form text.
   */
  readonly outputSchema?: OutputSchema;

  /**
   * Tool names that are auto-allowed without prompting for permission.
   * When omitted, the agent uses its own defaults.
   */
  readonly allowedTools?: ReadonlyArray<string>;

  /**
   * Tool names that are disallowed. These tools will be removed from the
   * model's context and cannot be used.
   */
  readonly disallowedTools?: ReadonlyArray<string>;
}
