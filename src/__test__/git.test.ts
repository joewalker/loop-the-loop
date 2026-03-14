import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git } from 'agentic-loop/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
