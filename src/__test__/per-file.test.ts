import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPrompt,
  type PerFileAgenticTask,
  PerFilePromptGenerator,
  resolveFiles,
} from 'agentic-loop/prompt-generators/per-file';
import type { Prompt } from 'agentic-loop/prompt-generators/prompt-generators';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LoopState } from '../loop-state.js';

describe('buildPrompt', () => {
  it('should substitute {{file}} in the template', async () => {
    const task: PerFileAgenticTask = {
      filePattern: '**/*.ts',
      promptTemplate: 'Review the file {{file}} for issues.',
    };
    const result = await buildPrompt(task, 'src/foo.ts');
    expect(result).toBe('Review the file src/foo.ts for issues.');
  });

  it('should substitute multiple occurrences of {{file}}', async () => {
    const task: PerFileAgenticTask = {
      filePattern: '**/*.ts',
      promptTemplate: 'Check {{file}}. The file {{file}} needs review.',
    };
    const result = await buildPrompt(task, 'bar.ts');
    expect(result).toBe('Check bar.ts. The file bar.ts needs review.');
  });

  it('should append context files when present', async () => {
    const task: PerFileAgenticTask = {
      filePattern: '**/*.ts',
      promptTemplate: 'Review {{file}}.',
      contextFiles: ['GUIDELINES.md', 'RULES.md'],
    };
    const result = await buildPrompt(task, 'src/app.ts');
    expect(result).toContain('Review src/app.ts.');
    expect(result).toContain('Additional context files:');
    expect(result).toContain('- GUIDELINES.md');
    expect(result).toContain('- RULES.md');
  });

  it('should not append context section when contextFiles is empty', async () => {
    const task: PerFileAgenticTask = {
      filePattern: '**/*.ts',
      promptTemplate: 'Review {{file}}.',
      contextFiles: [],
    };
    const result = await buildPrompt(task, 'src/app.ts');
    expect(result).toBe('Review src/app.ts.');
  });

  it('should resolve {{include:...}} macros relative to basePath', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'per-file-basepath-'));
    try {
      await writeFile(join(tempDir, 'context.md'), 'injected content');
      const task: PerFileAgenticTask = {
        filePattern: '**/*.ts',
        promptTemplate: 'Review {{file}}.\n{{include:context.md}}',
        basePath: tempDir,
      };
      const result = await buildPrompt(task, 'src/app.ts');
      expect(result).toBe('Review src/app.ts.\ninjected content');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
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
    stateFiles.push(join('cache/agentic-loops', `state.json`));
    const task: PerFileAgenticTask = {
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
    stateFiles.push(join('cache/agentic-loops', `state.json`));
    const task: PerFileAgenticTask = {
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
