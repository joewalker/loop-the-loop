import { parseArgs } from 'agentic-loop/cli';
import { describe, expect, it } from 'vitest';

describe('parseArgs', () => {
  it('returns the config path', () => {
    expect(parseArgs(['config.json'])).toMatchObject({ configPath: 'config.json' });
  });

  it('verbose defaults to false', () => {
    expect(parseArgs(['config.json']).verbose).toBe(false);
  });

  it('sets verbose when --verbose is present', () => {
    expect(parseArgs(['--verbose', 'config.json']).verbose).toBe(true);
  });

  it('verbose works after the config path too', () => {
    expect(parseArgs(['config.json', '--verbose']).verbose).toBe(true);
  });

  it('overrides is empty when no overrides given', () => {
    expect(parseArgs(['config.json']).overrides).toEqual({});
  });

  it('parses --maxPrompts=N', () => {
    expect(parseArgs(['--maxPrompts=5', 'config.json']).overrides).toEqual({ maxPrompts: 5 });
  });

  it('parses --maxPrompts=0 (allow zero)', () => {
    expect(parseArgs(['--maxPrompts=0', 'config.json']).overrides).toEqual({ maxPrompts: 0 });
  });

  it('combines --verbose and --maxPrompts', () => {
    const result = parseArgs(['--verbose', '--maxPrompts=3', 'config.json']);
    expect(result).toMatchObject({ verbose: true, overrides: { maxPrompts: 3 }, configPath: 'config.json' });
  });

  it('throws on missing config path', () => {
    expect(() => parseArgs([])).toThrow('Usage:');
  });

  it('throws on invalid --maxPrompts value', () => {
    expect(() => parseArgs(['--maxPrompts=abc', 'config.json'])).toThrow('Invalid --maxPrompts value: abc');
  });

  it('throws on negative --maxPrompts value', () => {
    expect(() => parseArgs(['--maxPrompts=-1', 'config.json'])).toThrow('Invalid --maxPrompts value: -1');
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--unknown=x', 'config.json'])).toThrow('Unknown option: --unknown');
  });
});
