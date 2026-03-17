import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlReporter } from 'agentic-loop/reporters/jsonl';
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
    const report = await JsonlReporter.create(join(tempDir, 'test-report'));
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
    const report = await JsonlReporter.create(join(tempDir, 'multi-report'));

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

  it('should create parent directories if needed', async () => {
    const report = await JsonlReporter.create(join(tempDir, 'deep', 'nested', 'task-report'));

    await report.append(
      { id: 'nested.ts', prompt: 'Test' },
      { status: 'success', output: 'Works' },
    );

    const content = await readFile(join(tempDir, 'deep', 'nested', 'task-report.jsonl'), 'utf-8');
    expect(JSON.parse(content.trim()).id).toBe('nested.ts');
  });

  it('should include output field for success entries', async () => {
    const report = await JsonlReporter.create(join(tempDir, 'success-report'));
    await report.append(
      { id: 'ok.ts', prompt: 'Do stuff' },
      { status: 'success', output: 'Done' },
    );

    const entry = JSON.parse((await readFile(join(tempDir, 'success-report.jsonl'), 'utf-8')).trim());
    expect(entry.output).toBe('Done');
    expect(entry.reason).toBeUndefined();
  });

  it('should include reason field for error entries', async () => {
    const report = await JsonlReporter.create(join(tempDir, 'error-report'));
    await report.append(
      { id: 'bad.ts', prompt: 'Fix' },
      { status: 'error', reason: 'parse failure' },
    );

    const entry = JSON.parse((await readFile(join(tempDir, 'error-report.jsonl'), 'utf-8')).trim());
    expect(entry.reason).toBe('parse failure');
    expect(entry.output).toBeUndefined();
  });

  it('should include reason field for glitch entries', async () => {
    const report = await JsonlReporter.create(join(tempDir, 'glitch-report'));
    await report.append(
      { id: 'slow.ts', prompt: 'Analyze' },
      { status: 'glitch', reason: 'rate limit' },
    );

    const entry = JSON.parse((await readFile(join(tempDir, 'glitch-report.jsonl'), 'utf-8')).trim());
    expect(entry.status).toBe('glitch');
    expect(entry.reason).toBe('rate limit');
  });

  it('should preserve multi-line strings in JSON', async () => {
    const report = await JsonlReporter.create(join(tempDir, 'multiline-report'));
    await report.append(
      { id: 'multi.ts', prompt: 'Line one\nLine two' },
      { status: 'success', output: 'Result A\nResult B' },
    );

    const entry = JSON.parse((await readFile(join(tempDir, 'multiline-report.jsonl'), 'utf-8')).trim());
    expect(entry.prompt).toBe('Line one\nLine two');
    expect(entry.output).toBe('Result A\nResult B');
  });

  it('should produce one valid JSON object per line', async () => {
    const report = await JsonlReporter.create(join(tempDir, 'valid-report'));

    for (let i = 0; i < 3; i++) {
      await report.append(
        { id: `file${i}.ts`, prompt: 'p' },
        { status: 'success', output: 'o' },
      );
    }

    const lines = (await readFile(join(tempDir, 'valid-report.jsonl'), 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line) as Record<string, unknown>).not.toThrow();
    }
  });
});
