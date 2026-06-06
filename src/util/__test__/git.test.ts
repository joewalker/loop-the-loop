// @module-tag local

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git } from 'loop-the-loop/util/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function setConfig(repoPath: string, key: string, value: string): void {
  execFileSync('git', ['-C', repoPath, 'config', key, value]);
}

describe('Git', () => {
  let repoPath: string;
  let git: Git;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'git-test-'));
    git = new Git(repoPath);
    await git.init();

    // Create an initial commit so the repo isn't empty
    await writeFile(join(repoPath, 'initial.txt'), 'initial');
    await git.add('initial.txt');
    await git.commit('Initial commit', {
      committer: { name: 'Test', email: 'test@test.com' },
    });
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  describe('init', () => {
    it('should initialize a git repository', async () => {
      const newPath = await mkdtemp(join(tmpdir(), 'git-init-test-'));
      try {
        const newGit = new Git(newPath);
        await newGit.init();
        expect(await newGit.isClean()).toBe(true);
      } finally {
        await rm(newPath, { recursive: true, force: true });
      }
    });
  });

  describe('isClean', () => {
    it('should return true for a clean repo', async () => {
      expect(await git.isClean()).toBe(true);
    });

    it('should return false when there are uncommitted changes', async () => {
      await writeFile(join(repoPath, 'dirty.txt'), 'dirty');
      expect(await git.isClean()).toBe(false);
    });
  });

  describe('add', () => {
    it('should add specific files', async () => {
      await writeFile(join(repoPath, 'a.txt'), 'a');
      await writeFile(join(repoPath, 'b.txt'), 'b');
      await git.add('a.txt');

      // Commit only a.txt - b.txt should still make the repo dirty
      await git.commit('Add a', {
        committer: { name: 'Test', email: 'test@test.com' },
      });
      expect(await git.isClean()).toBe(false);
    });

    it('should add all files when no arguments given', async () => {
      await writeFile(join(repoPath, 'c.txt'), 'c');
      await writeFile(join(repoPath, 'd.txt'), 'd');
      await git.add();

      await git.commit('Add all', {
        committer: { name: 'Test', email: 'test@test.com' },
      });
      expect(await git.isClean()).toBe(true);
    });

    it('should treat file names starting with - as paths, not flags', async () => {
      await writeFile(join(repoPath, '-foo.txt'), 'foo');
      await git.add('-foo.txt');

      await git.commit('Add dash-prefixed file', {
        committer: { name: 'Test', email: 'test@test.com' },
      });
      expect(await git.isClean()).toBe(true);
    });
  });

  describe('commit', () => {
    it('should create a commit with a message', async () => {
      await writeFile(join(repoPath, 'file.txt'), 'content');
      await git.add('file.txt');

      const result = await git.commit('Test commit', {
        committer: { name: 'Author', email: 'author@test.com' },
      });
      expect(result).toContain('Test commit');
      expect(await git.isClean()).toBe(true);
    });

    it('should throw when message is empty', async () => {
      await expect(
        git.commit('', {
          committer: { name: 'Test', email: 'test@test.com' },
        }),
      ).rejects.toThrow('Missing message');
    });

    it('should support a custom date', async () => {
      await writeFile(join(repoPath, 'dated.txt'), 'dated');
      await git.add('dated.txt');

      const date = new Date('2024-01-15T12:00:00Z').getTime();
      const result = await git.commit('Dated commit', {
        committer: { name: 'Test', email: 'test@test.com' },
        date,
      });
      expect(result).toContain('Dated commit');
    });
  });

  describe('maybeCommitAll', () => {
    it('should commit when there are changes', async () => {
      await writeFile(join(repoPath, 'new.txt'), 'new content');
      const options = { committer: { name: 'Bot', email: 'bot@test.com' } };

      const result = await git.maybeCommitAll('Auto commit', options);
      expect(result).toContain('Auto commit');
      expect(await git.isClean()).toBe(true);
    });

    it('should return empty string when repo is clean', async () => {
      const options = { committer: { name: 'Bot', email: 'bot@test.com' } };
      const result = await git.maybeCommitAll('Nothing to commit', options);
      expect(result).toBe('');
    });
  });

  describe('isInsideWorkTree', () => {
    it('should return true inside a work tree', async () => {
      expect(await git.isInsideWorkTree()).toBe(true);
    });

    it('should return false outside a work tree', async () => {
      const nonRepo = await mkdtemp(join(tmpdir(), 'git-nonrepo-'));
      try {
        const outside = new Git(nonRepo);
        expect(await outside.isInsideWorkTree()).toBe(false);
      } finally {
        await rm(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('configValue', () => {
    it('should return the trimmed value of a set key', async () => {
      setConfig(repoPath, 'loop.test', 'hello');
      expect(await git.configValue('loop.test')).toBe('hello');
    });

    it('should return undefined for an unset key', async () => {
      expect(await git.configValue('loop.definitelyUnset')).toBeUndefined();
    });

    it('should return undefined for an empty value', async () => {
      setConfig(repoPath, 'loop.empty', '');
      expect(await git.configValue('loop.empty')).toBeUndefined();
    });
  });

  /** Run a raw git command in the fixture repo and return trimmed stdout. */
  function rawGit(...args: Array<string>): string {
    return execFileSync('git', ['-C', repoPath, ...args])
      .toString()
      .trim();
  }

  /** Create and commit a file in the fixture repo. */
  async function commitFile(
    file: string,
    content: string,
    message: string,
  ): Promise<string> {
    await writeFile(join(repoPath, file), content);
    await git.add(file);
    await git.commit(message, {
      committer: { name: 'Test', email: 'test@test.com' },
    });
    return rawGit('rev-parse', 'HEAD');
  }

  describe('revList', () => {
    it('returns non-merge commits oldest-first for a linear range', async () => {
      // beforeEach already created the "Initial commit" (commit A).
      const a = rawGit('rev-parse', 'HEAD');
      const b = await commitFile('b.txt', 'B', 'Commit B');
      const c = await commitFile('c.txt', 'C', 'Commit C');

      expect(await git.revList(`${a}..HEAD`)).toEqual([b, c]);
    });

    it('excludes merge commits', async () => {
      rawGit('config', 'user.name', 'Test');
      rawGit('config', 'user.email', 'test@test.com');
      const a = rawGit('rev-parse', 'HEAD');
      const b = await commitFile('b.txt', 'B', 'Commit B');

      rawGit('checkout', '-b', 'feature', a);
      const c = await commitFile('c.txt', 'C', 'Commit C');

      const base = 'master';
      // The default branch may be master or main; check out whichever exists.
      const branches = rawGit('branch', '--format=%(refname:short)').split(
        '\n',
      );
      rawGit('checkout', branches.includes(base) ? base : 'main');
      rawGit('merge', '--no-ff', '-m', 'Merge feature', 'feature');
      const merge = rawGit('rev-parse', 'HEAD');

      const hashes = await git.revList(`${a}..HEAD`);
      expect(hashes).toContain(b);
      expect(hashes).toContain(c);
      expect(hashes).not.toContain(merge);
    });

    it('returns an empty array for an empty range', async () => {
      expect(await git.revList('HEAD..HEAD')).toEqual([]);
    });
  });

  describe('show helpers', () => {
    it('showMetadata renders a pretty-format string', async () => {
      const hash = await commitFile('b.txt', 'B', 'Commit B');
      const out = await git.showMetadata(hash, '%s%x1f%an');
      expect(out.replace(/\n$/, '')).toBe('Commit B\x1fTest');
    });

    it('showPatch returns the patch body', async () => {
      const hash = await commitFile('b.txt', 'hello', 'Commit B');
      expect(await git.showPatch(hash)).toContain('b.txt');
    });

    it('showStat returns a diffstat', async () => {
      const hash = await commitFile('b.txt', 'hello', 'Commit B');
      expect(await git.showStat(hash)).toContain('b.txt');
    });

    it('showNameStatus returns name-status lines', async () => {
      const hash = await commitFile('b.txt', 'hello', 'Commit B');
      expect(await git.showNameStatus(hash)).toMatch(/A\s+b\.txt/);
    });
  });
});
