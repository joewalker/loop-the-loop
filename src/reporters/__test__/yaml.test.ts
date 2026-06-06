// @module-tag local

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { YamlReporter } from 'loop-the-loop/reporters/yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Minimal YAML literal block scalar reader. Locates `key: |` (optionally
 * followed by an indentation indicator, e.g. `|2`) inside `content` and
 * returns the decoded scalar value. Sufficient for the round-trip checks
 * in this test file; it intentionally does not try to be a full YAML
 * parser.
 */
function parseFirstBlockScalar(content: string, key: string): string {
  const lines = content.split('\n');
  let i = 0;
  let baseIndent: number | undefined;
  while (i < lines.length) {
    const header = lines[i].match(new RegExp(`^${key}: \\|(\\d*)\\s*$`));
    if (header !== null) {
      baseIndent = header[1] === '' ? undefined : Number(header[1]);
      i += 1;
      break;
    }
    i += 1;
  }
  if (i === lines.length) {
    throw new Error(`block scalar for ${key} not found`);
  }
  const body: Array<string> = [];
  // Auto-detect indent from the first non-empty line if not explicit.
  if (baseIndent === undefined) {
    for (let j = i; j < lines.length; j += 1) {
      const m = lines[j].match(/^( +)\S/);
      if (m !== null) {
        baseIndent = m[1].length;
        break;
      }
    }
  }
  const indent = baseIndent ?? 2;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '') {
      body.push('');
      i += 1;
      continue;
    }
    const leadMatch = line.match(/^( *)/);
    const lead = leadMatch === null ? 0 : leadMatch[1].length;
    if (lead < indent) {
      break;
    }
    body.push(line.slice(indent));
    i += 1;
  }
  // Drop the trailing empty separator line that always follows the block
  // in our serializer.
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
  }
  return `${body.join('\n')}\n`;
}

describe('Report', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'report-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create the report file on first append', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'test',
    });
    await report.append(
      { id: 'first.ts', prompt: 'Hello' },
      { status: 'success', output: 'World' },
    );

    const content = await readFile(join(tempDir, 'test-report.yaml'), 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('id: "first.ts"');
    expect(content).toContain('status: success');
  });

  it('should append multiple entries as separate YAML documents', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'multi',
    });

    await report.append(
      { id: 'a.ts', prompt: 'Review a' },
      { status: 'success', output: 'ok' },
    );
    await report.append(
      { id: 'b.ts', prompt: 'Review b' },
      { status: 'error', reason: 'failed' },
    );

    const content = await readFile(join(tempDir, 'multi-report.yaml'), 'utf-8');
    const docs = content.split('---').filter(s => s.trim().length > 0);
    expect(docs).toHaveLength(2);
    expect(content).toContain('id: "a.ts"');
    expect(content).toContain('id: "b.ts"');
  });

  it('should serialize output for success entries', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'success',
    });
    await report.append(
      { id: 'ok.ts', prompt: 'Do stuff' },
      { status: 'success', output: 'Done' },
    );

    const content = await readFile(
      join(tempDir, 'success-report.yaml'),
      'utf-8',
    );
    expect(content).toContain('output: |');
    expect(content).toContain('  Done');
    expect(content).not.toContain('reason:');
  });

  it('should serialize reason for error entries', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'error',
    });
    await report.append(
      { id: 'bad.ts', prompt: 'Fix' },
      { status: 'error', reason: 'parse failure' },
    );

    const content = await readFile(join(tempDir, 'error-report.yaml'), 'utf-8');
    expect(content).toContain('reason: |');
    expect(content).toContain('  parse failure');
    expect(content).not.toContain('output:');
  });

  it('should preserve blank lines in multi-paragraph reason text', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'multi-reason',
    });
    await report.append(
      { id: 'bad.ts', prompt: 'Fix' },
      { status: 'error', reason: 'first line\n\nsecond line' },
    );

    const content = await readFile(
      join(tempDir, 'multi-reason-report.yaml'),
      'utf-8',
    );
    expect(content).not.toMatch(/ +\n/);
    expect(content).toContain('  first line\n\n  second line');
  });

  it('should serialize reason for glitch entries', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'glitch',
    });
    await report.append(
      { id: 'slow.ts', prompt: 'Analyze' },
      { status: 'glitch', reason: 'rate limit' },
    );

    const content = await readFile(
      join(tempDir, 'glitch-report.yaml'),
      'utf-8',
    );
    expect(content).toContain('status: glitch');
    expect(content).toContain('reason: |');
    expect(content).toContain('  rate limit');
  });

  it('should handle multi-line prompts and outputs', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'multiline',
    });
    await report.append(
      { id: 'multi.ts', prompt: 'Line one\nLine two\nLine three' },
      { status: 'success', output: 'Result A\nResult B' },
    );

    const content = await readFile(
      join(tempDir, 'multiline-report.yaml'),
      'utf-8',
    );
    // expect(content).toContain('prompt: |');
    // expect(content).toContain('  Line one\n  Line two\n  Line three');
    expect(content).toContain('output: |');
    expect(content).toContain('  Result A\n  Result B');
  });

  it('should trim trailing whitespace from lines', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'trim',
    });
    await report.append(
      { id: 'trim.ts', prompt: 'has trailing   \nspaces   ' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(join(tempDir, 'trim-report.yaml'), 'utf-8');
    expect(content).not.toMatch(/ +\n/);
  });

  it('should not produce trailing whitespace on blank lines in block scalars', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'blank-lines',
    });
    await report.append(
      { id: 'blank.ts', prompt: 'para one\n\npara two' },
      { status: 'success', output: 'result one\n\nresult two' },
    );

    const content = await readFile(
      join(tempDir, 'blank-lines-report.yaml'),
      'utf-8',
    );
    expect(content).not.toMatch(/ +\n/);
    // expect(content).toContain('  para one\n\n  para two');
    expect(content).toContain('  result one\n\n  result two');
  });

  it('should include structuredOutput when present on success', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'structured',
    });
    await report.append(
      { id: 'structured.ts', prompt: 'Analyze' },
      {
        status: 'success',
        output: 'text output',
        structuredOutput: { found: true, files: { 'a.ts': 'bug' } },
      },
    );

    const content = await readFile(
      join(tempDir, 'structured-report.yaml'),
      'utf-8',
    );
    expect(content).toContain('structuredOutput: |');
    expect(content).toContain('"found": true');
    expect(content).toContain('"a.ts": "bug"');
  });

  it('should omit structuredOutput when not present on success', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'no-structured',
    });
    await report.append(
      { id: 'plain.ts', prompt: 'Review' },
      { status: 'success', output: 'all good' },
    );

    const content = await readFile(
      join(tempDir, 'no-structured-report.yaml'),
      'utf-8',
    );
    expect(content).not.toContain('structuredOutput');
  });

  it('should preserve leading whitespace and dedented continuation lines on output', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'leading-ws-output',
    });
    const original = '  function foo() {\n    return 1;\n  }\ntop';
    await report.append(
      { id: 'a', prompt: 'p' },
      { status: 'success', output: original },
    );

    const content = await readFile(
      join(tempDir, 'leading-ws-output-report.yaml'),
      'utf-8',
    );
    // The block scalar must use an explicit indentation indicator so the
    // parser anchors content indent at 2 regardless of the first non-empty
    // line. Without this, the leading two-space indent on `function foo()`
    // would be eaten and the dedented `top` line would terminate the scalar.
    expect(content).toContain('output: |2');
    expect(parseFirstBlockScalar(content, 'output')).toBe(`${original}\n`);
  });

  it('should preserve leading whitespace and dedented continuation lines on reason', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'leading-ws-reason',
    });
    const original = '  indented start\n    deeper\n  back\nflush';
    await report.append(
      { id: 'a', prompt: 'p' },
      { status: 'error', reason: original },
    );

    const content = await readFile(
      join(tempDir, 'leading-ws-reason-report.yaml'),
      'utf-8',
    );
    expect(content).toContain('reason: |2');
    expect(parseFirstBlockScalar(content, 'reason')).toBe(`${original}\n`);
  });

  it('should preserve leading whitespace on structuredOutput JSON when present', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'leading-ws-structured',
    });
    await report.append(
      { id: 'a', prompt: 'p' },
      {
        status: 'success',
        output: 'ok',
        structuredOutput: { nested: { key: 'value' } },
      },
    );

    const content = await readFile(
      join(tempDir, 'leading-ws-structured-report.yaml'),
      'utf-8',
    );
    // Pretty-printed JSON always starts with `{` at column 0, so leading
    // whitespace is not a concern here today; still, use |2 so the
    // serializer behaves uniformly.
    expect(content).toContain('structuredOutput: |2');
  });

  it('should quote the id field for YAML safety', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'special-id',
    });
    await report.append(
      { id: 'file: with #special chars', prompt: 'Test' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(
      join(tempDir, 'special-id-report.yaml'),
      'utf-8',
    );
    expect(content).toContain('id: "file: with #special chars"');
  });

  /**
   * Extract the raw text on the right-hand side of the first `id:` line in
   * `content` and decode it as a JSON-encoded string. JSON's escape rules
   * for `"`, `\`, and control characters are a subset of YAML's
   * flow-style double-quoted scalar escape rules, so a value serialized
   * via `JSON.stringify` round-trips losslessly through `JSON.parse`.
   */
  function parseIdField(content: string): string {
    const lines = content.split('\n');
    for (const line of lines) {
      const m = line.match(/^id: (.*)$/);
      if (m !== null) {
        return JSON.parse(m[1]) as string;
      }
    }
    throw new Error('id field not found');
  }

  it('should escape double quotes in the id field', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'quote-id',
    });
    const id = 'has"a"quote';
    await report.append(
      { id, prompt: 'Test' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(
      join(tempDir, 'quote-id-report.yaml'),
      'utf-8',
    );
    expect(parseIdField(content)).toBe(id);
  });

  it('should escape backslashes in the id field', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'backslash-id',
    });
    const id = 'path\\name';
    await report.append(
      { id, prompt: 'Test' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(
      join(tempDir, 'backslash-id-report.yaml'),
      'utf-8',
    );
    expect(parseIdField(content)).toBe(id);
  });

  it('should escape embedded newlines in the id field', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'newline-id',
    });
    const id = 'first\nsecond';
    await report.append(
      { id, prompt: 'Test' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(
      join(tempDir, 'newline-id-report.yaml'),
      'utf-8',
    );
    // The serialized id must occupy exactly one physical line - an
    // unescaped newline would split the id value across two YAML lines
    // and corrupt the document structure.
    const idLines = content.split('\n').filter(line => line.startsWith('id:'));
    expect(idLines).toHaveLength(1);
    expect(parseIdField(content)).toBe(id);
  });

  it('check() reports both probes ok when the report file is absent', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'check-fresh',
    });
    const results = [];
    for await (const r of report.check()) {
      results.push(r);
    }
    expect(results.map(r => [r.name, r.status])).toEqual([
      ['output directory writable', 'ok'],
      ['report file appendable', 'ok'],
    ]);
    expect(
      results.find(r => r.name === 'report file appendable')?.message,
    ).toBe('will be created on first append');
  });

  it('check() reports the file appendable when it already exists', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'check-exists',
    });
    const path = join(tempDir, 'check-exists-report.yaml');
    await writeFile(path, '');
    const results = [];
    for await (const r of report.check()) {
      results.push(r);
    }
    expect(results.map(r => [r.name, r.status])).toEqual([
      ['output directory writable', 'ok'],
      ['report file appendable', 'ok'],
    ]);
    expect(
      results.find(r => r.name === 'report file appendable')?.message,
    ).toBe(path);
  });

  it('check() fails when the output directory cannot be created', async () => {
    const outputDir = join(tempDir, 'reportdir');
    const report = await YamlReporter.create({ outputDir, jobName: 'blocked' });
    // Replace the output directory with a regular file so the check()'s
    // mkdir(dir, { recursive: true }) rejects.
    await rm(outputDir, { recursive: true, force: true });
    await writeFile(outputDir, 'now a file');
    const results = [];
    for await (const r of report.check()) {
      results.push(r);
    }
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('output directory writable');
    expect(results[0].status).toBe('fail');
    expect(results[0].cause).toBeDefined();
  });

  it('emits a cost block for an estimated cost', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'cost-estimated',
    });
    await report.append(
      { id: 'a', prompt: 'p' },
      {
        status: 'success',
        output: 'done',
        cost: {
          usd: 0.01234,
          costSource: 'estimated',
          model: 'gpt-5-mini',
          inputTokens: 1200,
          outputTokens: 380,
        },
      },
    );
    const text = await readFile(
      join(tempDir, 'cost-estimated-report.yaml'),
      'utf-8',
    );
    expect(text).toContain('cost:\n');
    expect(text).toContain('  costSource: "estimated"\n');
    expect(text).toContain('  usd: 0.01234\n');
    expect(text).toContain('  model: "gpt-5-mini"\n');
    expect(text).toContain('  inputTokens: 1200\n');
    expect(text).toContain('  outputTokens: 380\n');
  });

  it('omits the cost block when cost is absent', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'cost-absent',
    });
    await report.append(
      { id: 'a', prompt: 'p' },
      { status: 'success', output: 'x' },
    );
    const text = await readFile(
      join(tempDir, 'cost-absent-report.yaml'),
      'utf-8',
    );
    expect(text).not.toContain('cost:');
  });

  it('emits costSource unavailable with tokens and zero usd', async () => {
    const report = await YamlReporter.create({
      outputDir: tempDir,
      jobName: 'cost-unavailable',
    });
    await report.append(
      { id: 'a', prompt: 'p' },
      {
        status: 'error',
        reason: 'boom',
        cost: { usd: 0, costSource: 'unavailable', inputTokens: 5 },
      },
    );
    const text = await readFile(
      join(tempDir, 'cost-unavailable-report.yaml'),
      'utf-8',
    );
    expect(text).toContain('  costSource: "unavailable"\n');
    expect(text).toContain('  usd: 0\n');
    expect(text).toContain('  inputTokens: 5\n');
  });
});
