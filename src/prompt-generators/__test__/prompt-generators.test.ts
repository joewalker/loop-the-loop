import {
  createPromptGenerator,
  promptGeneratorTypes,
} from 'loop-the-loop/prompt-generators';
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
});

describe('createPromptGenerator', () => {
  it('should return a PromptGenerator with generate()', async () => {
    const generator = await createPromptGenerator(['per-file', task]);
    expect(typeof generator.generate).toBe('function');
  });

  it('should return a pre-constructed PromptGenerator instance as-is', async () => {
    const mockGenerator = {
      generate: async function* () {},
    };
    const result = await createPromptGenerator(mockGenerator);
    expect(result).toBe(mockGenerator);
  });
});
