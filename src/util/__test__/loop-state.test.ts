import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoopState } from 'agentic-loop/util/loop-state';
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
});
