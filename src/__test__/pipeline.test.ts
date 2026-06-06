// @module-tag local

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent } from 'loop-the-loop/agents';
import { runPipeline } from 'loop-the-loop/pipeline';
import type { InvokeResult, LoopCliConfig } from 'loop-the-loop/types';
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
  const costAgent = [
    'test',
    {
      responses: [
        {
          status: 'success',
          output: 'ok',
          cost: { usd: 1, costSource: 'provider' },
        },
      ],
      repeat: 'cycle',
    },
  ];

  /**
   * An agent that records the peak number of overlapping invocations, using a
   * real-but-faked timer delay so several invocations stay in flight. Used to
   * prove a per-step `concurrency` override reaches the step's loop pool.
   */
  class OverlapAgent implements Agent {
    active = 0;
    maxActive = 0;
    async invoke(): Promise<InvokeResult> {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise<void>(resolve => {
        setTimeout(resolve, 10);
      });
      this.active -= 1;
      return { status: 'success', output: 'ok' };
    }
  }

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

  it('stops before a downstream step when the shared cap is reached', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'cap',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      maxBudgetUsd: 1,
      promptGenerator: [
        'pipeline',
        {
          output: 'fix',
          steps: {
            review: {
              agent: costAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
              ],
            },
            fix: {
              agent: costAgent,
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
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('maxBudgetUsd');
    expect(result.message).toMatch(
      /Pipeline budget reached before step "cap-fix"/u,
    );
    // review ran and spent $1; fix never ran.
    expect(await readReportIds('cap-review')).toEqual(['bug-1']);
    expect(await readReportIds('cap-fix')).toEqual([]);
  });

  it('honours a stricter step-level maxBudgetUsd via the step loop', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n${JSON.stringify({
        id: 'b',
        status: 'success',
      })}\n`,
    );
    const config = await normalize({
      name: 'local',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              agent: costAgent,
              maxBudgetUsd: 1,
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
    // The step's own loop stopped after the first $1 prompt; the strict policy
    // surfaces it annotated with the step name. Without buildStepConfig
    // threading the override the step would run with Infinity and complete.
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('maxBudgetUsd');
    expect(result.message).toMatch(/Pipeline stopped at step "local-only"/u);
    expect(await readReportIds('local-only')).toEqual(['a']);
  });

  it('is deterministic on resume after a shared-cap stop', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const make = async (): Promise<LoopCliConfig> =>
      normalize({
        name: 'res',
        agent: 'claude-sdk',
        reporter: 'jsonl-report',
        interPromptPause: 0,
        maxBudgetUsd: 1,
        promptGenerator: [
          'pipeline',
          {
            output: 'fix',
            steps: {
              review: {
                agent: costAgent,
                promptGenerator: [
                  'jsonl',
                  { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
                ],
              },
              fix: {
                agent: costAgent,
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

    const first = await runPipeline(await make());
    expect(first.reason).toBe('maxBudgetUsd');
    const reviewIds = await readReportIds('res-review');

    // Resume: the persisted aggregate ($1) already meets the cap, so the
    // pipeline stops before review even re-runs, deterministically.
    const second = await runPipeline(await make());
    expect(second.status).toBe('stopped');
    expect(second.reason).toBe('maxBudgetUsd');
    expect(second.message).toMatch(/before step "res-review"/u);
    expect(await readReportIds('res-review')).toEqual(reviewIds);
    expect(await readReportIds('res-fix')).toEqual([]);
  });

  it('completes under a shared cap when results carry no cost', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'free',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      maxBudgetUsd: 5,
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
    // No cost recorded, so the aggregate stays $0 and the finite cap never
    // trips; the pipeline runs to its normal fixed point.
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('free-review')).toEqual(['x']);
    expect(await readReportIds('free-fix')).toEqual(['x']);
  });

  it('overlaps independent steps within a pass under maxStepConcurrency', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'par',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'right',
          maxStepConcurrency: 2,
          steps: {
            left: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'left {{id}}' },
              ],
            },
            right: {
              agent: successAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'right {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    // Two independent steps both run in the pass and the pipeline converges,
    // exercising the maxStepConcurrency > 1 dispatch path.
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('par-left')).toEqual(['x']);
    expect(await readReportIds('par-right')).toEqual(['x']);
  });

  it('respects a dependsOn cycle when orienting earlier dependencies', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'x', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'cyc',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      promptGenerator: [
        'pipeline',
        {
          output: 'a',
          maxStepConcurrency: 2,
          steps: {
            // a <-> b is a dependsOn cycle. orderStepKeys breaks it, so one
            // back-edge is excluded from earlierDeps and the pass never stalls.
            a: {
              agent: successAgent,
              dependsOn: ['b'],
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'a {{id}}' },
              ],
            },
            b: {
              agent: successAgent,
              dependsOn: ['a'],
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'b {{id}}' },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result).toEqual({ status: 'completed' });
    expect(await readReportIds('cyc-a')).toEqual(['x']);
    expect(await readReportIds('cyc-b')).toEqual(['x']);
  });

  it('treats an allowSourceUpdate step as a source step even when gated', async () => {
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'bug-1', status: 'success' })}\n`,
    );
    const config = await normalize({
      name: 'src',
      agent: 'claude-sdk',
      reporter: 'jsonl-report',
      interPromptPause: 0,
      maxBudgetUsd: 1,
      promptGenerator: [
        'pipeline',
        {
          output: 'commit',
          steps: {
            review: {
              agent: costAgent,
              promptGenerator: [
                'jsonl',
                { dataFile: 'seed.jsonl', promptTemplate: 'review {{id}}' },
              ],
            },
            // Marked source: its isSource is computed when building the pass
            // schedule, covering the true branch. The shared cap trips after
            // review spends $1, so commit is gated before it ever runs (so no
            // gitPreflight fires in the plain temp dir).
            commit: {
              agent: costAgent,
              allowSourceUpdate: true,
              dependsOn: ['review'],
              promptGenerator: [
                'jsonl',
                {
                  dataFile: '{{steps.review.report}}',
                  promptTemplate: 'commit {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig);

    const result = await runPipeline(config);
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('maxBudgetUsd');
    expect(result.message).toMatch(/before step "src-commit"/u);
    expect(await readReportIds('src-review')).toEqual(['bug-1']);
    expect(await readReportIds('src-commit')).toEqual([]);
  });

  it('threads a per-step concurrency override into the step loop', async () => {
    // Real timers: the agent's short delay keeps several invocations in flight
    // so the peak overlap is observable, mirroring the working OverlapAgent
    // proof in loop.test.ts. Fake timers fire the first invocation's delay
    // before the other workers reach the agent, hiding the overlap.
    const overlap = new OverlapAgent();
    await writeFile(
      join(dir, 'seed.jsonl'),
      `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({
        id: 'b',
      })}\n${JSON.stringify({ id: 'c' })}\n`,
    );
    const config: LoopCliConfig = {
      name: 'wc',
      outputDir: dir,
      reporter: 'jsonl-report',
      interPromptPause: 0,
      agent: ['test', { responses: [{ status: 'success', output: 'ok' }] }],
      promptGenerator: [
        'pipeline',
        {
          output: 'only',
          steps: {
            only: {
              agent: overlap,
              concurrency: 3,
              promptGenerator: [
                'jsonl',
                {
                  dataFile: join(dir, 'seed.jsonl'),
                  promptTemplate: 'do {{id}}',
                },
              ],
            },
          },
        },
      ],
    } as unknown as LoopCliConfig;

    const result = await runPipeline(config);
    // Without buildStepConfig threading `concurrency`, the step would run at
    // the default of 1 and maxActive would be 1.
    expect(result).toEqual({ status: 'completed' });
    expect(overlap.maxActive).toBe(3);
  });
});
