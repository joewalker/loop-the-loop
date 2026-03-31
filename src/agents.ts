import type { Logger } from './loggers/loggers.js';
import type { InvokeResult, OutputSchema } from './types.js';
import { ClaudeSDKAgent } from './agents/claude-sdk.js';
import { CodexCLIAgent } from './agents/codex-cli.js';
import { TestAgent } from './agents/test.js';

/**
 * Options passed to `Agent.invoke()` alongside the prompt.
 *
 * These are forwarded from the top-level `LoopCliConfig` and allow
 * per-invocation control over the agent's behaviour without changing the
 * agent instance itself.
 */
export interface InvokeOptions {
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
   * When provided, the agent emits diagnostic messages (tool use, assistant
   * text, etc.) through this logger.
   */
  readonly logger: Logger;
}

/**
 * The interface every agent must implement.
 *
 * An agent wraps an LLM (or CLI tool) and exposes a single `invoke`
 * method that sends a prompt and returns a result. The main loop
 * calls `invoke` once per prompt yielded by the prompt generator.
 *
 * To create a custom agent:
 *
 * 1. Create a class that implements this interface.
 * 2. Add a static `agentName` string and a static async `create()`
 *    factory method.
 * 3. Register it in the `agentCreators` map in this file.
 *
 * See `ClaudeSDKAgent` and `CodexCLIAgent` for reference implementations.
 */
export interface Agent {
  invoke: (prompt: string, options: InvokeOptions) => Promise<InvokeResult>;
}

/**
 * Pattern for an async creator function for Agents so we can register a
 * library of AgentCreators to allow easy command line configuration.
 */
export type AgentCreator = (...args: Array<any>) => Promise<Agent>;

/**
 * To add a new built-in Agent, add its creator function here
 */
const agentCreators = {
  [ClaudeSDKAgent.agentName]: ClaudeSDKAgent.create,
  [CodexCLIAgent.agentName]: CodexCLIAgent.create,
  [TestAgent.agentName]: TestAgent.create,
} satisfies Record<string, AgentCreator>;

type AgentCreators = typeof agentCreators;
type AgentName = keyof typeof agentCreators;
type ParameterlessAgentNames = {
  [T in AgentName]: [] extends Parameters<AgentCreators[T]> ? T : never;
}[AgentName];
type ParameteredAgentSpecs = {
  [T in AgentName]: Parameters<AgentCreators[T]>['length'] extends 0
    ? never
    : [T, ...Parameters<AgentCreators[T]>];
}[AgentName];

/**
 * To specify an Agent in a config file, pass either:
 * - an Agent instance
 * - just the name of an Agent (see `agentCreators`) if it needs no init config
 * - an array where the first element is the agent name followed by subsequent
 *   parameters which are passed to the creator function for that type of Agent
 * AgentSpec defines these options.
 */
export type AgentSpec = Agent | ParameterlessAgentNames | ParameteredAgentSpecs;

/**
 * Enable unit tests to know what agents are available
 */
export const agentTypes = Object.keys(agentCreators);

/**
 * Convert a description of an agent as delivered in a config file into an
 * actual Agent
 */
export async function createAgent(agentSpec: AgentSpec): Promise<Agent> {
  if (typeof agentSpec === 'string') {
    const creator = agentCreators[agentSpec];
    return creator();
  }
  if (Array.isArray(agentSpec)) {
    const [type, ...args] = agentSpec;
    const creator = agentCreators[type] as AgentCreator;
    return creator(...args);
  }
  return agentSpec;
}
