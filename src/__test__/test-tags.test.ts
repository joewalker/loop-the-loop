// @module-tag local

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const primaryTagPattern = /(?:\/\/|\*)\s*@module-tag\s+(local|live)\b/g;

/**
 * Recursively list TypeScript test files below a directory.
 */
async function listTestFiles(directory: string): Promise<Array<string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async entry => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return listTestFiles(path);
      }

      if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        return [path];
      }

      return [];
    }),
  );

  return files.flat().sort();
}

/**
 * Return the local/live module tags declared in a test file docblock.
 */
function readPrimaryTags(content: string): Array<string> {
  const tags: Array<string> = [];

  for (const match of content.matchAll(primaryTagPattern)) {
    const tag = match[1];

    if (tag !== undefined) {
      tags.push(tag);
    }
  }

  return tags;
}

describe('test module tags', () => {
  it('marks every test file as local or live', async () => {
    const root = join(import.meta.dirname, '..');
    const files = await listTestFiles(root);
    const unclassified: Array<string> = [];

    for (const file of files) {
      const tags = readPrimaryTags(await readFile(file, 'utf-8'));

      if (tags.length !== 1) {
        unclassified.push(relative(root, file));
      }
    }

    expect(unclassified).toStrictEqual([]);
  });
});
