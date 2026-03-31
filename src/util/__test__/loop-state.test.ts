import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoopState } from 'loop-the-loop/util/loop-state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('LoopState', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loop-state-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should keep unrelated ids outstanding after recording an error', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('bug-123');
    await loopState.end('bug-123', { status: 'error', reason: 'bad item' });

    expect(loopState.isOutstanding('bug-123')).toBe(false);
    expect(loopState.isOutstanding('bug-456')).toBe(true);
  });

  it('should save failed state using ids', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('ticket-9');
    await loopState.end('ticket-9', {
      status: 'error',
      reason: 'failed validation',
    });

    const raw = await readFile(path, 'utf-8');

    expect(raw).toContain('"id": "ticket-9"');
    expect(raw).not.toContain('"file"');
  });

  it('should load saved failed ids', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify(
        {
          completed: [],
          failed: [{ id: 'ticket-42', reason: 'bad item' }],
          inProgress: undefined,
        },
        null,
        2,
      )}\n`,
    );

    const loopState = await LoopState.create(path);

    expect(loopState.isOutstanding('ticket-42')).toBe(false);
    expect(loopState.isOutstanding('ticket-99')).toBe(true);
  });

  it('should throw when the saved state is malformed', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(path, '{"completed": [');

    await expect(LoopState.create(path)).rejects.toThrow(SyntaxError);
  });

  it('should mark an id as no longer outstanding after a successful end', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('file-a.ts');
    await loopState.end('file-a.ts', { status: 'success', output: 'done' });

    expect(loopState.isOutstanding('file-a.ts')).toBe(false);
    expect(loopState.isOutstanding('file-b.ts')).toBe(true);
  });

  it('should write completed ids to the state file', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('ticket-1');
    await loopState.end('ticket-1', { status: 'success', output: 'done' });

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.completed).toContain('ticket-1');
    expect(data.inProgress).toBeUndefined();
  });

  it('should not add a glitch result to completed or failed', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('item-x');
    await loopState.end('item-x', { status: 'glitch', reason: 'timeout' });

    expect(loopState.isOutstanding('item-x')).toBe(true);

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.completed).toEqual([]);
    expect(data.failed).toEqual([]);
  });

  it('should write inProgress to the state file during begin', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('active-item');

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.inProgress).toBe('active-item');
  });

  it('should load completed ids from saved state', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify({ completed: ['already-done'], failed: [] }, null, 2)}\n`,
    );

    const loopState = await LoopState.create(path);
    expect(loopState.isOutstanding('already-done')).toBe(false);
    expect(loopState.isOutstanding('not-done')).toBe(true);
  });

  it('should create a state file in a nested directory', async () => {
    const path = join(tempDir, 'nested', 'deep', 'state.json');
    const loopState = await LoopState.create(path);

    await loopState.begin('item-1');
    await loopState.end('item-1', { status: 'success', output: 'ok' });

    const raw = await readFile(path, 'utf-8');
    expect(JSON.parse(raw).completed).toContain('item-1');
  });
});
