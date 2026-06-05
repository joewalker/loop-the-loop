// @module-tag local

import { TestAgent } from 'loop-the-loop/agents/test';
import type { InvokeResult } from 'loop-the-loop/types';
import { describe, expect, it } from 'vitest';

describe('TestAgent', () => {
  it('should expose a static `create` factory returning a TestAgent', async () => {
    const agent = await TestAgent.create({ responses: [] });
    expect(agent).toBeInstanceOf(TestAgent);
  });

  it('create() should reject a missing config', async () => {
    await expect(
      (TestAgent.create as (config?: unknown) => Promise<TestAgent>)(),
    ).rejects.toThrow(/responses/);
  });

  it('create() should reject a config without a responses array', async () => {
    await expect(
      (TestAgent.create as (config: unknown) => Promise<TestAgent>)({
        repeat: 'cycle',
      }),
    ).rejects.toThrow(/responses/);
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

  // #region create({ responses, repeat })

  it('create() should accept a responses array and return them FIFO', async () => {
    const agent = await TestAgent.create({
      responses: [
        { status: 'success', output: 'a' },
        { status: 'success', output: 'b' },
      ],
    });
    expect(await agent.invoke('p1')).toStrictEqual({
      status: 'success',
      output: 'a',
    });
    expect(await agent.invoke('p2')).toStrictEqual({
      status: 'success',
      output: 'b',
    });
  });

  it('create() should error after exhausting responses when repeat is "none"', async () => {
    const agent = await TestAgent.create({
      responses: [{ status: 'success', output: 'only' }],
      repeat: 'none',
    });
    await agent.invoke('p1');
    const second = await agent.invoke('p2');
    expect(second.status).toBe('error');
  });

  it('create() should cycle responses when repeat is "cycle"', async () => {
    const agent = await TestAgent.create({
      responses: [
        { status: 'success', output: 'a' },
        { status: 'success', output: 'b' },
      ],
      repeat: 'cycle',
    });
    expect((await agent.invoke('p1')) as { output: string }).toMatchObject({
      output: 'a',
    });
    expect((await agent.invoke('p2')) as { output: string }).toMatchObject({
      output: 'b',
    });
    expect((await agent.invoke('p3')) as { output: string }).toMatchObject({
      output: 'a',
    });
    expect((await agent.invoke('p4')) as { output: string }).toMatchObject({
      output: 'b',
    });
  });

  it('create() with a single response and repeat:cycle should reuse it forever', async () => {
    const agent = await TestAgent.create({
      responses: [{ status: 'success', output: 'dry run' }],
      repeat: 'cycle',
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await agent.invoke(`prompt-${i}`)).toStrictEqual({
        status: 'success',
        output: 'dry run',
      });
    }
  });

  // #endregion

  // #region check()

  it('check() yields ok when responses are configured', async () => {
    const agent = await TestAgent.create({
      responses: [{ status: 'success', output: 'a' }],
    });
    const results = [];
    for await (const result of agent.check()) {
      results.push(result);
    }
    expect(results).toStrictEqual([
      { name: 'responses configured', status: 'ok' },
    ]);
  });

  it('check() yields fail when responses are empty', async () => {
    const agent = await TestAgent.create({ responses: [] });
    const results = [];
    for await (const result of agent.check()) {
      results.push(result);
    }
    expect(results).toStrictEqual([
      {
        name: 'responses configured',
        status: 'fail',
        message: 'responses must be non-empty',
      },
    ]);
  });

  // #endregion
});
