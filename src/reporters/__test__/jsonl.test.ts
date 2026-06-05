// @module-tag local

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlReporter } from 'loop-the-loop/reporters/jsonl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('JsonlReporter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jsonl-report-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create the report file on first append', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'test',
    });
    await report.append(
      { id: 'first.ts', prompt: 'Hello' },
      { status: 'success', output: 'World' },
    );

    const content = await readFile(join(tempDir, 'test-report.jsonl'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.id).toBe('first.ts');
    expect(entry.status).toBe('success');
    expect(entry.output).toBe('World');
  });

  it('should append multiple entries as separate JSON lines', async () => {
    const report = await JsonlReporter.create({
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

    const lines = (await readFile(join(tempDir, 'multi-report.jsonl'), 'utf-8'))
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as { id: string });

    expect(lines).toHaveLength(2);
    expect(lines[0].id).toBe('a.ts');
    expect(lines[1].id).toBe('b.ts');
  });

  it('should include output field for success entries', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'success',
    });
    await report.append(
      { id: 'ok.ts', prompt: 'Do stuff' },
      { status: 'success', output: 'Done' },
    );

    const entry = JSON.parse(
      (await readFile(join(tempDir, 'success-report.jsonl'), 'utf-8')).trim(),
    );
    expect(entry.output).toBe('Done');
    expect(entry.reason).toBeUndefined();
  });

  it('should include reason field for error entries', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'error',
    });
    await report.append(
      { id: 'bad.ts', prompt: 'Fix' },
      { status: 'error', reason: 'parse failure' },
    );

    const entry = JSON.parse(
      (await readFile(join(tempDir, 'error-report.jsonl'), 'utf-8')).trim(),
    );
    expect(entry.reason).toBe('parse failure');
    expect(entry.output).toBeUndefined();
  });

  it('should include reason field for glitch entries', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'glitch',
    });
    await report.append(
      { id: 'slow.ts', prompt: 'Analyze' },
      { status: 'glitch', reason: 'rate limit' },
    );

    const entry = JSON.parse(
      (await readFile(join(tempDir, 'glitch-report.jsonl'), 'utf-8')).trim(),
    );
    expect(entry.status).toBe('glitch');
    expect(entry.reason).toBe('rate limit');
  });

  it('should include structuredOutput when present on success', async () => {
    const report = await JsonlReporter.create({
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

    const entry = JSON.parse(
      (
        await readFile(join(tempDir, 'structured-report.jsonl'), 'utf-8')
      ).trim(),
    );
    expect(entry.structuredOutput).toEqual({
      found: true,
      files: { 'a.ts': 'bug' },
    });
  });

  it('should omit structuredOutput when not present on success', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'no-structured',
    });
    await report.append(
      { id: 'plain.ts', prompt: 'Review' },
      { status: 'success', output: 'all good' },
    );

    const entry = JSON.parse(
      (
        await readFile(join(tempDir, 'no-structured-report.jsonl'), 'utf-8')
      ).trim(),
    );
    expect(entry.structuredOutput).toBeUndefined();
  });

  it('should preserve multi-line strings in JSON', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'multiline',
    });
    await report.append(
      { id: 'multi.ts', prompt: 'Line one\nLine two' },
      { status: 'success', output: 'Result A\nResult B' },
    );

    const entry = JSON.parse(
      (await readFile(join(tempDir, 'multiline-report.jsonl'), 'utf-8')).trim(),
    );
    expect(entry.prompt).toBe('Line one\nLine two');
    expect(entry.output).toBe('Result A\nResult B');
  });

  it('should produce one valid JSON object per line', async () => {
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'valid',
    });

    for (let i = 0; i < 3; i++) {
      await report.append(
        { id: `file${i}.ts`, prompt: 'p' },
        { status: 'success', output: 'o' },
      );
    }

    const lines = (await readFile(join(tempDir, 'valid-report.jsonl'), 'utf-8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line) as Record<string, unknown>).not.toThrow();
    }
  });

  it('check() reports both probes ok when the report file is absent', async () => {
    const report = await JsonlReporter.create({
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
    const report = await JsonlReporter.create({
      outputDir: tempDir,
      jobName: 'check-exists',
    });
    const path = join(tempDir, 'check-exists-report.jsonl');
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
    const report = await JsonlReporter.create({
      outputDir,
      jobName: 'blocked',
    });
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
});
