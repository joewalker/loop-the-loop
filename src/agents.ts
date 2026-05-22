import { ClaudeSDKAgent } from './agents/claude-sdk.js';
import { CodexCLIAgent } from './agents/codex-cli.js';
import { OpenAISDKAgent } from './agents/openai-sdk.js';
import { TestAgent } from './agents/test.js';
import type { Logger } from './loggers.js';
import type { InvokeResult } from './types.js';

/**
 * Options passed to `Agent.invoke()` alongside the prompt.
 *
 * These are forwarded from the top-level `LoopCliConfig` and allow
 * per-invocation control over the agent's behaviour without changing the
 * agent instance itself.
 */
export interface InvokeOptions {
  /**
   * When provided, the agent emits diagnostic messages (tool use, assistant
   * text, etc.) through this logger.
   */
  readonly logger: Logger;

  /**
   * When true, agents may make source changes during this invocation.
   */
  readonly allowSourceUpdate?: boolean;
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
 * To add a new built-in Agent, add its creator function here.
 *
 * `TestAgent` is registered in its parameterised form only. `TestAgent.create`
 * requires a `{ responses, repeat? }` config and throws when called without
 * one, so the bare `"test"` agent name is rejected at runtime even though the
 * map lookup succeeds (see joewalker/loop-the-loop#19).
 */
const agentCreators = {
  [ClaudeSDKAgent.agentName]: ClaudeSDKAgent.create,
  [CodexCLIAgent.agentName]: CodexCLIAgent.create,
  [OpenAISDKAgent.agentName]: OpenAISDKAgent.create,
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
    const creator: AgentCreator | undefined = agentCreators[agentSpec];
    if (creator == null) {
      throw new Error(
        `Unknown agent '${agentSpec}'. Known agents: ${agentTypes.join('\n')}.`,
      );
    }
    return creator();
  }

  if (Array.isArray(agentSpec)) {
    const [type, ...args] = agentSpec;
    const creator: AgentCreator | undefined = agentCreators[type];
    if (creator == null) {
      throw new Error(
        `Unknown agent '${type}'. Known agents: ${agentTypes.join('\n')}.`,
      );
    }

    return creator(...args);
  }

  return agentSpec;
}
