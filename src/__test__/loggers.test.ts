import { styleText } from 'node:util';

import { createLogger, VerboseLogger } from 'loop-the-loop/loggers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('VerboseLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log colored messages to stderr when enabled', () => {
    const log = new VerboseLogger(true);
    log.agent('hello from agent');

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(
      styleText('cyan', '[agent] hello from agent'),
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
      styleText('yellow', '[tool] tool msg'),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      2,
      styleText('green', '[success] ok msg'),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      3,
      styleText('red', '[error] err msg'),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      4,
      styleText('magenta', '[system] sys msg'),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      5,
      styleText('blue', '[state] state msg'),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(
      6,
      styleText('gray', '[info] info msg'),
    );
  });

  it('should expose enabled state', () => {
    expect(new VerboseLogger(true).enabled).toBe(true);
    expect(new VerboseLogger(false).enabled).toBe(false);
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
