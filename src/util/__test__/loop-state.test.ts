// @module-tag local

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLoopState } from 'loop-the-loop/util/loop-state';
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
    const loopState = await FileLoopState.create(path);

    expect(await loopState.claim('run-1', 'bug-123')).toBe(true);
    await loopState.complete('run-1', 'bug-123', {
      status: 'error',
      reason: 'bad item',
    });

    expect(loopState.isOutstanding('bug-123')).toBe(false);
    expect(loopState.isOutstanding('bug-456')).toBe(true);
  });

  it('should save error results using ids', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'ticket-9');
    await loopState.complete('run-1', 'ticket-9', {
      status: 'error',
      reason: 'failed validation',
    });

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);

    expect(data.results['ticket-9']).toEqual({
      status: 'error',
      reason: 'failed validation',
    });
    expect(raw).not.toContain('"file"');
  });

  it('should migrate old failed ids', async () => {
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

    const loopState = await FileLoopState.create(path);

    expect(loopState.isOutstanding('ticket-42')).toBe(false);
    expect(loopState.isOutstanding('ticket-99')).toBe(true);
    expect(await loopState.getSnapshot()).toEqual({
      version: 2,
      results: {
        'ticket-42': { status: 'error', reason: 'bad item' },
      },
      claims: {},
      totalUsd: 0,
    });
  });

  it('should throw when the saved state is malformed', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(path, '{"completed": [');

    await expect(FileLoopState.create(path)).rejects.toThrow(SyntaxError);
  });

  it('should mark an id as no longer outstanding after a successful end', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'file-a.ts');
    await loopState.complete('run-1', 'file-a.ts', {
      status: 'success',
      output: 'done',
    });

    expect(loopState.isOutstanding('file-a.ts')).toBe(false);
    expect(loopState.isOutstanding('file-b.ts')).toBe(true);
  });

  it('should write successful results to the state file', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'ticket-1');
    await loopState.complete('run-1', 'ticket-1', {
      status: 'success',
      output: 'done',
    });

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data).toEqual({
      version: 2,
      results: {
        'ticket-1': { status: 'success' },
      },
      claims: {},
      totalUsd: 0,
    });
  });

  it('should not add a glitch result to terminal results', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'item-x');
    await loopState.complete('run-1', 'item-x', {
      status: 'glitch',
      reason: 'timeout',
    });

    expect(loopState.isOutstanding('item-x')).toBe(true);

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.results).toEqual({});
    expect(data.claims).toEqual({});
  });

  it('should write claims to the state file during claim', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'active-item');

    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.claims['active-item']).toMatchObject({ runId: 'run-1' });
    expect(typeof data.claims['active-item'].claimedAt).toBe('string');
  });

  it('should default results and claims to empty when missing from saved state', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(path, `${JSON.stringify({}, null, 2)}\n`);

    const loopState = await FileLoopState.create(path);

    expect(loopState.isOutstanding('anything')).toBe(true);
  });

  it('should load completed ids from saved state', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify({ completed: ['already-done'], failed: [] }, null, 2)}\n`,
    );

    const loopState = await FileLoopState.create(path);
    expect(loopState.isOutstanding('already-done')).toBe(false);
    expect(loopState.isOutstanding('not-done')).toBe(true);
    expect(await loopState.getSnapshot()).toEqual({
      version: 2,
      results: {
        'already-done': { status: 'success' },
      },
      claims: {},
      totalUsd: 0,
    });
  });

  it('should create a state file in a nested directory', async () => {
    const path = join(tempDir, 'nested', 'deep', 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'item-1');
    await loopState.complete('run-1', 'item-1', {
      status: 'success',
      output: 'ok',
    });

    const raw = await readFile(path, 'utf-8');
    expect(JSON.parse(raw).results['item-1']).toEqual({ status: 'success' });
  });

  it('should reject a claim already owned by another run', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    expect(await loopState.claim('run-1', 'item-1')).toBe(true);
    expect(await loopState.claim('run-1', 'item-1')).toBe(true);
    expect(await loopState.claim('run-2', 'item-1')).toBe(false);
  });

  it('should release all claims for a run', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'item-1');
    await loopState.claim('run-1', 'item-2');
    await loopState.claim('run-2', 'item-3');
    await loopState.release('run-1');

    expect(await loopState.getSnapshot()).toMatchObject({
      claims: {
        'item-3': { runId: 'run-2' },
      },
    });
  });

  it('should accumulate usable costs from all result statuses', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'item-1');
    await loopState.complete('run-1', 'item-1', {
      status: 'glitch',
      reason: 'retry',
      cost: { usd: 0.25, costSource: 'estimated' },
    });
    await loopState.claim('run-1', 'item-1');
    await loopState.complete('run-1', 'item-1', {
      status: 'success',
      output: 'done',
      cost: { usd: 0.5, costSource: 'provider' },
    });

    expect(loopState.totalUsd).toBe(0.75);
    expect(await loopState.getSnapshot()).toMatchObject({
      totalUsd: 0.75,
      results: {
        'item-1': {
          status: 'success',
          cost: { usd: 0.5, costSource: 'provider' },
        },
      },
    });
  });

  it('should ignore unavailable, negative, and non-finite costs in totals', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.complete('run-1', 'a', {
      status: 'glitch',
      reason: 'a',
      cost: { usd: 10, costSource: 'unavailable' },
    });
    await loopState.complete('run-1', 'b', {
      status: 'glitch',
      reason: 'b',
      cost: { usd: -1, costSource: 'estimated' },
    });
    await loopState.complete('run-1', 'c', {
      status: 'glitch',
      reason: 'c',
      cost: { usd: Number.NaN, costSource: 'estimated' },
    });

    expect(loopState.totalUsd).toBe(0);
  });

  it('should expose completed and failed ids through the getters', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.complete('run-1', 'ok-item', {
      status: 'success',
      output: 'done',
    });
    await loopState.complete('run-1', 'bad-item', {
      status: 'error',
      reason: 'boom',
    });

    expect(loopState.completed).toEqual(['ok-item']);
    expect(loopState.failed).toEqual([{ id: 'bad-item', reason: 'boom' }]);
  });

  it('should default a failed reason to an empty string in the getter', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 2,
          results: { 'no-reason': { status: 'error' } },
          claims: {},
          totalUsd: 0,
        },
        null,
        2,
      )}\n`,
    );

    const loopState = await FileLoopState.create(path);

    expect(loopState.failed).toEqual([{ id: 'no-reason', reason: '' }]);
  });

  it('should reject a claim for an id that already has a result', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.complete('run-1', 'done-item', {
      status: 'success',
      output: 'done',
    });

    expect(await loopState.claim('run-2', 'done-item')).toBe(false);
  });

  it('should ignore a complete from a run that does not own the claim', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.claim('run-1', 'owned-item');
    await loopState.complete('run-2', 'owned-item', {
      status: 'success',
      output: 'sneaky',
    });

    expect(loopState.isOutstanding('owned-item')).toBe(true);
  });

  it('should keep the cost on an error result', async () => {
    const path = join(tempDir, 'state.json');
    const loopState = await FileLoopState.create(path);

    await loopState.complete('run-1', 'err-item', {
      status: 'error',
      reason: 'broke',
      cost: { usd: 0.4, costSource: 'provider' },
    });

    expect(loopState.totalUsd).toBe(0.4);
    expect(await loopState.getSnapshot()).toMatchObject({
      results: {
        'err-item': {
          status: 'error',
          reason: 'broke',
          cost: { usd: 0.4, costSource: 'provider' },
        },
      },
    });
  });

  it('should restore claims and totalUsd from saved state', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 2,
          results: {},
          claims: { 'live-item': { runId: 'run-9', claimedAt: '2020-01-01' } },
          totalUsd: 1.25,
        },
        null,
        2,
      )}\n`,
    );

    const loopState = await FileLoopState.create(path);

    expect(loopState.totalUsd).toBe(1.25);
    expect(await loopState.getSnapshot()).toMatchObject({
      claims: { 'live-item': { runId: 'run-9', claimedAt: '2020-01-01' } },
      totalUsd: 1.25,
    });
  });

  it('should swallow a failed write in the save chain', async () => {
    // Pointing the state path at a directory makes writeFile reject, which
    // exercises the chain's error-swallowing catch.
    const dirPath = join(tempDir, 'state-as-dir');
    await mkdir(dirPath);
    const loopState = new FileLoopState(dirPath);

    await expect(loopState.save()).rejects.toThrow();

    // A subsequent save still rejects rather than hanging on a poisoned chain.
    await expect(loopState.save()).rejects.toThrow();
  });

  it('should drop old in-progress values on load', async () => {
    const path = join(tempDir, 'state.json');
    await writeFile(
      path,
      `${JSON.stringify(
        {
          completed: [],
          failed: [],
          inProgress: ['old-a', 'old-b'],
        },
        null,
        2,
      )}\n`,
    );

    const loopState = await FileLoopState.create(path);

    expect(await loopState.getSnapshot()).toEqual({
      version: 2,
      results: {},
      claims: {},
      totalUsd: 0,
    });
  });
});
