// @module-tag local

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import {
  JsonPromptGenerator,
  navigatePath,
  toEntries,
  type JsonTask,
} from 'loop-the-loop/prompt-generators/json';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('navigatePath', () => {
  it('should return a nested value by dot-notation path', () => {
    const data = { response: { items: [1, 2, 3] } };
    expect(navigatePath(data, 'response.items')).toStrictEqual([1, 2, 3]);
  });

  it('should return a top-level value for a single-segment path', () => {
    const data = { bugs: ['a', 'b'] };
    expect(navigatePath(data, 'bugs')).toStrictEqual(['a', 'b']);
  });

  it('should throw when an intermediate value is not a plain object', () => {
    const data = { items: [1, 2, 3] };
    expect(() => navigatePath(data, 'items.length')).toThrow(
      'intermediate value at "length" is not a plain object',
    );
  });
});

describe('toEntries', () => {
  it('should convert an array to index-keyed entries', () => {
    expect(toEntries(['a', 'b', 'c'])).toStrictEqual([
      ['0', 'a'],
      ['1', 'b'],
      ['2', 'c'],
    ]);
  });

  it('should convert a plain object to key-value entries', () => {
    expect(toEntries({ x: 1, y: 2 })).toStrictEqual([
      ['x', 1],
      ['y', 2],
    ]);
  });

  it('should throw for non-array, non-object values', () => {
    expect(() => toEntries('hello')).toThrow(
      'target value must be an array or plain object',
    );
    expect(() => toEntries(42)).toThrow(
      'target value must be an array or plain object',
    );
  });
});

describe('JsonPromptGenerator', () => {
  const loopState = new FileLoopState('loop-state-ignore.json');

  async function collect(
    task: JsonTask,
    basePath?: string,
  ): Promise<Array<Prompt>> {
    const generator = await JsonPromptGenerator.create(task, basePath);
    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }
    return prompts;
  }

  it('should yield one prompt per array element with index as default id', async () => {
    const prompts = await collect({
      data: ['apple', 'banana'],
      promptTemplate: 'Process {{value}} (item {{index}})',
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toStrictEqual({
      id: '0',
      prompt: 'Process apple (item 0)',
    });
    expect(prompts[1]).toStrictEqual({
      id: '1',
      prompt: 'Process banana (item 1)',
    });
  });

  it('should yield one prompt per object element with key as default id', async () => {
    const prompts = await collect({
      data: { foo: 'hello', bar: 'world' },
      promptTemplate: 'Key {{id}}: {{value}}',
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toStrictEqual({ id: 'foo', prompt: 'Key foo: hello' });
    expect(prompts[1]).toStrictEqual({ id: 'bar', prompt: 'Key bar: world' });
  });

  it('should use idField to resolve id from object elements', async () => {
    const prompts = await collect({
      data: [
        { id: 42, name: 'Alpha' },
        { id: 99, name: 'Beta' },
      ],
      idField: 'id',
      promptTemplate: 'Bug {{id}}: {{name}}',
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toStrictEqual({ id: '42', prompt: 'Bug 42: Alpha' });
    expect(prompts[1]).toStrictEqual({ id: '99', prompt: 'Bug 99: Beta' });
  });

  it('should fall back to index when idField is missing from an element', async () => {
    const prompts = await collect({
      data: [{ name: 'no-id' }],
      idField: 'id',
      promptTemplate: '{{index}}',
    });

    expect(prompts[0].id).toBe('0');
  });

  it('should navigate to the target array using path', async () => {
    const prompts = await collect({
      data: { results: { bugs: [{ id: '1', title: 'Crash' }] } },
      path: 'results.bugs',
      idField: 'id',
      promptTemplate: '{{title}}',
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStrictEqual({ id: '1', prompt: 'Crash' });
  });

  it('should expose all top-level object fields as template variables', async () => {
    const prompts = await collect({
      data: [{ a: 'x', b: 'y', c: 'z' }],
      promptTemplate: '{{a}}/{{b}}/{{c}}',
    });

    expect(prompts[0].prompt).toBe('x/y/z');
  });

  it('should skip elements already tracked in loopState', async () => {
    const stateWithOne = FileLoopState.fromPersisted('loop-state-ignore.json', {
      version: 2,
      results: { '0': { status: 'success' } },
      claims: {},
    });
    const generator = await JsonPromptGenerator.create({
      data: ['first', 'second'],
      promptTemplate: '{{value}}',
    });

    const prompts: Array<Prompt> = [];
    for await (const prompt of generator.generate(stateWithOne)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe('1');
  });

  describe('duplicate id detection', () => {
    it('should throw when two elements share the same idField value', async () => {
      await expect(
        collect({
          data: [
            { id: 'ABC', title: 'first' },
            { id: 'ABC', title: 'second' },
          ],
          idField: 'id',
          promptTemplate: '{{title}}',
        }),
      ).rejects.toThrow(
        'JsonTask: duplicate id "ABC" at index 1 (already used at index 0)',
      );
    });

    it('should throw when an idField value collides with an index fallback', async () => {
      await expect(
        collect({
          data: [{ id: '1', title: 'first' }, { title: 'no id' }],
          idField: 'id',
          promptTemplate: '{{title}}',
        }),
      ).rejects.toThrow(
        'JsonTask: duplicate id "1" at index 1 (already used at index 0)',
      );
    });

    it('should throw when a numeric idField collides with a later index fallback for a non-object element', async () => {
      await expect(
        collect({
          data: [{ id: 1, title: 'first' }, 'no idField applies'],
          idField: 'id',
          promptTemplate: '{{title}}',
        }),
      ).rejects.toThrow(
        'JsonTask: duplicate id "1" at index 1 (already used at index 0)',
      );
    });
  });

  it('should throw when both data and dataFile are specified', async () => {
    await expect(
      collect({ data: [], dataFile: 'some.json', promptTemplate: '' }),
    ).rejects.toThrow('specify either "data" or "dataFile", not both');
  });

  it('should throw when neither data nor dataFile is specified', async () => {
    await expect(collect({ promptTemplate: '' })).rejects.toThrow(
      'either "data" or "dataFile" must be specified',
    );
  });

  describe('dataFile', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'json-iterator-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should read and iterate JSON data from a file', async () => {
      const filePath = join(tempDir, 'items.json');
      await writeFile(filePath, JSON.stringify([{ id: 'a' }, { id: 'b' }]));

      const prompts = await collect(
        {
          dataFile: 'items.json',
          idField: 'id',
          promptTemplate: 'item {{id}}',
        },
        tempDir,
      );

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toStrictEqual({ id: 'a', prompt: 'item a' });
      expect(prompts[1]).toStrictEqual({ id: 'b', prompt: 'item b' });
    });
  });

  describe('check()', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'json-check-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    const drain = async (
      generator: JsonPromptGenerator,
    ): Promise<Array<{ name: string; status: string; message?: string }>> => {
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      return results;
    };

    it('reports ok for inline data', async () => {
      const generator = new JsonPromptGenerator(
        { data: [{ id: 'a' }], promptTemplate: '{{id}}' },
        tempDir,
      );

      const results = await drain(generator);

      expect(results).toStrictEqual([
        { name: 'data source', status: 'ok', message: 'inline data' },
      ]);
    });

    it('reports ok for a readable, parseable dataFile', async () => {
      const filePath = join(tempDir, 'data.json');
      await writeFile(filePath, JSON.stringify([{ id: 'a' }]), 'utf-8');
      const generator = new JsonPromptGenerator(
        { dataFile: 'data.json', promptTemplate: '{{id}}' },
        tempDir,
      );

      const results = await drain(generator);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('ok');
      expect(results[0].message).toBe(filePath);
    });

    it('fails when the dataFile is missing', async () => {
      const generator = new JsonPromptGenerator(
        { dataFile: 'missing.json', promptTemplate: '{{id}}' },
        tempDir,
      );

      const results = await drain(generator);

      expect(results[0].status).toBe('fail');
      expect(results[0].name).toBe('data file readable');
    });

    it('fails when the dataFile is not valid JSON', async () => {
      await writeFile(join(tempDir, 'bad.json'), 'not json', 'utf-8');
      const generator = new JsonPromptGenerator(
        { dataFile: 'bad.json', promptTemplate: '{{id}}' },
        tempDir,
      );

      const results = await drain(generator);

      expect(results[0].status).toBe('fail');
    });
  });
});
