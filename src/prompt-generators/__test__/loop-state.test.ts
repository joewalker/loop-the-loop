// @module-tag local

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  LoopStatePromptGenerator,
  normalizeLoopStateTaskConfig,
  type LoopStateTask,
} from 'loop-the-loop/prompt-generators/loop-state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SNAPSHOT = {
  version: 2,
  results: {
    a: { status: 'success' },
    b: { status: 'error', reason: 'broke' },
    c: { status: 'success' },
  },
  claims: { d: { runId: 'r', claimedAt: 'now' } },
  totalUsd: 0,
};

describe('LoopStatePromptGenerator', () => {
  let dir: string;
  const loopState = new FileLoopState('ignore.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-state-reader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function collect(task: LoopStateTask): Promise<Array<Prompt>> {
    const generator = await LoopStatePromptGenerator.create(task, dir);
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  async function writeState(name: string, value: unknown): Promise<string> {
    await writeFile(join(dir, name), `${JSON.stringify(value)}\n`);
    return name;
  }

  it('yields only successes by default and ignores claims', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const prompts = await collect({
      stateFile,
      promptTemplate: 'Continue {{id}} ({{status}})',
    });
    expect(prompts).toEqual([
      { id: 'a', prompt: 'Continue a (success)' },
      { id: 'c', prompt: 'Continue c (success)' },
    ]);
  });

  it('selects errors and exposes the reason', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const prompts = await collect({
      stateFile,
      select: 'error',
      promptTemplate: 'Retry {{id}}: {{reason}}',
    });
    expect(prompts).toEqual([{ id: 'b', prompt: 'Retry b: broke' }]);
  });

  it('selects all outcomes', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const prompts = await collect({
      stateFile,
      select: 'all',
      promptTemplate: '{{id}}={{status}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing state file as empty input', async () => {
    const prompts = await collect({
      stateFile: 'does-not-exist.json',
      promptTemplate: '{{id}}',
    });
    expect(prompts).toEqual([]);
  });

  it('skips ids that are no longer outstanding in the consuming loop', async () => {
    const stateFile = await writeState('s.json', SNAPSHOT);
    const consuming = new FileLoopState(join(dir, 'consuming-state.json'));
    await consuming.complete('r', 'a', { status: 'success', output: '' });
    const generator = await LoopStatePromptGenerator.create(
      { stateFile, promptTemplate: '{{id}}' },
      dir,
    );
    const ids: Array<string> = [];
    for await (const prompt of generator.generate(consuming)) {
      ids.push(prompt.id);
    }
    expect(ids).toEqual(['c']);
  });

  it('throws a clear error for a present but non-v2 file', async () => {
    const stateFile = await writeState('old.json', { version: 1 });
    await expect(
      collect({ stateFile, promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/expected a \{ version: 2/u);
  });

  it('throws for a malformed (non-JSON) file', async () => {
    await writeFile(join(dir, 'bad.json'), 'not json');
    await expect(
      collect({ stateFile: 'bad.json', promptTemplate: '{{id}}' }),
    ).rejects.toThrow();
  });

  it('rethrows a non-ENOENT read error', async () => {
    await mkdir(join(dir, 'a-directory'));
    await expect(
      collect({ stateFile: 'a-directory', promptTemplate: '{{id}}' }),
    ).rejects.toThrow();
  });

  it('defaults the basePath to the current working directory', async () => {
    const generator = await LoopStatePromptGenerator.create({
      stateFile: 'does-not-exist-in-cwd.json',
      promptTemplate: '{{id}}',
    });
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    expect(prompts).toEqual([]);
  });
});

describe('normalizeLoopStateTaskConfig', () => {
  it('accepts a minimal config', () => {
    expect(
      normalizeLoopStateTaskConfig({
        stateFile: 's.json',
        promptTemplate: '{{id}}',
      }),
    ).toEqual({ stateFile: 's.json', promptTemplate: '{{id}}' });
  });

  it('rejects a non-object', () => {
    expect(() => normalizeLoopStateTaskConfig('x')).toThrow(
      'loop-state task config must be an object',
    );
  });

  it('rejects an unknown property', () => {
    expect(() =>
      normalizeLoopStateTaskConfig({
        stateFile: 's.json',
        promptTemplate: '{{id}}',
        nope: 1,
      }),
    ).toThrow('loop-state.nope is not supported');
  });

  it('rejects a missing stateFile', () => {
    expect(() =>
      normalizeLoopStateTaskConfig({ promptTemplate: '{{id}}' }),
    ).toThrow('loop-state.stateFile must be a string');
  });

  it('rejects an invalid select', () => {
    expect(() =>
      normalizeLoopStateTaskConfig({
        stateFile: 's.json',
        promptTemplate: '{{id}}',
        select: 'maybe',
      }),
    ).toThrow('loop-state.select must be one of success, error, all');
  });
});
