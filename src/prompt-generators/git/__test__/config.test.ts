// @module-tag local

import { normalizeGitTaskConfig } from 'loop-the-loop/prompt-generators/git/config';
import { describe, expect, it } from 'vitest';

describe('normalizeGitTaskConfig', () => {
  it('returns a valid config unchanged', () => {
    const config = { range: 'main..HEAD', promptTemplate: 'Review {{hash}}' };
    expect(normalizeGitTaskConfig(config)).toBe(config);
  });

  it('accepts an optional repoPath', () => {
    const config = {
      range: 'main..HEAD',
      repoPath: '../other',
      promptTemplate: 'Review {{hash}}',
    };
    expect(normalizeGitTaskConfig(config)).toBe(config);
  });

  it('throws when the value is not an object', () => {
    expect(() => normalizeGitTaskConfig('nope')).toThrow(
      'git task config must be an object',
    );
  });

  it('throws when range is missing', () => {
    expect(() => normalizeGitTaskConfig({ promptTemplate: 'x' })).toThrow(
      'git.range must be a string',
    );
  });

  it('throws when promptTemplate is missing', () => {
    expect(() => normalizeGitTaskConfig({ range: 'main..HEAD' })).toThrow(
      'git.promptTemplate must be a string',
    );
  });

  it('throws when repoPath is not a string', () => {
    expect(() =>
      normalizeGitTaskConfig({
        range: 'main..HEAD',
        repoPath: 5,
        promptTemplate: 'x',
      }),
    ).toThrow('git.repoPath must be a string');
  });

  it('throws on an unknown property', () => {
    expect(() =>
      normalizeGitTaskConfig({
        range: 'main..HEAD',
        promptTemplate: 'x',
        bogus: true,
      }),
    ).toThrow('git.bogus is not supported');
  });
});
