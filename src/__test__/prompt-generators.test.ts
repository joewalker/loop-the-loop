import type { PerFileAgenticTask } from 'agentic-loop/prompt-generators/per-file';
import {
  createPromptGenerator,
  promptGeneratorTypes,
} from 'agentic-loop/prompt-generators/prompt-generators';
import { describe, expect, it } from 'vitest';

const task: PerFileAgenticTask = {
  filePattern: 'src/**/*.tsx',
  excludePatterns: ['**/__test__/**'],
  promptTemplate: 'Review {{file}}',
};

describe('promptGeneratorTypes', () => {
  it('should include per-file', () => {
    expect(promptGeneratorTypes).toContain('per-file');
  });
});

describe('createPromptGenerator', () => {
  it('should return a PromptGenerator with generate()', () => {
    const generator = createPromptGenerator('per-file', task);
    expect(typeof generator.generate).toBe('function');
  });
});
