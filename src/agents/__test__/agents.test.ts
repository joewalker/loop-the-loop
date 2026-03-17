import {
  agentTypes,
  createAgent,
  DEFAULT_AGENT,
} from 'agentic-loop/agents/agents';
import { TestAgent } from 'agentic-loop/agents/test';
import { describe, expect, it } from 'vitest';

describe('agentTypes', () => {
  it('should include default, claude-sdk, codex-cli, and test', () => {
    expect(agentTypes).toContain('default');
    expect(agentTypes).toContain('claude-sdk');
    expect(agentTypes).toContain('codex-cli');
    expect(agentTypes).toContain('test');
  });
});

describe('DEFAULT_AGENT', () => {
  it('should be "default"', () => {
    expect(DEFAULT_AGENT).toBe('default');
  });
});

describe('createAgent', () => {
  it('should create a TestAgent when type is "test"', () => {
    const agent = createAgent('test');
    expect(agent).toBeInstanceOf(TestAgent);
  });

  it('should create the default agent when no type is given', () => {
    const agent = createAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe('function');
  });

  it('should create the default agent when "default" is given', () => {
    const agent = createAgent('default');
    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe('function');
  });
});
