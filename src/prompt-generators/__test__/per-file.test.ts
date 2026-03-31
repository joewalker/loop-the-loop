import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  type PerFileTask,
  PerFilePromptGenerator,
  resolveFiles,
} from 'loop-the-loop/prompt-generators/per-file';
import { LoopState } from 'loop-the-loop/util/loop-state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    const loopState = new LoopState('loop-state-ignore.json');

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toContain('file1.ts');
    expect(prompts[1].id).toContain('file2.ts');
  });

  it('should yield no prompts when no files match', async () => {
    const loopState = new LoopState('loop-state-ignore.json');
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
});
