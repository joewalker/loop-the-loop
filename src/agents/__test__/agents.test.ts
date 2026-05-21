// @module-tag local

import { agentTypes, createAgent } from 'loop-the-loop/agents';
import { ClaudeSDKAgent } from 'loop-the-loop/agents/claude-sdk';
import { CodexCLIAgent } from 'loop-the-loop/agents/codex-cli';
import { TestAgent } from 'loop-the-loop/agents/test';
import { describe, expect, it } from 'vitest';

describe('agentTypes', () => {
  it('should include claude-sdk and codex-cli', () => {
    expect(agentTypes).toContain(ClaudeSDKAgent.agentName);
    expect(agentTypes).toContain(CodexCLIAgent.agentName);
  });

  it('should not expose TestAgent as a CLI-selectable agent', () => {
    expect(agentTypes).not.toContain(TestAgent.agentName);
  });
});

describe('createAgent', () => {
  it('should reject the bare "test" agent name', async () => {
    const spec = TestAgent.agentName as unknown as Parameters<
      typeof createAgent
    >[0];
    await expect(createAgent(spec)).rejects.toThrow(/test/);
  });

  it('should return a pre-constructed Agent instance as-is', async () => {
    const agent = new TestAgent();
    const result = await createAgent(agent);
    expect(result).toBe(agent);
  });

  it('should create an agent from a bare name string', async () => {
    const agent = await createAgent('claude-sdk');
    expect(agent).toBeInstanceOf(ClaudeSDKAgent);
  });

  it('should create an agent from a [name, ...args] tuple', async () => {
    const agent = await createAgent(['claude-sdk', { maxTurns: 1 }]);
    expect(agent).toBeInstanceOf(ClaudeSDKAgent);
  });

  it('should throw a descriptive error for an unknown agent name in a tuple', async () => {
    const spec = ['does-not-exist'] as unknown as Parameters<
      typeof createAgent
    >[0];
    await expect(createAgent(spec)).rejects.toThrow(
      /Unknown agent 'does-not-exist'/,
    );
  });
});
