import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { InvokeResult, OutputSchema } from '../types.js';
import { ClaudeSDKAgent } from './claude-sdk.js';
import { CodexCLIAgent } from './codex-cli.js';
import { TestAgent } from './test.js';

/**
 * Options passed to `Agent.invoke()` alongside the prompt.
 */
export interface InvokeOptions {
  readonly systemPrompt?: string;
  readonly outputSchema?: OutputSchema;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly mcpServers?: Record<string, McpServerConfig>;
}

/**
 * The interface to the various ways we have of running agents
 */
export interface Agent {
  invoke: (prompt: string, options?: InvokeOptions) => Promise<InvokeResult>;
}

export const DEFAULT_AGENT = 'default';

/**
 * To add a new agent, add its creator function here
 */
const agentConstructors = {
  [DEFAULT_AGENT]: CodexCLIAgent,
  [ClaudeSDKAgent.agentName]: ClaudeSDKAgent,
  [CodexCLIAgent.agentName]: CodexCLIAgent,
  [TestAgent.agentName]: TestAgent,
} satisfies Record<string, new () => Agent>;

/**
 * Enable TypeScript to know what agents are available
 */
export type AgentType = keyof typeof agentConstructors;

/**
 * Enable the command line to know what agents are available
 */
export const agentTypes = Object.keys(agentConstructors);

/**
 * Allow easy switching between different agent types
 */
export function createAgent(type: AgentType = DEFAULT_AGENT): Agent {
  return new agentConstructors[type]();
}
