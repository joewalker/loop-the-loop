// @module-tag local

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { main } from 'loop-the-loop/cli';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('cli main', () => {
  let dir: string;
  let logs: Array<string>;
  let errors: Array<string>;
  let originalArgv: Array<string>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    logs = [];
    errors = [];
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Set process.argv to the given CLI arguments (node + script path are
   * prepended, mirroring how main() reads process.argv.slice(2)).
   */
  function setArgs(...args: Array<string>): void {
    process.argv = ['node', 'cli.js', ...args];
  }

  async function writeConfig(name: string, config: unknown): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(config));
    return path;
  }

  const successAgent = [
    'test',
    { responses: [{ status: 'success', output: 'ok' }], repeat: 'cycle' },
  ];

  it('prints the usage banner for --help', async () => {
    setArgs('--help');
    await main();
    expect(logs.join('\n')).toMatch(/Usage: loop-the-loop/u);
  });

  it('prints the package version for --version', async () => {
    setArgs('--version');
    await main();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\d+\.\d+/u);
  });

  it('runs a standalone loop config and prints Done', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    const path = await writeConfig('loop.json', {
      name: 'standalone',
      agent: successAgent,
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'jsonl',
        { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
      ],
    });
    setArgs(path);
    await main();
    expect(logs).toContain('Done');
  });

  it('dispatches a pipeline config through runPipeline', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    const path = await writeConfig('pipeline.json', {
      name: 'pipe',
      agent: successAgent,
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
              ],
            },
          },
        },
      ],
    });
    setArgs(path);
    await main();
    expect(logs).toContain('Done');
  });

  it('rejects --doctor on a pipeline with a clear message', async () => {
    const path = await writeConfig('pipeline.json', {
      name: 'pipe',
      agent: successAgent,
      reporter: 'jsonl-report',
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
              ],
            },
          },
        },
      ],
    });
    setArgs('--doctor', path);
    await main();
    expect(errors.join('\n')).toMatch(
      /--doctor does not yet support pipelines/u,
    );
    expect(process.exitCode).toBe(1);
  });

  it('runs --doctor on a healthy standalone config and exits zero', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    const path = await writeConfig('loop.json', {
      name: 'standalone',
      agent: successAgent,
      reporter: 'jsonl-report',
      promptGenerator: [
        'jsonl',
        { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
      ],
    });
    setArgs('--doctor', path);
    await main();
    expect(process.exitCode).toBe(0);
  });

  it('runs --doctor on an unhealthy config and exits non-zero', async () => {
    // A test agent with no responses fails its doctor check.
    const path = await writeConfig('loop.json', {
      name: 'standalone',
      agent: ['test', { responses: [] }],
      reporter: 'jsonl-report',
      promptGenerator: [
        'jsonl',
        { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
      ],
    });
    setArgs('--doctor', path);
    await main();
    expect(process.exitCode).toBe(1);
  });

  it('renders a stopped pipeline result with its message', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    // fix is ordered before review, so with maxPasses=1 the pipeline cannot
    // propagate review's output to fix and stops with reason maxPasses.
    const path = await writeConfig('pipeline.json', {
      name: 'mp',
      agent: successAgent,
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'review',
          maxPasses: 1,
          steps: {
            fix: {
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'f {{id}}',
                },
              ],
            },
            review: {
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'r {{id}}' },
              ],
            },
          },
        },
      ],
    });
    setArgs(path);
    await main();
    expect(logs.join('\n')).toMatch(/Done \(Pipeline did not converge/u);
  });

  it('renders a failed loop result with its message', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    const path = await writeConfig('loop.json', {
      name: 'standalone',
      agent: ['test', { responses: [{ status: 'error', reason: 'boom' }] }],
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'jsonl',
        { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
      ],
    });
    setArgs(path);
    await main();
    expect(logs.join('\n')).toMatch(/Error on a: boom/u);
  });
});
