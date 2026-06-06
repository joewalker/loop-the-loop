// @module-tag local

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPipeline } from 'loop-the-loop/pipeline';
import type { LoopCliConfig } from 'loop-the-loop/types';
import { normalizeCliConfig } from 'loop-the-loop/util/load-cli-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runPipeline', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Normalize a raw pipeline config against a config file in the temp dir, so
   * outputDir is the temp dir and handoff markers resolve to ${name}-${key}.
   */
  async function normalize(raw: LoopCliConfig): Promise<LoopCliConfig> {
    return normalizeCliConfig(raw, join(dir, 'config.json'));
  }

  async function readReportIds(name: string): Promise<Array<string>> {
    const path = join(dir, `${name}-report.jsonl`);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => (JSON.parse(line) as { id: string }).id);
  }

  const successAgent = [
    'test',
    { responses: [{ status: 'success', output: 'ok' }], repeat: 'cycle' },
  ];
  const reworkAgent = [
    'test',
    {
      responses: [
        {
          status: 'success',
          output: 'judged',
          structuredOutput: { verdict: 'rework' },
        },
      ],
      repeat: 'cycle',
    },
  ];

  it('runs a linear pipeline; downstream reads upstream report', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'lin',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'fix',
          steps: {
            review: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
              ],
            },
            fix: {
              agent: successAgent,
              dependsOn: ['review'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'fix {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('lin-review')).toEqual(['bug-1']);
    expect(await readReportIds('lin-fix')).toEqual(['bug-1']);
  });

  it('fans in over two upstream reports', async () => {
    await writeFile(
      join(dir, 'seed-a.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    await writeFile(
      join(dir, 'seed-b.jsonl'),
      `${JSON.stringify({ id: 'b', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'fan',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'merge',
          steps: {
            left: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed-a.jsonl', promptTemplate: 'l {{id}}' },
              ],
            },
            right: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed-b.jsonl', promptTemplate: 'r {{id}}' },
              ],
            },
            merge: {
              agent: successAgent,
              dependsOn: ['left', 'right'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: ['{{steps.left.report}}', '{{steps.right.report}}'],
                  promptTemplate: 'm {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect((await readReportIds('fan-merge')).sort()).toEqual(['a', 'b']);
  });

  it('terminates a rework cycle at the attempt cap with a giveup outcome', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'rw',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'summary',
          steps: {
            'fix-new': {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'fix {{id}}' },
              ],
            },
            'fix-rework': {
              agent: successAgent,
              dependsOn: ['verify'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.verify.report}}',
                  filter: { 'structuredOutput.verdict': 'rework' },
                  maxAttempts: 2,
                  incrementAttempt: true,
                  promptTemplate: 'rework {{id}}',
                },
              ],
            },
            verify: {
              agent: reworkAgent,
              dependsOn: ['fix-new', 'fix-rework'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: [
                    '{{steps.fix-new.report}}',
                    '{{steps.fix-rework.report}}',
                  ],
                  promptTemplate: 'verify {{id}}',
                },
              ],
            },
            giveup: {
              agent: successAgent,
              dependsOn: ['verify'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.verify.report}}',
                  filter: { 'structuredOutput.verdict': 'rework' },
                  minAttempts: 2,
                  promptTemplate: 'giveup {{id}}',
                },
              ],
            },
            summary: {
              agent: successAgent,
              dependsOn: ['giveup'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: ['{{steps.giveup.report}}'],
                  promptTemplate: 'summary {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('rw-giveup')).toEqual(['bug-1#2']);
    expect(await readReportIds('rw-summary')).toEqual(['bug-1#2']);
  });

  it('applies per-step agent overrides and derives pipeline-step artifacts', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'ovr',
      agent: [
        'test',
        {
          responses: [{ status: 'error', reason: 'top-level agent used' }],
          repeat: 'cycle',
        },
      ],
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    // The step agent (success), not the top-level error agent, ran.
    expect(await readReportIds('ovr-only')).toEqual(['x']);
  });

  it('stops the pipeline at a failing step under the strict policy', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'fail',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'down',
          steps: {
            up: {
              agent: [
                'test',
                {
                  responses: [{ status: 'error', reason: 'boom' }],
                  repeat: 'cycle',
                },
              ],
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'up {{id}}' },
              ],
            },
            down: {
              agent: successAgent,
              dependsOn: ['up'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.up.report}}',
                  promptTemplate: 'down {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/Pipeline stopped at step "fail-up"/u);
    // down never ran.
    expect(await readReportIds('fail-down')).toEqual([]);
  });

  it('fast-forwards a settled pipeline on resume', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const make = async (): Promise<LoopCliConfig> =>
      normalize({
        name: 'res',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        interPromptPause: 0,
        promptGenerator: [
          'pipeline',
          {
            output: 'only',
            steps: {
              only: {
                agent: successAgent,
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'seed.jsonl', promptTemplate: 'd {{id}}' },
                ],
              },
            },
          },
        ],
      } as unknown as LoopCliConfig);

    expect((await runPipeline(await make())).status).toBe('completed');
    const first = await readReportIds('res-only');
    expect((await runPipeline(await make())).status).toBe('completed');
    // No new lines appended on the settled resume.
    expect(await readReportIds('res-only')).toEqual(first);
  });

  it('stops with reason maxPasses when it cannot converge in the budget', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    // fix is ordered before review (config order, no dependsOn), so fix sees
    // nothing in pass 1; review produces in pass 1; with maxPasses=1 the run
    // stops before fix can consume review's output.
    const config = await normalize({
      name: 'mp',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'review',
          maxPasses: 1,
          steps: {
            fix: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'f {{id}}',
                },
              ],
            },
            review: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'r {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({
      status: 'stopped',
      reason: 'maxPasses',
      message: 'Pipeline did not converge within 1 passes',
    });
  });

  it('honours step-level allowSourceUpdate, maxPrompts and logger overrides', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n`,
    );
    // Pre-seed a resultless v2 state file so the initial outcome count reads a
    // present-but-empty state (the `data.results ? ... : 0` false branch).
    await writeFile(
      join(dir, 'cfg-only-loop-state.json'),
      JSON.stringify({ version: 2 }),
    );
    const config = await normalize({
      name: 'cfg',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              agent: successAgent,
              allowSourceUpdate: false,
              maxPrompts: 5,
              logger: 'verbose',
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'do {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('cfg-only')).toEqual(['a']);
  });

  it('falls back to inherited defaults when neither step nor top-level set fields', async () => {
    // A config with no top-level outputDir, reporter, or interPromptPause, and
    // an empty input so no prompt ever runs (the inherited 5s pause would only
    // fire after a successful prompt). This exercises the "absent" side of the
    // per-step config merge and the process.cwd() fallback for the state path.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await writeFile(join(dir, 'empty.jsonl'), '');
      const config = {
        name: 'bare',
        agent: successAgent,
        promptGenerator: [
          'pipeline',
          {
            output: 'only',
            steps: {
              only: {
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'empty.jsonl', promptTemplate: 'x {{id}}' },
                ],
              },
            },
          },
        ],
      } as unknown as LoopCliConfig;

      const result = await runPipeline(config);
      expect(result).toEqual({ status: 'completed' });
    } finally {
      process.chdir(cwd);
    }
  });
});
