import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expandIncludes } from 'agentic-loop/prompt-generators/expand-includes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('expandIncludes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'expand-includes-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns text unchanged when no include macros are present', async () => {
    const result = await expandIncludes('Hello, world!', tempDir);
    expect(result).toBe('Hello, world!');
  });

  it('replaces a single include macro with the file contents', async () => {
    await writeFile(join(tempDir, 'intro.md'), 'This is the intro.');
    const result = await expandIncludes(`{{include:intro.md}}`, tempDir);
    expect(result).toBe('This is the intro.');
  });

  it('replaces an include macro embedded in surrounding text', async () => {
    await writeFile(join(tempDir, 'section.md'), 'Middle content.');
    const result = await expandIncludes(
      `Before.\n{{include:section.md}}\nAfter.`,
      tempDir,
    );
    expect(result).toBe('Before.\nMiddle content.\nAfter.');
  });

  it('replaces multiple include macros in a single pass', async () => {
    await writeFile(join(tempDir, 'a.md'), 'AAA');
    await writeFile(join(tempDir, 'b.md'), 'BBB');
    const result = await expandIncludes(
      `{{include:a.md}} and {{include:b.md}}`,
      tempDir,
    );
    expect(result).toBe('AAA and BBB');
  });

  it('resolves relative paths against basePath', async () => {
    await mkdir(join(tempDir, 'sub'));
    await writeFile(join(tempDir, 'sub', 'nested.md'), 'Nested content.');
    const result = await expandIncludes(`{{include:sub/nested.md}}`, tempDir);
    expect(result).toBe('Nested content.');
  });

  it('recursively expands includes within included files', async () => {
    await writeFile(join(tempDir, 'inner.md'), 'inner content');
    await writeFile(join(tempDir, 'outer.md'), `outer: {{include:inner.md}}`);
    const result = await expandIncludes(`{{include:outer.md}}`, tempDir);
    expect(result).toBe('outer: inner content');
  });

  it('resolves includes in included files relative to the included file location', async () => {
    await mkdir(join(tempDir, 'docs'));
    await writeFile(join(tempDir, 'docs', 'detail.md'), 'detail text');
    await writeFile(
      join(tempDir, 'docs', 'overview.md'),
      `See: {{include:detail.md}}`,
    );
    // overview.md includes detail.md which is relative to docs/, not tempDir
    const result = await expandIncludes(
      `{{include:docs/overview.md}}`,
      tempDir,
    );
    expect(result).toBe('See: detail text');
  });

  it('handles content with dollar signs without misinterpreting them', async () => {
    await writeFile(join(tempDir, 'cost.md'), 'Price is $100 and $200.');
    const result = await expandIncludes(`Cost: {{include:cost.md}}`, tempDir);
    expect(result).toBe('Cost: Price is $100 and $200.');
  });

  it('throws an error when the included file does not exist', async () => {
    await expect(
      expandIncludes(`{{include:missing.md}}`, tempDir),
    ).rejects.toThrow();
  });

  it('throws an error on circular includes', async () => {
    await writeFile(join(tempDir, 'a.md'), `{{include:b.md}}`);
    await writeFile(join(tempDir, 'b.md'), `{{include:a.md}}`);
    await expect(expandIncludes(`{{include:a.md}}`, tempDir)).rejects.toThrow(
      /circular/i,
    );
  });
});
