// @module-tag local

import { EventEmitter } from 'node:events';

import { CodexCLIAgent } from 'loop-the-loop/agents/codex-cli';
import type { Logger } from 'loop-the-loop/loggers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  rm: rmMock,
}));

class FakeStream extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
}

describe('CodexCLIAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockResolvedValue('final answer\n');
    rmMock.mockResolvedValue(undefined);
  });

  it('runs codex exec with JSON event output enabled', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      status: 'success',
      output: 'final answer',
    });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--json', 'do the thing']),
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('logs Codex JSON events when verbose logging is enabled', async () => {
    const child = new FakeChildProcess();
    const logger = createLogger(true);
    spawnMock.mockReturnValue(child);

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger,
    });

    child.stdout.emit('data', '{"type":"agent_message","message":"hello');
    child.stdout.emit(
      'data',
      ' world"}\n{"type":"tool_call","name":"Read","input":{"file":"a.ts"}}\n',
    );
    child.stderr.emit('data', 'status line\n');
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      status: 'success',
      output: 'final answer',
    });
    expect(logger.agent).toHaveBeenCalledWith('[agent_message] hello world');
    expect(logger.tool).toHaveBeenCalledWith(
      '[tool_call] Read({"file":"a.ts"})',
    );
    expect(logger.system).toHaveBeenCalledWith('[stderr] status line');
  });

  it('returns stderr and exit code when codex exits unsuccessfully', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stderr.emit('data', 'badness\n');
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'success') {
      expect(result.reason).toContain('badness');
      expect(result.reason).toContain('exit code: 1');
    }
  });

  it('does not include JSON event stdout in unsuccessful invocation errors', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stdout.emit(
      'data',
      '{"type":"agent_message","message":"verbose event"}\n',
    );
    child.stderr.emit('data', 'badness\n');
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'success') {
      expect(result.reason).toContain('badness');
      expect(result.reason).toContain('exit code: 1');
      expect(result.reason).not.toContain('agent_message');
      expect(result.reason).not.toContain('verbose event');
    }
  });

  it('caps captured process output while counting total bytes', async () => {
    const child = new FakeChildProcess();
    const maxCapturedOutputBytes = 10 * 1024 * 1024;
    const overflowingStdout = 'x'.repeat(maxCapturedOutputBytes + 512);
    const overflowingStderr = 'y'.repeat(maxCapturedOutputBytes + 128);
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stdout.emit('data', overflowingStdout);
    child.stderr.emit('data', overflowingStderr);
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'success') {
      expect(result.reason.length).toBeLessThan(maxCapturedOutputBytes + 2_000);
      expect(result.reason).toContain(
        `captured stdout/stderr truncated: stdout kept ${maxCapturedOutputBytes} of ${Buffer.byteLength(overflowingStdout, 'utf8')} bytes, stderr kept ${maxCapturedOutputBytes} of ${Buffer.byteLength(overflowingStderr, 'utf8')} bytes (limit ${maxCapturedOutputBytes} per stream)`,
      );
      expect(result.reason).toContain('exit code: 1');
    }
  });
});

function createLogger(enabled: boolean): Logger {
  return {
    enabled,
    agent: vi.fn(),
    tool: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    system: vi.fn(),
    state: vi.fn(),
    info: vi.fn(),
  };
}
