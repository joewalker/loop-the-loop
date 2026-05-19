// @module-tag local

import { configureQueryOptions } from 'loop-the-loop/agents/claude-sdk';
import { describe, expect, it } from 'vitest';

describe('splitAllowedTools', () => {
  it('passes bare tool names through to both lists', async () => {
    const result = await configureQueryOptions({
      allowedTools: ['Read', 'Glob', 'Grep'],
    });
    expect(result.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('extracts the bare name for permission patterns when populating tools', async () => {
    const result = await configureQueryOptions({
      allowedTools: [
        'Read',
        'Bash(gh issue create *)',
        'Bash(gh issue list *)',
        'Bash(ls *)',
      ],
    });
    expect(result.tools).toEqual(['Read', 'Bash']);
    expect(result.allowedTools).toEqual([
      'Read',
      'Bash(gh issue create *)',
      'Bash(gh issue list *)',
      'Bash(ls *)',
    ]);
  });

  it('deduplicates bare names in the tools list', async () => {
    const result = await configureQueryOptions({
      allowedTools: ['Bash', 'Bash(gh issue view *)', 'Bash(ls *)'],
    });
    expect(result.tools).toEqual(['Bash']);
  });

  it('returns empty lists for an empty input', async () => {
    const result = await configureQueryOptions({ allowedTools: [] });
    expect(result.tools).toEqual([]);
    expect(result.allowedTools).toEqual([]);
  });

  it('uses the default permission mode when source updates are not allowed', async () => {
    const result = await configureQueryOptions({ allowedTools: ['Read'] });
    expect(result.permissionMode).toBe('default');
  });

  it('uses acceptEdits when source updates are allowed', async () => {
    const result = await configureQueryOptions(
      { allowedTools: ['Read'] },
      true,
    );
    expect(result.permissionMode).toBe('acceptEdits');
  });
});
