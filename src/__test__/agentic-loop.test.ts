import { TestAgent } from 'agentic-loop/agents/test';
import { Git } from 'agentic-loop/git';
import { agenticLoop } from 'agentic-loop';
import type { Prompt, PromptGenerator, InvokeResult } from 'agentic-loop';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A simple PromptGenerator that yields a fixed list of prompts
 */
class FixedPromptGenerator implements PromptGenerator {
  readonly name = 'test-generator';
  readonly #prompts: Array<{ id: string; prompt: string }>;
  readonly results: Array<{ id: string; result: InvokeResult }> = [];

  constructor(prompts: Array<{ id: string; prompt: string }>) {
    this.#prompts = prompts;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Prompt> {
    const results = this.results;
    for (const p of this.#prompts) {
      yield {
        id: p.id,
        prompt: p.prompt,
        async recordResult(result: InvokeResult) {
          results.push({ id: p.id, result });
        },
      };
    }
  }
}

/**
 * Helper to run main() with fake timers. We advance timers after starting
 * main() so the 5-second pauses resolve instantly.
 */
async function runMainWithFakeTimers(
  agent: TestAgent,
  generator: PromptGenerator,
  options?: { maxTurns?: number },
): Promise<string> {
  const promise = agenticLoop(agent, generator, options);

  // Keep advancing fake timers until main() resolves
  while (true) {
    const raceResult = await Promise.race([
      promise.then(v => ({ done: true as const, value: v })),
      vi
        .advanceTimersByTimeAsync(10_000)
        .then(() => ({ done: false as const })),
    ]);
    if (raceResult.done) {
      return raceResult.value;
    }
  }
}

describe('main', () => {
  let repoPath: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();

    // Create a temp git repo for main() to use
    repoPath = await mkdtemp(join(tmpdir(), 'main-test-'));
    const git = new Git(repoPath);
    await git.init();
    await writeFile(join(repoPath, 'init.txt'), 'init');
    await git.add('init.txt');
    await git.commit('Initial commit', {
      committer: { name: 'Test', email: 'test@test.com' },
    });

    process.chdir(repoPath);

    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(repoPath, { recursive: true, force: true });
  });

  it('should return "Done" when all prompts succeed', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult(
      { status: 'success', output: 'review of b' },
      { status: 'success', output: 'review of a' },
    );

    const generator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
      { id: 'b.ts', prompt: 'Review b' },
    ]);

    const result = await runMainWithFakeTimers(agent, generator, {
      maxTurns: 2,
    });
    expect(result).toContain('Done');
  });

  it('should stop on error and return error message', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'error', reason: 'parsing failed' });

    const generator = new FixedPromptGenerator([
      { id: 'bad.ts', prompt: 'Review bad' },
    ]);

    const result = await runMainWithFakeTimers(agent, generator);
    expect(result).toContain('Error on bad.ts');
    expect(result).toContain('parsing failed');
  });

  it('should abort after max consecutive glitches', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult(
      { status: 'glitch', reason: 'rate limit' },
      { status: 'glitch', reason: 'rate limit' },
      { status: 'glitch', reason: 'rate limit' },
      { status: 'glitch', reason: 'rate limit' },
      { status: 'glitch', reason: 'rate limit' },
    );

    const generator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
      { id: 'b.ts', prompt: 'b' },
      { id: 'c.ts', prompt: 'c' },
      { id: 'd.ts', prompt: 'd' },
      { id: 'e.ts', prompt: 'e' },
    ]);

    const result = await runMainWithFakeTimers(agent, generator);
    expect(result).toContain('Aborting after 5 consecutive glitches');
  });

  it('should reset glitch count after a success', async () => {
    const agent = new TestAgent();
    // LIFO order: glitch, glitch, success, glitch, glitch
    agent.setNextInvokeResult(
      { status: 'glitch', reason: 'rate limit' },
      { status: 'glitch', reason: 'rate limit' },
      { status: 'success', output: 'ok' },
      { status: 'glitch', reason: 'rate limit' },
      { status: 'glitch', reason: 'rate limit' },
    );

    const generator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
      { id: 'b.ts', prompt: 'b' },
      { id: 'c.ts', prompt: 'c' },
      { id: 'd.ts', prompt: 'd' },
      { id: 'e.ts', prompt: 'e' },
    ]);

    const result = await runMainWithFakeTimers(agent, generator, {
      maxTurns: 5,
    });
    expect(result).toContain('Done');
  });

  it('should respect maxTurns limit', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult(
      { status: 'success', output: 'third' },
      { status: 'success', output: 'second' },
      { status: 'success', output: 'first' },
    );

    const generator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
      { id: 'b.ts', prompt: 'b' },
      { id: 'c.ts', prompt: 'c' },
    ]);

    const result = await runMainWithFakeTimers(agent, generator, {
      maxTurns: 1,
    });
    expect(result).toContain('reached limit of 1 turns');
  });

  it('should throw if working directory is not clean', async () => {
    await writeFile(join(repoPath, 'dirty.txt'), 'dirty');

    const agent = new TestAgent();
    const generator = new FixedPromptGenerator([]);

    await expect(runMainWithFakeTimers(agent, generator)).rejects.toThrow(
      'Working directory is not clean',
    );
  });

  it('should return "Done" with an empty prompt generator', async () => {
    const agent = new TestAgent();
    const generator = new FixedPromptGenerator([]);

    const result = await runMainWithFakeTimers(agent, generator);
    expect(result).toBe('Done');
  });

  it('should record results on the prompt', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'success', output: 'good' });

    const generator = new FixedPromptGenerator([
      { id: 'file.ts', prompt: 'review' },
    ]);

    await runMainWithFakeTimers(agent, generator);

    expect(generator.results).toHaveLength(1);
    expect(generator.results[0].id).toBe('file.ts');
    expect(generator.results[0].result.status).toBe('success');
  });
});
