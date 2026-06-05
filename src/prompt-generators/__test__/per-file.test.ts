// @module-tag local

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  type PerFileTask,
  PerFilePromptGenerator,
  resolveFiles,
} from 'loop-the-loop/prompt-generators/per-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGlob } = vi.hoisted(() => ({ mockGlob: vi.fn() }));

vi.mock('glob', async importActual => {
  const actual = await importActual<typeof import('glob')>();
  // Delegate to the real glob by default so resolveFiles tests keep working;
  // individual tests can override mockGlob to exercise the failure branch.
  mockGlob.mockImplementation(actual.glob);
  return { ...actual, glob: mockGlob };
});

describe('resolveFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'resolve-files-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, '__test__'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'a.ts'), '');
    await writeFile(join(tempDir, 'src', 'b.ts'), '');
    await writeFile(join(tempDir, '__test__', 'c.test.ts'), '');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should resolve files matching a glob pattern', async () => {
    const files = await resolveFiles(join(tempDir, '**/*.ts'));
    expect(files).toHaveLength(3);
  });

  it('should return files in sorted order', async () => {
    const files = await resolveFiles(join(tempDir, 'src/*.ts'));
    const filenames = files.map(f => f.split('/').pop());
    expect(filenames).toStrictEqual(['a.ts', 'b.ts']);
  });

  it('should exclude files matching exclude patterns', async () => {
    const files = await resolveFiles(join(tempDir, '**/*.ts'), [
      '**/__test__/**',
    ]);
    expect(files).toHaveLength(2);
    expect(files.every(f => !f.includes('__test__'))).toBe(true);
  });

  it('should return an empty array when no files match', async () => {
    const files = await resolveFiles(join(tempDir, '**/*.xyz'));
    expect(files).toStrictEqual([]);
  });
});

describe('PerFilePromptGenerator', () => {
  let tempDir: string;
  const stateFiles: Array<string> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'per-file-gen-'));
    await writeFile(join(tempDir, 'file1.ts'), '');
    await writeFile(join(tempDir, 'file2.ts'), '');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    // Clean up state files written by the generator
    for (const f of stateFiles) {
      await rm(f, { force: true });
    }
    stateFiles.length = 0;
  });

  it('should yield prompts for each matching file', async () => {
    stateFiles.push(join('cache/loop-the-loops', `state.json`));
    const task: PerFileTask = {
      filePattern: join(tempDir, '*.ts'),
      promptTemplate: 'Review {{file}}',
    };
    const generator = new PerFilePromptGenerator(task);
    const prompts: Array<Prompt> = [];
    const loopState = new FileLoopState('loop-state-ignore.json');

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toContain('file1.ts');
    expect(prompts[1].id).toContain('file2.ts');
  });

  it('should yield no prompts when no files match', async () => {
    const loopState = new FileLoopState('loop-state-ignore.json');
    stateFiles.push(join('cache/loop-the-loops', `state.json`));
    const task: PerFileTask = {
      filePattern: join(tempDir, '*.xyz'),
      promptTemplate: 'Review {{file}}',
    };
    const generator = new PerFilePromptGenerator(task);
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toStrictEqual([]);
  });

  it('should skip files that are already tracked in the loop state', async () => {
    const file1 = join(tempDir, 'file1.ts');
    const loopState = FileLoopState.fromPersisted('loop-state-ignore.json', {
      version: 2,
      results: { [file1]: { status: 'success' } },
      claims: {},
    });

    const task: PerFileTask = {
      filePattern: join(tempDir, '*.ts'),
      promptTemplate: 'Review {{file}}',
    };
    const generator = new PerFilePromptGenerator(task);
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toContain('file2.ts');
  });
});

describe('PerFilePromptGenerator.check', () => {
  const drain = async (
    generator: PerFilePromptGenerator,
  ): Promise<
    Array<{
      name: string;
      status: string;
      message?: string;
      cause?: unknown;
    }>
  > => {
    const results = [];
    for await (const result of generator.check()) {
      results.push(result);
    }
    return results;
  };

  it('yields ok with a match count when files match', async () => {
    const generator = new PerFilePromptGenerator(
      { filePattern: 'src/**/*.ts', promptTemplate: 'x' },
      process.cwd(),
    );

    const results = await drain(generator);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toMatch(/^\d+ files$/u);
  });

  it('honours excludePatterns when counting matches', async () => {
    const generator = new PerFilePromptGenerator(
      {
        filePattern: 'src/**/*.ts',
        excludePatterns: ['**/*'],
        promptTemplate: 'x',
      },
      process.cwd(),
    );

    const results = await drain(generator);

    expect(results[0].status).toBe('warn');
  });

  it('yields warn when the glob matches nothing', async () => {
    const generator = new PerFilePromptGenerator(
      { filePattern: 'no/such/**/*.zzz', promptTemplate: 'x' },
      process.cwd(),
    );

    const results = await drain(generator);

    expect(results[0].status).toBe('warn');
    expect(results[0].message).toBe('glob matched 0 files');
  });

  it('yields fail with the cause when glob throws', async () => {
    const generator = new PerFilePromptGenerator(
      { filePattern: 'src/**/*.ts', promptTemplate: 'x' },
      process.cwd(),
    );
    const boom = new Error('bad glob');
    mockGlob.mockRejectedValueOnce(boom);

    const results = await drain(generator);

    expect(results[0].status).toBe('fail');
    expect(results[0].message).toBe('bad glob');
    expect(results[0].cause).toBe(boom);
  });
});
