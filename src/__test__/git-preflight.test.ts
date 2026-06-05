// @module-tag local

import { gitPreflight } from 'loop-the-loop/git-preflight';
import type { Git } from 'loop-the-loop/util/git';
import { describe, expect, it } from 'vitest';

function fakeGit(overrides: Partial<Git>): Git {
  return {
    isInsideWorkTree: async () => true,
    isClean: async () => true,
    configValue: async (key: string) =>
      key === 'user.name' ? 'Ada' : 'ada@example.com',
    ...overrides,
  } as unknown as Git;
}

describe('gitPreflight', () => {
  it('returns three ok items when inside a clean tree with identity', async () => {
    const items = await gitPreflight(fakeGit({}));
    expect(items.map(i => i.ok)).toEqual([true, true, true]);
    expect(items.map(i => i.name)).toEqual([
      'inside work tree',
      'clean working tree',
      'committer identity',
    ]);
    expect(items[2].message).toBe('Ada <ada@example.com>');
  });

  it('stops after the work-tree item when not inside a work tree', async () => {
    const items = await gitPreflight(
      fakeGit({ isInsideWorkTree: async () => false }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].ok).toBe(false);
    expect(items[0].name).toBe('inside work tree');
  });

  it('flags a dirty tree with the loop-compatible message', async () => {
    const items = await gitPreflight(fakeGit({ isClean: async () => false }));
    const clean = items.find(i => i.name === 'clean working tree');
    expect(clean?.ok).toBe(false);
    expect(clean?.message).toBe(
      'Working directory is not clean. Commit or stash changes before starting.',
    );
  });

  it('flags missing committer identity', async () => {
    const items = await gitPreflight(
      fakeGit({ configValue: async () => undefined }),
    );
    const ident = items.find(i => i.name === 'committer identity');
    expect(ident?.ok).toBe(false);
    expect(ident?.message).toBe(
      'git user.name / user.email are not configured for commits.',
    );
  });
});
