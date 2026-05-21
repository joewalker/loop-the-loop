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
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true);
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

  it('uses a read-only sandbox by default', async () => {
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
    expect(getSpawnSandboxMode()).toBe('read-only');
  });

  it('uses a writable sandbox when source updates are allowed', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
      allowSourceUpdate: true,
    });

    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      status: 'success',
      output: 'final answer',
    });
    expect(getSpawnSandboxMode()).toBe('workspace-write');
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

  it('returns a glitch when codex exceeds the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);
      readFileMock.mockResolvedValue('');

      const agent = new CodexCLIAgent({ timeoutMs: 1_000 });
      const resultPromise = agent.invoke('do the thing', {
        logger: createLogger(false),
      });

      // Advance past the timeout. The agent should SIGTERM and then settle
      // when the child eventually closes.
      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate the child eventually exiting in response to SIGTERM.
      child.emit('close', null, 'SIGTERM');

      const result = await resultPromise;
      expect(result.status).toBe('glitch');
      if (result.status !== 'success') {
        expect(result.reason).toMatch(/timed out/i);
        expect(result.reason).toContain('1000');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles after timeout when the process exits but stdio stays open', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);
      readFileMock.mockResolvedValue('');

      const agent = new CodexCLIAgent({ timeoutMs: 1_000 });
      const resultPromise = agent.invoke('do the thing', {
        logger: createLogger(false),
      });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // If a descendant keeps stdout/stderr open, Node may emit `exit` for the
      // Codex process without ever emitting `close`.
      child.emit('exit', null, 'SIGTERM');

      const result = await resultPromise;
      expect(result.status).toBe('glitch');
      if (result.status !== 'success') {
        expect(result.reason).toMatch(/timed out/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates to SIGKILL when SIGTERM does not stop the child', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);
      readFileMock.mockResolvedValue('');

      const agent = new CodexCLIAgent({ timeoutMs: 1_000 });
      const resultPromise = agent.invoke('do the thing', {
        logger: createLogger(false),
      });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // The child ignores SIGTERM. After the kill grace period elapses we
      // should escalate to SIGKILL.
      await vi.advanceTimersByTimeAsync(5_001);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      child.emit('close', null, 'SIGKILL');
      const result = await resultPromise;
      expect(result.status).toBe('glitch');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout when the child exits normally', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);

      const agent = new CodexCLIAgent({ timeoutMs: 1_000 });
      const resultPromise = agent.invoke('do the thing', {
        logger: createLogger(false),
      });

      child.emit('close', 0, null);
      await expect(resultPromise).resolves.toStrictEqual({
        status: 'success',
        output: 'final answer',
      });

      // Advance past the would-have-been timeout. The child should not be
      // killed since the run already settled.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies failures as error when only the assistant body mentions tokens', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue(
      'Here is an explanation of OAuth tokens and bearer tokens.',
    );

    const resultPromise = new CodexCLIAgent().invoke(
      'Explain how OAuth tokens work.',
      {
        logger: createLogger(false),
      },
    );

    child.stderr.emit('data', 'unrelated authentication failure\n');
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'success') {
      expect(result.reason).toContain('OAuth tokens');
      expect(result.reason).toContain('unrelated authentication failure');
    }
  });

  it('classifies a rate-limited failure as a glitch from stderr alone', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stderr.emit('data', 'request failed: 429 Too Many Requests\n');
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('glitch');
  });

  it('classifies a context-window failure as a glitch when stderr reports it', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stderr.emit('data', 'prompt exceeds the model context window\n');
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('glitch');
  });

  it('classifies a token-limit failure as a glitch when stderr mentions token limits', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stderr.emit('data', 'request exceeded the token limit\n');
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('glitch');
  });

  it('does not classify stderr containing only the bare word "token" as a glitch', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    readFileMock.mockResolvedValue('');

    const resultPromise = new CodexCLIAgent().invoke('do the thing', {
      logger: createLogger(false),
    });

    child.stderr.emit(
      'data',
      'TypeError: failed to tokenize input at module foo\n',
    );
    child.emit('close', 1, null);

    const result = await resultPromise;
    expect(result.status).toBe('error');
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

function getSpawnSandboxMode(): string | undefined {
  const [, args] = spawnMock.mock.calls[0] as [string, Array<string>, unknown];
  const sandboxFlagIndex = args.indexOf('--sandbox');
  expect(sandboxFlagIndex).toBeGreaterThanOrEqual(0);
  return args[sandboxFlagIndex + 1];
}
