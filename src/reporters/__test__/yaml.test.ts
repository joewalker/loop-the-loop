import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { YamlReporter } from 'agentic-loop/reporters/yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Report', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'report-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create the report file on first append', async () => {
    const report = await YamlReporter.create(join(tempDir, 'test-report'));
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
    const report = await YamlReporter.create(join(tempDir, 'multi-report'));

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

  it('should create parent directories if needed', async () => {
    const report = await YamlReporter.create(join(tempDir, 'deep', 'nested', 'task-report'));

    await report.append(
      { id: 'nested.ts', prompt: 'Test' },
      { status: 'success', output: 'Works' },
    );

    const content = await readFile(join(tempDir, 'deep', 'nested', 'task-report.yaml'), 'utf-8');
    expect(content).toContain('id: "nested.ts"');
  });

  it('should serialize output for success entries', async () => {
    const report = await YamlReporter.create(join(tempDir, 'success-report'));
    await report.append(
      { id: 'ok.ts', prompt: 'Do stuff' },
      { status: 'success', output: 'Done' },
    );

    const content = await readFile(join(tempDir, 'success-report.yaml'), 'utf-8');
    expect(content).toContain('output: |');
    expect(content).toContain('  Done');
    expect(content).not.toContain('reason:');
  });

  it('should serialize reason for error entries', async () => {
    const report = await YamlReporter.create(join(tempDir, 'error-report'));
    await report.append(
      { id: 'bad.ts', prompt: 'Fix' },
      { status: 'error', reason: 'parse failure' },
    );

    const content = await readFile(join(tempDir, 'error-report.yaml'), 'utf-8');
    expect(content).toContain('reason: |');
    expect(content).toContain('  parse failure');
    expect(content).not.toContain('output:');
  });

  it('should serialize reason for glitch entries', async () => {
    const report = await YamlReporter.create(join(tempDir, 'glitch-report'));
    await report.append(
      { id: 'slow.ts', prompt: 'Analyze' },
      { status: 'glitch', reason: 'rate limit' },
    );

    const content = await readFile(join(tempDir, 'glitch-report.yaml'), 'utf-8');
    expect(content).toContain('status: glitch');
    expect(content).toContain('reason: |');
    expect(content).toContain('  rate limit');
  });

  it('should handle multi-line prompts and outputs', async () => {
    const report = await YamlReporter.create(join(tempDir, 'multiline-report'));
    await report.append(
      { id: 'multi.ts', prompt: 'Line one\nLine two\nLine three' },
      { status: 'success', output: 'Result A\nResult B' },
    );

    const content = await readFile(join(tempDir, 'multiline-report.yaml'), 'utf-8');
    expect(content).toContain('prompt: |');
    expect(content).toContain('  Line one\n  Line two\n  Line three');
    expect(content).toContain('output: |');
    expect(content).toContain('  Result A\n  Result B');
  });

  it('should trim trailing whitespace from lines', async () => {
    const report = await YamlReporter.create(join(tempDir, 'trim-report'));
    await report.append(
      { id: 'trim.ts', prompt: 'has trailing   \nspaces   ' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(join(tempDir, 'trim-report.yaml'), 'utf-8');
    expect(content).not.toMatch(/ +\n/);
  });

  it('should not produce trailing whitespace on blank lines in block scalars', async () => {
    const report = await YamlReporter.create(join(tempDir, 'blank-lines-report'));
    await report.append(
      { id: 'blank.ts', prompt: 'para one\n\npara two' },
      { status: 'success', output: 'result one\n\nresult two' },
    );

    const content = await readFile(join(tempDir, 'blank-lines-report.yaml'), 'utf-8');
    expect(content).not.toMatch(/ +\n/);
    expect(content).toContain('  para one\n\n  para two');
    expect(content).toContain('  result one\n\n  result two');
  });

  it('should quote the id field for YAML safety', async () => {
    const report = await YamlReporter.create(join(tempDir, 'special-id-report'));
    await report.append(
      { id: 'file: with #special chars', prompt: 'Test' },
      { status: 'success', output: 'ok' },
    );

    const content = await readFile(join(tempDir, 'special-id-report.yaml'), 'utf-8');
    expect(content).toContain('id: "file: with #special chars"');
  });
});
