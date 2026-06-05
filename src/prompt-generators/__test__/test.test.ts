// @module-tag local

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  normalizeTestTaskConfig,
  TestPromptGenerator,
  type TestTask,
} from 'loop-the-loop/prompt-generators/test';
import { describe, expect, it } from 'vitest';

describe('normalizeTestTaskConfig', () => {
  it('should accept an array of prompt strings', () => {
    const config = { prompts: ['First prompt', 'Second prompt'] };

    expect(normalizeTestTaskConfig(config)).toBe(config);
  });

  it('should reject unknown properties', () => {
    expect(() =>
      normalizeTestTaskConfig({
        prompts: ['Prompt'],
        promptTemplate: '{{value}}',
      }),
    ).toThrow('test.promptTemplate is not supported');
  });

  it('should reject malformed prompts', () => {
    expect(() => normalizeTestTaskConfig({ prompts: ['Prompt', 42] })).toThrow(
      'test.prompts must be an array of strings',
    );
  });
});

describe('TestPromptGenerator', () => {
  const loopState = new FileLoopState('loop-state-ignore.json');

  async function collect(task: TestTask): Promise<Array<Prompt>> {
    const generator = new TestPromptGenerator(task);
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    return prompts;
  }

  it('should yield each configured prompt with a stable index id', async () => {
    await expect(
      collect({
        prompts: ['First prompt', 'Second prompt'],
      }),
    ).resolves.toStrictEqual([
      { id: '0', prompt: 'First prompt' },
      { id: '1', prompt: 'Second prompt' },
    ]);
  });

  it('should skip prompts already tracked in loopState', async () => {
    const stateWithOne = FileLoopState.fromPersisted('loop-state-ignore.json', {
      version: 2,
      results: { '0': { status: 'success' } },
      claims: {},
    });
    const generator = new TestPromptGenerator({
      prompts: ['First prompt', 'Second prompt'],
    });
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(stateWithOne)) {
      prompts.push(prompt);
    }

    expect(prompts).toStrictEqual([{ id: '1', prompt: 'Second prompt' }]);
  });
});
