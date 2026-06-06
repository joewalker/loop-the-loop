// @module-tag local

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  JsonlPromptGenerator,
  normalizeJsonlTaskConfig,
  type JsonlTask,
} from 'loop-the-loop/prompt-generators/jsonl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('JsonlPromptGenerator', () => {
  let dir: string;
  const loopState = new FileLoopState('ignore.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeLines(
    name: string,
    lines: ReadonlyArray<unknown>,
  ): Promise<string> {
    const body = lines.map(l => JSON.stringify(l)).join('\n');
    await writeFile(join(dir, name), `${body}\n`);
    return name;
  }

  async function collect(
    task: JsonlTask,
    state: FileLoopState = loopState,
  ): Promise<Array<Prompt>> {
    const generator = await JsonlPromptGenerator.create(task, dir);
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(state)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  it('yields one prompt per line with id and index variables', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success', output: 'one' },
      { id: 'b', status: 'success', output: 'two' },
    ]);
    const prompts = await collect({
      dataFile,
      promptTemplate: '{{index}}:{{id}} {{output}}',
    });
    expect(prompts).toEqual([
      { id: 'a', prompt: '0:a one' },
      { id: 'b', prompt: '1:b two' },
    ]);
  });

  it('stringifies object-valued fields so they can be templated', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      promptTemplate: '{{id}} {{structuredOutput}}',
    });
    expect(prompts[0].prompt).toBe('a {"verdict":"rework"}');
  });

  it('uses a custom idField, falling back to the index when absent', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { key: 'k1', status: 'success' },
      { status: 'success' },
    ]);
    const prompts = await collect({
      dataFile,
      idField: 'key',
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['k1', '1']);
  });

  it('filters on a top-level field by equality', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success' },
      { id: 'b', status: 'error' },
      { id: 'c', status: 'success' },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { status: 'success' },
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a', 'c']);
  });

  it('filters on a structuredOutput field-path', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', structuredOutput: { verdict: 'rework' } },
      { id: 'b', structuredOutput: { verdict: 'approve' } },
      { id: 'c', structuredOutput: {} },
      { id: 'd' },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a']);
  });

  it('re-emits matching items at the next attempt id', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'bug-1', structuredOutput: { verdict: 'rework' } },
      { id: 'bug-2#3', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      maxAttempts: 4,
      incrementAttempt: true,
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['bug-1#2', 'bug-2#4']);
  });

  it('suppresses items at or above the attempt cap', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'bug-1#3', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      maxAttempts: 3,
      incrementAttempt: true,
      promptTemplate: '{{id}}',
    });
    expect(prompts).toEqual([]);
  });

  it('pulls only items at or above minAttempts for a giveup arm', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'bug-1', structuredOutput: { verdict: 'rework' } },
      { id: 'bug-2#3', structuredOutput: { verdict: 'rework' } },
    ]);
    const prompts = await collect({
      dataFile,
      filter: { 'structuredOutput.verdict': 'rework' },
      minAttempts: 3,
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['bug-2#3']);
  });

  it('treats a missing data file as empty input', async () => {
    const prompts = await collect({
      dataFile: 'absent.jsonl',
      promptTemplate: '{{id}}',
    });
    expect(prompts).toEqual([]);
  });

  it('skips blank lines including a trailing newline', async () => {
    await writeFile(
      join(dir, 'r.jsonl'),
      `${JSON.stringify({ id: 'a', status: 'success' })}\n\n`,
    );
    const prompts = await collect({
      dataFile: 'r.jsonl',
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a']);
  });

  it('throws with the line number on a malformed line', async () => {
    await writeFile(
      join(dir, 'r.jsonl'),
      `${JSON.stringify({ id: 'a' })}\nnot json\n`,
    );
    await expect(
      collect({ dataFile: 'r.jsonl', promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/malformed JSON on line 2/u);
  });

  it('throws when a line is valid JSON but not an object', async () => {
    await writeFile(join(dir, 'r.jsonl'), '42\n');
    await expect(
      collect({ dataFile: 'r.jsonl', promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/line 1 .* is not a JSON object/u);
  });

  it('throws a format-mismatch error for a yaml report', async () => {
    await writeFile(join(dir, 'r.yaml'), '- id: a\n');
    await expect(
      collect({ dataFile: 'r.yaml', promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/looks like a YAML report/u);
  });

  it('throws on a duplicate id', async () => {
    const dataFile = await writeLines('r.jsonl', [{ id: 'a' }, { id: 'a' }]);
    await expect(
      collect({ dataFile, promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/duplicate id "a" at line 2/u);
  });

  it('defaults basePath to the current working directory', async () => {
    const generator = await JsonlPromptGenerator.create({
      dataFile: 'no-such-file-in-cwd.jsonl',
      promptTemplate: '{{id}}',
    });
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    expect(prompts).toEqual([]);
  });

  it('rethrows a non-ENOENT read error', async () => {
    await expect(
      collect({ dataFile: '.', promptTemplate: '{{id}}' }),
    ).rejects.toThrow();
  });

  it('reads multiple data files in sequence', async () => {
    const a = await writeLines('a.jsonl', [{ id: 'a', status: 'success' }]);
    const b = await writeLines('b.jsonl', [{ id: 'b', status: 'success' }]);
    const prompts = await collect({
      dataFile: [a, b],
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('treats a missing file in the array as empty input', async () => {
    const a = await writeLines('a.jsonl', [{ id: 'a', status: 'success' }]);
    const prompts = await collect({
      dataFile: [a, 'absent.jsonl'],
      promptTemplate: '{{id}}',
    });
    expect(prompts.map(p => p.id)).toEqual(['a']);
  });

  it('detects a duplicate id across files', async () => {
    const a = await writeLines('a.jsonl', [{ id: 'dup' }]);
    const b = await writeLines('b.jsonl', [{ id: 'dup' }]);
    await expect(
      collect({ dataFile: [a, b], promptTemplate: '{{id}}' }),
    ).rejects.toThrow(/duplicate id "dup"/u);
  });

  it('continues index numbering across files', async () => {
    const a = await writeLines('a.jsonl', [{ status: 'success' }]);
    const b = await writeLines('b.jsonl', [{ status: 'success' }]);
    const prompts = await collect({
      dataFile: [a, b],
      promptTemplate: '{{index}}',
    });
    expect(prompts.map(p => p.prompt)).toEqual(['0', '1']);
  });

  it('skips ids that are no longer outstanding in the consuming loop', async () => {
    const dataFile = await writeLines('r.jsonl', [
      { id: 'a', status: 'success' },
      { id: 'b', status: 'success' },
    ]);
    const consuming = new FileLoopState(join(dir, 'consuming-state.json'));
    await consuming.complete('r', 'a', { status: 'success', output: '' });
    const prompts = await collect(
      { dataFile, promptTemplate: '{{id}}' },
      consuming,
    );
    expect(prompts.map(p => p.id)).toEqual(['b']);
  });
});

describe('normalizeJsonlTaskConfig', () => {
  it('accepts a full config', () => {
    const task = normalizeJsonlTaskConfig({
      dataFile: 'r.jsonl',
      promptTemplate: '{{id}}',
      idField: 'id',
      filter: { status: 'success', 'structuredOutput.verdict': 'rework' },
      maxAttempts: 3,
      minAttempts: 1,
      incrementAttempt: true,
    });
    expect(task.maxAttempts).toBe(3);
  });

  it('rejects a non-object', () => {
    expect(() => normalizeJsonlTaskConfig(7)).toThrow(
      'jsonl task config must be an object',
    );
  });

  it('rejects an unknown property', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        nope: 1,
      }),
    ).toThrow('jsonl.nope is not supported');
  });

  it('rejects a missing dataFile', () => {
    expect(() =>
      normalizeJsonlTaskConfig({ promptTemplate: '{{id}}' }),
    ).toThrow('jsonl.dataFile must be a string');
  });

  it('rejects a non-object filter', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        filter: 'x',
      }),
    ).toThrow('jsonl.filter must be an object of scalar values');
  });

  it('rejects a filter with a non-scalar value', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        filter: { k: { nested: true } },
      }),
    ).toThrow('jsonl.filter must be an object of scalar values');
  });

  it('rejects a non-integer maxAttempts', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        maxAttempts: 1.5,
      }),
    ).toThrow('jsonl.maxAttempts must be a positive integer');
  });

  it('accepts a minimal config without attempt knobs', () => {
    expect(
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
      }),
    ).toEqual({ dataFile: 'r.jsonl', promptTemplate: '{{id}}' });
  });

  it('accepts an array dataFile', () => {
    const task = normalizeJsonlTaskConfig({
      dataFile: ['a.jsonl', 'b.jsonl'],
      promptTemplate: '{{id}}',
    });
    expect(task.dataFile).toEqual(['a.jsonl', 'b.jsonl']);
  });

  it('rejects a dataFile array containing a non-string', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: ['a.jsonl', 7],
        promptTemplate: '{{id}}',
      }),
    ).toThrow('jsonl.dataFile must be a string or an array of strings');
  });

  it('rejects a non-string non-array dataFile', () => {
    expect(() =>
      normalizeJsonlTaskConfig({ dataFile: 7, promptTemplate: '{{id}}' }),
    ).toThrow('jsonl.dataFile must be a string or an array of strings');
  });

  it('rejects a non-boolean incrementAttempt', () => {
    expect(() =>
      normalizeJsonlTaskConfig({
        dataFile: 'r.jsonl',
        promptTemplate: '{{id}}',
        incrementAttempt: 'yes',
      }),
    ).toThrow('jsonl.incrementAttempt must be a boolean');
  });
});
