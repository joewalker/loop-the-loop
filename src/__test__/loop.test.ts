// @module-tag local

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loop } from 'loop-the-loop';
import type {
  Agent,
  InvokeOptions,
  LoopRunResult,
  LoopState,
  Prompt,
  PromptGenerator,
} from 'loop-the-loop';
import { TestAgent } from 'loop-the-loop/agents/test';
import { BatchPromptGenerator } from 'loop-the-loop/prompt-generators/batch';
import { YamlReporter } from 'loop-the-loop/reporters/yaml';
import type { InvokeResult, LoopCliConfig } from 'loop-the-loop/types';
import { Git } from 'loop-the-loop/util/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A simple PromptGenerator that yields a fixed list of prompts
 */
class FixedPromptGenerator implements PromptGenerator {
  readonly name = 'test-generator';
  readonly #prompts: Array<{ id: string; prompt: string }>;
  readonly results: Array<{ id: string }> = [];

  constructor(prompts: Array<{ id: string; prompt: string }>) {
    this.#prompts = prompts;
  }

  async *generate(_loopState: LoopState): AsyncIterable<Prompt> {
    for (const p of this.#prompts) {
      this.results.push({ id: p.id });
      yield {
        id: p.id,
        prompt: p.prompt,
      };
    }
  }
}

/**
 * An agent that records invoke options for loop integration tests.
 */
class RecordingAgent implements Agent {
  readonly invokeOptions: Array<InvokeOptions> = [];
  readonly #result: InvokeResult;

  constructor(result: InvokeResult) {
    this.#result = result;
  }

  async invoke(_prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    this.invokeOptions.push(options);
    return this.#result;
  }
}

/**
 * Helper to run main() with fake timers. We advance timers after starting
 * main() so the 5-second pauses resolve instantly.
 */
async function runMainWithFakeTimers(
  config: LoopCliConfig,
): Promise<LoopRunResult> {
  const promise = loop(config);

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

    // Set a local committer identity so the loop's git preflight is
    // deterministic regardless of the machine's global git config.
    execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Test']);
    execFileSync('git', [
      '-C',
      repoPath,
      'config',
      'user.email',
      'test@test.com',
    ]);

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

  it('rejects a non-integer concurrency', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);
    await expect(
      loop({ name: 'bad-conc', agent, promptGenerator, concurrency: 1.5 }),
    ).rejects.toThrow('Invalid concurrency: 1.5');
  });

  it('rejects a concurrency below 1', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);
    await expect(
      loop({ name: 'zero-conc', agent, promptGenerator, concurrency: 0 }),
    ).rejects.toThrow('Invalid concurrency: 0');
  });

  it('rejects concurrency > 1 with allowSourceUpdate', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);
    await expect(
      loop({
        name: 'conc-source',
        agent,
        promptGenerator,
        concurrency: 2,
        allowSourceUpdate: true,
      }),
    ).rejects.toThrow(/allowSourceUpdate/u);
  });

  it('rejects concurrency > 1 with the batch prompt generator', async () => {
    const agent = new TestAgent();
    const inner = new FixedPromptGenerator([{ id: 'a', prompt: 'a' }]);
    const promptGenerator = new BatchPromptGenerator(
      { source: inner, summaryPromptTemplate: 'Summary', reportFile: 'r.yaml' },
      inner,
    );
    await expect(
      loop({ name: 'conc-batch', agent, promptGenerator, concurrency: 2 }),
    ).rejects.toThrow(/batch/u);
  });

  it('should return a completed result when all prompts succeed', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult(
      { status: 'success', output: 'review of a' },
      { status: 'success', output: 'review of b' },
    );

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
      { id: 'b.ts', prompt: 'Review b' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'check-done',
      agent,
      promptGenerator,
      maxPrompts: 3,
    });
    expect(result).toEqual({ status: 'completed' });
  });

  it('should stop on error and return a failed result', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'error', reason: 'parsing failed' });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'bad.ts', prompt: 'Review bad' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'stop-on-error',
      agent,
      promptGenerator,
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'errorResult',
      message: 'Error on bad.ts: parsing failed',
    });
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

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
      { id: 'b.ts', prompt: 'b' },
      { id: 'c.ts', prompt: 'c' },
      { id: 'd.ts', prompt: 'd' },
      { id: 'e.ts', prompt: 'e' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'abort-post-glitches',
      agent,
      promptGenerator,
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'tooManyGlitches',
      message: expect.stringContaining('Aborting after 5 consecutive glitches'),
    });
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

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
      { id: 'b.ts', prompt: 'b' },
      { id: 'c.ts', prompt: 'c' },
      { id: 'd.ts', prompt: 'd' },
      { id: 'e.ts', prompt: 'e' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'reset-glitch-count',
      agent,
      promptGenerator,
      maxPrompts: 6,
    });
    expect(result).toEqual({ status: 'completed' });
  });

  it('should not invoke the agent when maxPrompts is 0', async () => {
    const agent = new RecordingAgent({ status: 'success', output: 'unused' });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'max-prompts-zero',
      agent,
      promptGenerator,
      maxPrompts: 0,
    });
    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxPrompts',
      message: 'Reached limit of 0 prompts',
    });
    expect(agent.invokeOptions).toHaveLength(0);
  });

  it('should respect maxPrompts limit', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult(
      { status: 'success', output: 'first' },
      { status: 'success', output: 'second' },
      { status: 'success', output: 'third' },
    );

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'a' },
      { id: 'b.ts', prompt: 'b' },
      { id: 'c.ts', prompt: 'c' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'respect-max-turns',
      agent,
      promptGenerator,
      maxPrompts: 1,
    });
    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxPrompts',
      message: 'Reached limit of 1 prompts',
    });
  });

  it('should throw if working directory is not clean when allowSourceUpdate is true', async () => {
    await writeFile(join(repoPath, 'dirty.txt'), 'dirty');

    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);

    await expect(
      runMainWithFakeTimers({
        name: 'throw-if-unclean',
        agent,
        promptGenerator,
        allowSourceUpdate: true,
      }),
    ).rejects.toThrow('Working directory is not clean');
  });

  it('should not check git cleanliness when allowSourceUpdate is false', async () => {
    await writeFile(join(repoPath, 'dirty.txt'), 'dirty');

    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);

    const result = await runMainWithFakeTimers({
      name: 'skip-clean-check',
      agent,
      promptGenerator,
    });
    expect(result).toEqual({ status: 'completed' });
  });

  it('should pass allowSourceUpdate to agent invocations', async () => {
    const agent = new RecordingAgent({ status: 'error', reason: 'stop' });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'pass-source-update',
      agent,
      promptGenerator,
      allowSourceUpdate: true,
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'errorResult',
      message: 'Error on a.ts: stop',
    });
    expect(agent.invokeOptions).toHaveLength(1);
    expect(agent.invokeOptions[0]?.allowSourceUpdate).toBe(true);
  });

  it('should return a completed result with an empty prompt generator', async () => {
    const agent = new TestAgent();
    const promptGenerator = new FixedPromptGenerator([]);

    const result = await runMainWithFakeTimers({
      name: 'done-if-no-prompts',
      agent,
      promptGenerator,
    });
    expect(result).toEqual({ status: 'completed' });
  });

  it('should pass structuredOutput through to the reporter', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({
      status: 'success',
      output: 'text',
      structuredOutput: { found: true },
    });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Analyze a' },
    ]);

    const appendSpy = vi.fn().mockResolvedValue(undefined);
    const reporter = { append: appendSpy };

    const result = await runMainWithFakeTimers({
      name: 'structured-output',
      agent,
      promptGenerator,
      reporter,
      maxPrompts: 1,
    });
    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxPrompts',
      message: 'Reached limit of 1 prompts',
    });
    expect(appendSpy).toHaveBeenCalledOnce();
    const [, invokeResult] = appendSpy.mock.calls[0];
    expect(invokeResult.status).toBe('success');
    expect(invokeResult.structuredOutput).toEqual({ found: true });
  });

  it('should keep the prompt outstanding if writing the report fails', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'success', output: 'review of a' });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
    ]);

    vi.spyOn(YamlReporter.prototype, 'append').mockRejectedValue(
      new Error('disk full'),
    );

    await expect(
      runMainWithFakeTimers({
        name: 'report-write-failure',
        agent,
        outputDir: repoPath,
        promptGenerator,
      }),
    ).rejects.toThrow('disk full');

    const raw = await readFile(
      join(repoPath, 'report-write-failure-loop-state.json'),
      'utf-8',
    );
    expect(JSON.parse(raw)).toEqual({
      version: 2,
      results: {},
      claims: {},
      totalUsd: 0,
    });
  });

  it('should skip a prompt already claimed by another run', async () => {
    const agent = new RecordingAgent({ status: 'success', output: 'unused' });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
    ]);

    await writeFile(
      join(repoPath, 'skip-claimed-loop-state.json'),
      `${JSON.stringify(
        {
          version: 2,
          results: {},
          claims: { 'a.ts': { runId: 'other-run', claimedAt: '2020-01-01' } },
          totalUsd: 0,
        },
        null,
        2,
      )}\n`,
    );

    const result = await runMainWithFakeTimers({
      name: 'skip-claimed',
      agent,
      outputDir: repoPath,
      promptGenerator,
    });

    expect(result).toEqual({ status: 'completed' });
    expect(agent.invokeOptions).toHaveLength(0);
  });

  it('stops after the prompt that crosses maxBudgetUsd', async () => {
    const agent = new TestAgent({
      responses: [
        {
          status: 'success',
          output: 'a',
          cost: { usd: 0.6, costSource: 'estimated' },
        },
        {
          status: 'success',
          output: 'b',
          cost: { usd: 0.6, costSource: 'estimated' },
        },
      ],
    });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
      { id: 'b.ts', prompt: 'Review b' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'budget-cross',
      agent,
      outputDir: repoPath,
      promptGenerator,
      maxBudgetUsd: 1,
    });

    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxBudgetUsd',
      message: expect.stringContaining('Budget'),
    });
  });

  it('stops immediately at startup when the persisted total is already over budget', async () => {
    const agent = new RecordingAgent({ status: 'success', output: 'unused' });
    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
    ]);

    await writeFile(
      join(repoPath, 'budget-startup-loop-state.json'),
      `${JSON.stringify(
        { version: 2, results: {}, claims: {}, totalUsd: 5 },
        null,
        2,
      )}\n`,
    );

    const result = await runMainWithFakeTimers({
      name: 'budget-startup',
      agent,
      outputDir: repoPath,
      promptGenerator,
      maxBudgetUsd: 1,
    });

    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('maxBudgetUsd');
    expect(agent.invokeOptions).toHaveLength(0);
  });

  it('does not advance the budget for unavailable cost', async () => {
    const agent = new TestAgent({
      responses: [
        {
          status: 'success',
          output: 'a',
          cost: { usd: 0, costSource: 'unavailable' },
        },
        {
          status: 'success',
          output: 'b',
          cost: { usd: 0, costSource: 'unavailable' },
        },
      ],
    });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
      { id: 'b.ts', prompt: 'Review b' },
    ]);

    const result = await runMainWithFakeTimers({
      name: 'budget-unavailable',
      agent,
      outputDir: repoPath,
      promptGenerator,
      maxBudgetUsd: 1,
    });

    expect(result.status).toBe('completed');
  });

  it('logs cost verbosely when a logger is enabled', async () => {
    const agent = new TestAgent({
      responses: [
        {
          status: 'success',
          output: 'a',
          cost: { usd: 0.25, costSource: 'estimated', model: 'gpt-5-mini' },
        },
      ],
    });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'a.ts', prompt: 'Review a' },
    ]);

    const stateMessages: Array<string> = [];
    const recordingLogger = {
      enabled: true,
      agent: () => {},
      tool: () => {},
      success: () => {},
      error: () => {},
      system: () => {},
      state: (m: string) => stateMessages.push(m),
      info: () => {},
    };

    await runMainWithFakeTimers({
      name: 'budget-verbose-cost',
      agent,
      outputDir: repoPath,
      promptGenerator,
      logger: recordingLogger,
      maxPrompts: 1,
    });

    expect(
      stateMessages.some(m => m.includes('Cost:') && m.includes('0.2500')),
    ).toBe(true);
  });

  it('should emit each prompt on the verbose logger so --dry-run can inspect it', async () => {
    const agent = new TestAgent();
    agent.setNextInvokeResult({ status: 'success', output: 'ok' });

    const promptGenerator = new FixedPromptGenerator([
      { id: 'one', prompt: 'Please review file X' },
    ]);

    const systemMessages: Array<string> = [];
    const recordingLogger = {
      enabled: true,
      agent: () => {},
      tool: () => {},
      success: () => {},
      error: () => {},
      system: (m: string) => systemMessages.push(m),
      state: () => {},
      info: () => {},
    };

    await runMainWithFakeTimers({
      name: 'verbose-prompts',
      agent,
      promptGenerator,
      logger: recordingLogger,
      maxPrompts: 1,
    });

    expect(systemMessages.some(m => m.includes('Please review file X'))).toBe(
      true,
    );
  });
});
