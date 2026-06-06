// @module-tag local

import {
  formatAttempt,
  parseAttempt,
  resolveAttemptId,
} from 'loop-the-loop/prompt-generators/util/attempt';
import { describe, expect, it } from 'vitest';

describe('parseAttempt', () => {
  it('treats a bare id as attempt 1', () => {
    expect(parseAttempt('bug-1')).toEqual({ base: 'bug-1', attempt: 1 });
  });

  it('parses a numeric suffix of 2 or more as the attempt', () => {
    expect(parseAttempt('bug-1#2')).toEqual({ base: 'bug-1', attempt: 2 });
    expect(parseAttempt('bug-1#10')).toEqual({ base: 'bug-1', attempt: 10 });
  });

  it('keeps a #1 or #0 suffix as part of the base so ids round-trip', () => {
    expect(parseAttempt('bug-1#1')).toEqual({ base: 'bug-1#1', attempt: 1 });
    expect(parseAttempt('bug-1#0')).toEqual({ base: 'bug-1#0', attempt: 1 });
  });

  it('keeps a non-numeric suffix as part of the base', () => {
    expect(parseAttempt('bug#abc')).toEqual({ base: 'bug#abc', attempt: 1 });
  });

  it('does not treat a leading-# id as an attempt suffix', () => {
    expect(parseAttempt('#2')).toEqual({ base: '#2', attempt: 1 });
  });
});

describe('formatAttempt', () => {
  it('renders attempt 1 as the bare base', () => {
    expect(formatAttempt('bug-1', 1)).toBe('bug-1');
  });

  it('renders attempt 2 or more with a #N suffix', () => {
    expect(formatAttempt('bug-1', 2)).toBe('bug-1#2');
    expect(formatAttempt('bug-1', 5)).toBe('bug-1#5');
  });

  it('round-trips with parseAttempt', () => {
    const { base, attempt } = parseAttempt('bug-1#3');
    expect(formatAttempt(base, attempt)).toBe('bug-1#3');
  });
});

describe('resolveAttemptId', () => {
  it('returns the id verbatim with no knobs', () => {
    expect(resolveAttemptId('bug-1', {})).toBe('bug-1');
    expect(resolveAttemptId('bug-1#2', {})).toBe('bug-1#2');
  });

  it('increments the attempt when incrementAttempt is set', () => {
    expect(resolveAttemptId('bug-1', { incrementAttempt: true })).toBe(
      'bug-1#2',
    );
    expect(resolveAttemptId('bug-1#2', { incrementAttempt: true })).toBe(
      'bug-1#3',
    );
  });

  it('emits only while the incoming attempt is below maxAttempts', () => {
    expect(
      resolveAttemptId('bug-1', { maxAttempts: 3, incrementAttempt: true }),
    ).toBe('bug-1#2');
    expect(
      resolveAttemptId('bug-1#2', { maxAttempts: 3, incrementAttempt: true }),
    ).toBe('bug-1#3');
    expect(
      resolveAttemptId('bug-1#3', { maxAttempts: 3, incrementAttempt: true }),
    ).toBeNull();
  });

  it('emits only once the incoming attempt is at or above minAttempts', () => {
    expect(resolveAttemptId('bug-1', { minAttempts: 3 })).toBeNull();
    expect(resolveAttemptId('bug-1#2', { minAttempts: 3 })).toBeNull();
    expect(resolveAttemptId('bug-1#3', { minAttempts: 3 })).toBe('bug-1#3');
  });

  it('applies both gates together', () => {
    expect(
      resolveAttemptId('bug-1#2', { minAttempts: 2, maxAttempts: 4 }),
    ).toBe('bug-1#2');
    expect(
      resolveAttemptId('bug-1', { minAttempts: 2, maxAttempts: 4 }),
    ).toBeNull();
  });
});
