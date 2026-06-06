// @module-tag local

import {
  createPromptGenerator,
  normalizePromptGeneratorSpec,
  promptGeneratorTypes,
} from 'loop-the-loop/prompt-generators';
import { BatchPromptGenerator } from 'loop-the-loop/prompt-generators/batch';
import type { PerFileTask } from 'loop-the-loop/prompt-generators/per-file';
import { describe, expect, it } from 'vitest';

const task: PerFileTask = {
  filePattern: 'src/**/*.tsx',
  excludePatterns: ['**/__test__/**'],
  promptTemplate: 'Review {{file}}',
};

describe('promptGeneratorTypes', () => {
  it('should include per-file', () => {
    expect(promptGeneratorTypes).toContain('per-file');
  });

  it('should include bugzilla', () => {
    expect(promptGeneratorTypes).toContain('bugzilla');
  });

  it('should include github', () => {
    expect(promptGeneratorTypes).toContain('github');
  });

  it('should include gitlab', () => {
    expect(promptGeneratorTypes).toContain('gitlab');
  });

  it('should include test', () => {
    expect(promptGeneratorTypes).toContain('test');
  });

  it('includes loop-state', () => {
    expect(promptGeneratorTypes).toContain('loop-state');
  });

  it('includes jsonl', () => {
    expect(promptGeneratorTypes).toContain('jsonl');
  });
});

describe('createPromptGenerator', () => {
  it('should return a PromptGenerator with generate()', async () => {
    const generator = await createPromptGenerator(['per-file', task]);
    expect(typeof generator.generate).toBe('function');
  });

  it('should resolve a test prompt generator', async () => {
    const generator = await createPromptGenerator([
      'test',
      { prompts: ['First prompt'] },
    ]);
    expect(typeof generator.generate).toBe('function');
  });

  it('should return a pre-constructed PromptGenerator instance as-is', async () => {
    const mockGenerator = {
      generate: async function* () {},
    };
    const result = await createPromptGenerator(mockGenerator);
    expect(result).toBe(mockGenerator);
  });

  it('should resolve a batch generator with a nested source spec', async () => {
    const generator = await createPromptGenerator([
      'batch',
      {
        source: ['per-file', task],
        summaryPromptTemplate: 'Summarize {{batchSize}}',
        reportFile: 'report.yaml',
      },
    ]);
    expect(generator).toBeInstanceOf(BatchPromptGenerator);
  });

  it('createPromptGenerator throws on a pipeline spec', async () => {
    await expect(
      createPromptGenerator(['pipeline', { output: 'a', steps: {} }] as never),
    ).rejects.toThrow('pipeline specs are not prompt generators');
  });

  it('normalizePromptGeneratorSpec throws on a nested pipeline', () => {
    expect(() =>
      normalizePromptGeneratorSpec(['pipeline', {}] as never, {
        configDir: '/x',
        outputDir: '/x',
      }),
    ).toThrow('nested pipelines are not supported');
  });
});
