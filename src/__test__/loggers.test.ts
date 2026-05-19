// @module-tag local

import { styleText } from 'node:util';

import { createLogger, VerboseLogger } from 'loop-the-loop/loggers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('VerboseLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStderrIsTTY = process.stderr.isTTY;
  const COLOR_ENV_VARS = [
    'NO_COLOR',
    'NODE_DISABLE_COLORS',
    'FORCE_COLOR',
  ] as const;
  const originalColorEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const name of COLOR_ENV_VARS) {
      originalColorEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdout.isTTY = originalStdoutIsTTY;
    process.stderr.isTTY = originalStderrIsTTY;
    for (const name of COLOR_ENV_VARS) {
      const value = originalColorEnv[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('should log colored messages to stderr when enabled', () => {
    const log = new VerboseLogger(true);
    log.agent('hello from agent');

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(
      styleText('cyan', '[agent] hello from agent', {
        stream: process.stderr,
      }),
    );
  });

  it('should not log when disabled', () => {
    const log = new VerboseLogger(false);
    log.agent('should not appear');

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('should use different colors for different categories', () => {
    const log = new VerboseLogger(true);

    log.tool('tool msg');
    log.success('ok msg');
    log.error('err msg');
    log.system('sys msg');
    log.state('state msg');
    log.info('info msg');

    expect(stderrSpy).toHaveBeenCalledTimes(6);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      1,
      styleText('yellow', '[tool] tool msg', { stream: process.stderr }),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      2,
      styleText('green', '[success] ok msg', { stream: process.stderr }),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      3,
      styleText('red', '[error] err msg', { stream: process.stderr }),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      4,
      styleText('magenta', '[system] sys msg', { stream: process.stderr }),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      5,
      styleText('blue', '[state] state msg', { stream: process.stderr }),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      6,
      styleText('gray', '[info] info msg', { stream: process.stderr }),
    );
  });

  it('should expose enabled state', () => {
    expect(new VerboseLogger(true).enabled).toBe(true);
    expect(new VerboseLogger(false).enabled).toBe(false);
  });

  it('should validate stderr TTY (not stdout) for color emission', () => {
    // Simulate `command > out.log`: stdout redirected, stderr still a TTY.
    // styleText with default options validates stdout, so it would strip
    // color even though the user is looking at a TTY stderr. By validating
    // stderr we keep ANSI codes here.
    process.stdout.isTTY = false;
    process.stderr.isTTY = true;

    const log = new VerboseLogger(true);
    log.agent('hello');

    const lastCall = stderrSpy.mock.calls.at(-1)?.[0];
    expect(lastCall).toContain('\u001b[');
    expect(lastCall).toBe(
      styleText('cyan', '[agent] hello', { stream: process.stderr }),
    );
  });

  it('should strip color when stderr is not a TTY even if stdout is', () => {
    // Simulate `command 2> err.log`: stderr redirected, stdout still a TTY.
    // styleText with default options validates stdout, so it would keep
    // ANSI escape codes that end up as garbage in err.log. By validating
    // stderr we strip color here.
    process.stdout.isTTY = true;
    process.stderr.isTTY = false;

    const log = new VerboseLogger(true);
    log.error('boom');

    const lastCall = stderrSpy.mock.calls.at(-1)?.[0];
    expect(lastCall).not.toContain('\u001b[');
    expect(lastCall).toBe('[error] boom');
  });
});

describe('createLogger', () => {
  it('should return an enabled VerboseLogger for "verbose"', () => {
    const log = createLogger('verbose');
    expect(log).toBeInstanceOf(VerboseLogger);
    expect(log.enabled).toBe(true);
  });

  it('should return a disabled VerboseLogger for undefined', () => {
    const log = createLogger(undefined);
    expect(log).toBeInstanceOf(VerboseLogger);
    expect(log.enabled).toBe(false);
  });

  it('should pass through a concrete Logger instance', () => {
    const custom = new VerboseLogger(true);
    expect(createLogger(custom)).toBe(custom);
  });
});
