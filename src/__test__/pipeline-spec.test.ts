// @module-tag local

import {
  assertReporterHandoffContract,
  collectReportConsumers,
  isPipelineSpec,
  normalizePipelineTaskConfig,
  PIPELINE_GENERATOR_NAME,
} from 'loop-the-loop/pipeline-spec';
import type { PipelineTask } from 'loop-the-loop/types';
import { describe, expect, it } from 'vitest';

const MINIMAL = {
  output: 'a',
  steps: {
    a: { promptGenerator: ['test', { prompts: ['x'] }] },
  },
};

describe('isPipelineSpec', () => {
  it('detects a pipeline tuple', () => {
    expect(isPipelineSpec([PIPELINE_GENERATOR_NAME, MINIMAL])).toBe(true);
  });

  it('rejects other generator tuples and non-arrays', () => {
    expect(isPipelineSpec(['jsonl', {}])).toBe(false);
    expect(isPipelineSpec('jsonl')).toBe(false);
    expect(isPipelineSpec(undefined)).toBe(false);
  });
});

describe('normalizePipelineTaskConfig', () => {
  it('accepts a minimal pipeline', () => {
    expect(normalizePipelineTaskConfig(MINIMAL)).toEqual(MINIMAL);
  });

  it('rejects a non-object', () => {
    expect(() => normalizePipelineTaskConfig('x')).toThrow(
      'pipeline task config must be an object',
    );
  });

  it('rejects an unknown property', () => {
    expect(() => normalizePipelineTaskConfig({ ...MINIMAL, nope: 1 })).toThrow(
      'pipeline.nope is not supported',
    );
  });

  it('rejects a missing or empty steps object', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'a', steps: {} }),
    ).toThrow('pipeline.steps must have at least one step');
  });

  it('rejects a step without a promptGenerator', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'a', steps: { a: {} } }),
    ).toThrow('pipeline.steps.a.promptGenerator is required');
  });

  it('rejects an unknown step property', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: { a: { promptGenerator: ['test', {}], nope: 1 } },
      }),
    ).toThrow('pipeline.steps.a.nope is not supported');
  });

  it('rejects a missing output step', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'z', steps: MINIMAL.steps }),
    ).toThrow('pipeline.output "z" is not a declared step');
  });

  it('rejects a dependsOn naming an unknown step', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: {
          a: { promptGenerator: ['test', {}], dependsOn: ['ghost'] },
        },
      }),
    ).toThrow('pipeline.steps.a.dependsOn references unknown step "ghost"');
  });

  it('rejects a non-string output', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 1, steps: MINIMAL.steps }),
    ).toThrow('pipeline.output must be a string');
  });

  it('rejects a non-object steps', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'a', steps: 'x' }),
    ).toThrow('pipeline.steps must be an object');
  });

  it('rejects a non-object step', () => {
    expect(() =>
      normalizePipelineTaskConfig({ output: 'a', steps: { a: 'x' } }),
    ).toThrow('pipeline.steps.a must be an object');
  });

  it('rejects a non-array dependsOn', () => {
    expect(() =>
      normalizePipelineTaskConfig({
        output: 'a',
        steps: { a: { promptGenerator: ['test', {}], dependsOn: 'x' } },
      }),
    ).toThrow('pipeline.steps.a.dependsOn must be an array of strings');
  });

  it('rejects a non-integer maxPasses', () => {
    expect(() =>
      normalizePipelineTaskConfig({ ...MINIMAL, maxPasses: 0 }),
    ).toThrow('pipeline.maxPasses must be a positive integer');
  });

  it('accepts a valid maxPasses', () => {
    expect(() =>
      normalizePipelineTaskConfig({ ...MINIMAL, maxPasses: 20 }),
    ).not.toThrow();
  });

  it('rejects a non-number maxPasses', () => {
    expect(() =>
      normalizePipelineTaskConfig({ ...MINIMAL, maxPasses: 'x' }),
    ).toThrow('pipeline.maxPasses must be a positive integer');
  });

  it('rejects a fractional maxPasses', () => {
    expect(() =>
      normalizePipelineTaskConfig({ ...MINIMAL, maxPasses: 2.5 }),
    ).toThrow('pipeline.maxPasses must be a positive integer');
  });

  it('allows a cyclic dependsOn (rework is a feature)', () => {
    const cyclic = {
      output: 'fix',
      steps: {
        fix: { promptGenerator: ['test', {}], dependsOn: ['verify'] },
        verify: { promptGenerator: ['test', {}], dependsOn: ['fix'] },
      },
    };
    expect(() => normalizePipelineTaskConfig(cyclic)).not.toThrow();
  });
});

describe('collectReportConsumers', () => {
  it('finds report markers in a jsonl reader, including arrays', () => {
    const consumers = collectReportConsumers([
      'jsonl',
      {
        dataFile: ['{{steps.commit.report}}', '{{steps.giveup.report}}'],
        promptTemplate: '{{id}}',
      },
    ]);
    expect([...consumers].sort()).toEqual(['commit', 'giveup']);
  });

  it('returns no consumers for a non-array spec or a non-jsonl reader', () => {
    expect(collectReportConsumers('not-an-array').size).toBe(0);
    expect(
      collectReportConsumers(['jsonl', { dataFile: [7], promptTemplate: 'x' }])
        .size,
    ).toBe(0);
  });

  it('ignores state markers and recurses into batch sources', () => {
    const consumers = collectReportConsumers([
      'batch',
      {
        source: [
          'jsonl',
          { dataFile: '{{steps.fix.report}}', promptTemplate: 'x' },
        ],
        summaryPromptTemplate: 's',
        reportFile: 'r',
      },
    ]);
    expect([...consumers]).toEqual(['fix']);
    expect(
      collectReportConsumers([
        'loop-state',
        { stateFile: '{{steps.fix.state}}', promptTemplate: 'x' },
      ]).size,
    ).toBe(0);
  });
});

describe('assertReporterHandoffContract', () => {
  const task: PipelineTask = {
    output: 'commit',
    steps: {
      verify: {
        promptGenerator: [
          'jsonl',
          { dataFile: 'seed.jsonl', promptTemplate: 'x' },
        ],
      },
      commit: {
        promptGenerator: [
          'jsonl',
          { dataFile: '{{steps.verify.report}}', promptTemplate: 'x' },
        ],
      },
    },
  };

  it('passes when the consumed producer uses jsonl-report', () => {
    expect(() =>
      assertReporterHandoffContract(task, 'jsonl-report'),
    ).not.toThrow();
  });

  it('rejects when the producer falls back to a non-jsonl reporter', () => {
    expect(() => assertReporterHandoffContract(task, 'default')).toThrow(
      /step "commit" reads \{\{steps\.verify\.report\}\}/u,
    );
  });
});
