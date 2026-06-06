// @module-tag local

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import { GitPromptGenerator } from 'loop-the-loop/prompt-generators/git';
import { Git } from 'loop-the-loop/util/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const committer = { name: 'Test', email: 'test@test.com' };

describe('GitPromptGenerator', () => {
  let repoPath: string;
  let git: Git;
  let firstHash: string;

  function rawGit(...args: Array<string>): string {
    return execFileSync('git', ['-C', repoPath, ...args])
      .toString()
      .trim();
  }

  async function commitFile(
    file: string,
    content: string,
    message: string,
  ): Promise<string> {
    await writeFile(join(repoPath, file), content);
    await git.add(file);
    await git.commit(message, { committer });
    return rawGit('rev-parse', 'HEAD');
  }

  async function collect(
    generator: GitPromptGenerator,
  ): Promise<Array<Prompt>> {
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'git-gen-'));
    git = new Git(repoPath);
    await git.init();
    rawGit('config', 'user.name', 'Test');
    rawGit('config', 'user.email', 'test@test.com');
    firstHash = await commitFile('a.txt', 'A', 'Commit A');
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('yields one prompt per non-merge commit, oldest-first', async () => {
    const b = await commitFile('b.txt', 'B', 'Commit B');
    const c = await commitFile('c.txt', 'C', 'Commit C');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts.map(p => p.id)).toEqual([b, c]);
    expect(prompts.map(p => p.prompt)).toEqual(['Commit B', 'Commit C']);
  });

  it('substitutes metadata and position placeholders', async () => {
    await commitFile('b.txt', 'B', 'Commit B');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        promptTemplate:
          '[{{index}}/{{commitCount}}] {{subject}} by {{authorName}} <{{authorEmail}}>',
      },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts[0].prompt).toBe('[1/1] Commit B by Test <test@test.com>');
  });

  it('preserves a commit body that contains the unit separator byte', async () => {
    await commitFile('b.txt', 'B', 'Subject line\n\nbefore\x1fafter');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        promptTemplate: '{{subject}}|{{body}}',
      },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts[0].prompt).toContain('Subject line|before\x1fafter');
  });

  it('includes diff, stat and files when the template references them', async () => {
    await commitFile('b.txt', 'hello', 'Commit B');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        promptTemplate: 'D:{{diff}} S:{{stat}} F:{{files}}',
      },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts[0].prompt).toContain('b.txt');
    expect(prompts[0].prompt).toContain('hello');
    expect(prompts[0].prompt).toMatch(/A\s+b\.txt/);
  });

  it('does not compute diff, stat or files when the template omits them', async () => {
    await commitFile('b.txt', 'B', 'Commit B');
    const patchSpy = vi.spyOn(Git.prototype, 'showPatch');
    const statSpy = vi.spyOn(Git.prototype, 'showStat');
    const filesSpy = vi.spyOn(Git.prototype, 'showNameStatus');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    await collect(generator);

    expect(patchSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(filesSpy).not.toHaveBeenCalled();
    patchSpy.mockRestore();
    statSpy.mockRestore();
    filesSpy.mockRestore();
  });

  it('computes diff, stat and files only when the template references them', async () => {
    await commitFile('b.txt', 'B', 'Commit B');
    const patchSpy = vi.spyOn(Git.prototype, 'showPatch');
    const statSpy = vi.spyOn(Git.prototype, 'showStat');
    const filesSpy = vi.spyOn(Git.prototype, 'showNameStatus');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        promptTemplate: '{{diff}} {{stat}} {{files}}',
      },
      repoPath,
    );
    await collect(generator);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(filesSpy).toHaveBeenCalledTimes(1);
    patchSpy.mockRestore();
    statSpy.mockRestore();
    filesSpy.mockRestore();
  });

  it('excludes merge commits', async () => {
    const b = await commitFile('b.txt', 'B', 'Commit B');
    const branches = rawGit('branch', '--format=%(refname:short)').split('\n');
    rawGit('checkout', '-b', 'feature', firstHash);
    const c = await commitFile('c.txt', 'C', 'Commit C');
    rawGit('checkout', branches[0]);
    rawGit('merge', '--no-ff', '-m', 'Merge feature', 'feature');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts.map(p => p.id).sort()).toEqual([b, c].sort());
    expect(prompts.map(p => p.prompt)).not.toContain('Merge feature');
  });

  it('skips commits already tracked in the loop state', async () => {
    const b = await commitFile('b.txt', 'B', 'Commit B');
    const c = await commitFile('c.txt', 'C', 'Commit C');

    const generator = new GitPromptGenerator(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const loopState = FileLoopState.fromPersisted('ignored.json', {
      version: 2,
      results: { [b]: { status: 'success' } },
      claims: {},
    });
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts.map(p => p.id)).toEqual([c]);
  });

  it('defaults repoPath to basePath and resolves it relatively', async () => {
    await commitFile('b.txt', 'B', 'Commit B');

    const generator = new GitPromptGenerator(
      {
        range: `${firstHash}..HEAD`,
        repoPath: '.',
        promptTemplate: '{{subject}}',
      },
      repoPath,
    );
    const prompts = await collect(generator);

    expect(prompts.map(p => p.prompt)).toEqual(['Commit B']);
  });

  describe('check', () => {
    it('reports ok with a commit count for a valid range', async () => {
      await commitFile('b.txt', 'B', 'Commit B');
      const generator = new GitPromptGenerator(
        { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
        repoPath,
      );
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      expect(results).toContainEqual(
        expect.objectContaining({ status: 'ok', message: '1 commit' }),
      );
    });

    it('warns when the range resolves to zero commits', async () => {
      const generator = new GitPromptGenerator(
        { range: 'HEAD..HEAD', promptTemplate: '{{subject}}' },
        repoPath,
      );
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      expect(results).toContainEqual(
        expect.objectContaining({ status: 'warn' }),
      );
    });

    it('fails when repoPath is not a git work tree', async () => {
      const nonRepo = await mkdtemp(join(tmpdir(), 'git-nonrepo-'));
      try {
        const generator = new GitPromptGenerator(
          { range: 'main..HEAD', promptTemplate: '{{subject}}' },
          nonRepo,
        );
        const results = [];
        for await (const result of generator.check()) {
          results.push(result);
        }
        expect(results).toContainEqual(
          expect.objectContaining({ status: 'fail' }),
        );
      } finally {
        await rm(nonRepo, { recursive: true, force: true });
      }
    });

    it('fails when the range is invalid', async () => {
      const generator = new GitPromptGenerator(
        { range: 'no-such-ref..HEAD', promptTemplate: '{{subject}}' },
        repoPath,
      );
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      expect(results).toContainEqual(
        expect.objectContaining({ status: 'fail' }),
      );
    });
  });

  it('static create() returns a working generator', async () => {
    await commitFile('b.txt', 'B', 'Commit B');
    const generator = await GitPromptGenerator.create(
      { range: `${firstHash}..HEAD`, promptTemplate: '{{subject}}' },
      repoPath,
    );
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    expect(prompts.map(p => p.prompt)).toEqual(['Commit B']);
  });

  it('defaults basePath to process.cwd() when omitted', async () => {
    // When no basePath is provided the constructor falls back to process.cwd().
    // We just verify it constructs without error and exposes a generate method.
    const generator = new GitPromptGenerator({
      range: `${firstHash}..${firstHash}`,
      promptTemplate: '{{subject}}',
    });
    expect(typeof generator.generate).toBe('function');
  });
});
