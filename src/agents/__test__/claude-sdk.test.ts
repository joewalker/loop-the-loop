// @module-tag local

import { splitAllowedTools } from 'loop-the-loop/agents/claude-sdk';
import { describe, expect, it } from 'vitest';

describe('splitAllowedTools', () => {
  it('passes bare tool names through to both lists', () => {
    const result = splitAllowedTools(['Read', 'Glob', 'Grep']);
    expect(result.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('extracts the bare name for permission patterns when populating tools', () => {
    const result = splitAllowedTools([
      'Read',
      'Bash(gh issue create *)',
      'Bash(gh issue list *)',
      'Bash(ls *)',
    ]);
    expect(result.tools).toEqual(['Read', 'Bash']);
    expect(result.allowedTools).toEqual([
      'Read',
      'Bash(gh issue create *)',
      'Bash(gh issue list *)',
      'Bash(ls *)',
    ]);
  });

  it('deduplicates bare names in the tools list', () => {
    const result = splitAllowedTools([
      'Bash',
      'Bash(gh issue view *)',
      'Bash(ls *)',
    ]);
    expect(result.tools).toEqual(['Bash']);
  });

  it('returns empty lists for an empty input', () => {
    const result = splitAllowedTools([]);
    expect(result.tools).toEqual([]);
    expect(result.allowedTools).toEqual([]);
  });
});
