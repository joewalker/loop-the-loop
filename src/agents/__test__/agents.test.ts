import { agentTypes, createAgent } from 'loop-the-loop/agents';
import { ClaudeSDKAgent } from 'loop-the-loop/agents/claude-sdk';
import { CodexCLIAgent } from 'loop-the-loop/agents/codex-cli';
import { TestAgent } from 'loop-the-loop/agents/test';
import { describe, expect, it } from 'vitest';

describe('agentTypes', () => {
  it('should include default, claude-sdk, codex-cli, and test', () => {
    expect(agentTypes).toContain(ClaudeSDKAgent.agentName);
    expect(agentTypes).toContain(CodexCLIAgent.agentName);
    expect(agentTypes).toContain(TestAgent.agentName);
  });
});

describe('createAgent', () => {
  it('should create a TestAgent when type is "test"', async () => {
    const agent = await createAgent(TestAgent.agentName);
    expect(agent).toBeInstanceOf(TestAgent);
  });
});
