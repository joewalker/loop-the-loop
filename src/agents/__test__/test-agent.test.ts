import { TestAgent } from 'agentic-loop/agents/test';
import type { InvokeResult } from 'agentic-loop/types';
import { describe, expect, it } from 'vitest';

describe('TestAgent', () => {
  it('should have the static name "test"', () => {
    expect(TestAgent.agentName).toBe('test');
  });

  it('should return an error when no results have been set', async () => {
    const agent = new TestAgent();
    const result = await agent.invoke('anything');
    expect(result).toStrictEqual({
      status: 'error',
      reason: '#results is empty',
    });
  });

  it('should return preset results in FIFO order', async () => {
    const agent = new TestAgent();
    const first: InvokeResult = { status: 'success', output: 'first' };
    const second: InvokeResult = { status: 'success', output: 'second' };

    agent.setNextInvokeResult(first, second);

    // FIFO: second is returned first (pop from end)
    expect(await agent.invoke('prompt2')).toStrictEqual(first);
    expect(await agent.invoke('prompt1')).toStrictEqual(second);
  });

  it('should return error once all preset results are consumed', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'success', output: 'only one' });

    await agent.invoke('first call');
    const result = await agent.invoke('second call');
    expect(result.status).toBe('error');
  });

  it('should handle glitch results', async () => {
    const agent = new TestAgent();
    const glitch: InvokeResult = { status: 'glitch', reason: 'rate limited' };
    agent.setNextInvokeResult(glitch);

    const result = await agent.invoke('prompt');
    expect(result).toStrictEqual(glitch);
  });

  it('should handle error results', async () => {
    const agent = new TestAgent();
    const error: InvokeResult = { status: 'error', reason: 'bad prompt' };
    agent.setNextInvokeResult(error);

    const result = await agent.invoke('prompt');
    expect(result).toStrictEqual(error);
  });

  it('should replace results when setNextInvokeResult is called again', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'success', output: 'old' });
    agent.setNextInvokeResult({ status: 'success', output: 'new' });

    const result = await agent.invoke('prompt');
    expect(result).toStrictEqual({ status: 'success', output: 'new' });
  });
});
