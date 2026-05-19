// @module-tag local

import {
  classifyResultStatus,
  configureQueryOptions,
  isTokenLimitError,
} from 'loop-the-loop/agents/claude-sdk';
import { describe, expect, it } from 'vitest';

describe('configureQueryOptions', () => {
  describe('allowedTools', () => {
    it('passes the auto-approval list straight through to the SDK', () => {
      const result = configureQueryOptions({
        allowedTools: ['Read', 'Glob', 'Grep'],
      });
      expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    });

    it('keeps permission patterns intact in the auto-approval list', () => {
      const result = configureQueryOptions({
        allowedTools: [
          'Read',
          'Bash(gh issue create *)',
          'Bash(gh issue list *)',
          'Bash(ls *)',
        ],
      });
      expect(result.allowedTools).toEqual([
        'Read',
        'Bash(gh issue create *)',
        'Bash(gh issue list *)',
        'Bash(ls *)',
      ]);
    });

    it('passes an empty auto-approval list straight through', () => {
      const result = configureQueryOptions({ allowedTools: [] });
      expect(result.allowedTools).toEqual([]);
    });

    it('does not derive the SDK tools list from allowedTools', () => {
      // Regression for joewalker/loop-the-loop#11: previously the agent
      // extracted bare names from `allowedTools` and used them as the SDK
      // `tools` (load list) option. That silently dropped every other
      // built-in tool, and an empty `allowedTools` disabled all tools.
      const result = configureQueryOptions({
        allowedTools: ['Bash(gh issue create *)'],
      });
      expect(result.tools).toBeUndefined();
    });

    it('does not set the SDK tools list when allowedTools is empty', () => {
      // Regression for joewalker/loop-the-loop#11: empty `allowedTools`
      // must not be re-interpreted as "disable all built-in tools".
      const result = configureQueryOptions({ allowedTools: [] });
      expect(result.tools).toBeUndefined();
    });
  });

  describe('loadedTools', () => {
    it('omits the SDK tools option when loadedTools is not configured', () => {
      const result = configureQueryOptions({});
      expect(result.tools).toBeUndefined();
    });

    it('passes an explicit string list of loadedTools through to the SDK', () => {
      const result = configureQueryOptions({
        loadedTools: ['Read', 'Edit', 'Bash'],
      });
      expect(result.tools).toEqual(['Read', 'Edit', 'Bash']);
    });

    it('passes an empty loadedTools list through to the SDK', () => {
      // The SDK documents `tools: []` as "disable all built-in tools".
      // Setting `loadedTools: []` opts into that semantics explicitly.
      const result = configureQueryOptions({ loadedTools: [] });
      expect(result.tools).toEqual([]);
    });

    it('passes the claude_code preset through to the SDK', () => {
      const result = configureQueryOptions({
        loadedTools: { type: 'preset', preset: 'claude_code' },
      });
      expect(result.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('loadedTools and allowedTools are independent', () => {
      const result = configureQueryOptions({
        loadedTools: ['Bash'],
        allowedTools: ['Bash(ls *)'],
      });
      expect(result.tools).toEqual(['Bash']);
      expect(result.allowedTools).toEqual(['Bash(ls *)']);
    });
  });

  describe('isTokenLimitError', () => {
    it('matches a rate-limit phrase regardless of letter case', () => {
      // Regression for joewalker/loop-the-loop#8: prior to the fix the
      // substring check was case-sensitive, so HTTP status text using
      // "Rate Limit" did not classify as a transient glitch.
      expect(isTokenLimitError('HTTP 429: Rate limit exceeded')).toBe(true);
      expect(isTokenLimitError('HTTP 429: RATE LIMIT EXCEEDED')).toBe(true);
    });

    it('matches the `rate_limit` underscore variant case-insensitively', () => {
      expect(isTokenLimitError('rate_limit reached')).toBe(true);
      expect(isTokenLimitError('Rate_Limit reached')).toBe(true);
    });

    it('matches the bare 429 status code', () => {
      expect(isTokenLimitError('request failed: 429 Too Many Requests')).toBe(
        true,
      );
    });

    it('matches "quota" case-insensitively', () => {
      expect(isTokenLimitError('Quota exceeded for the day')).toBe(true);
    });

    it('matches "context window" phrasing', () => {
      expect(isTokenLimitError('prompt exceeds the model context window')).toBe(
        true,
      );
    });

    it('matches a "token limit" phrase', () => {
      expect(isTokenLimitError('request exceeded the Token Limit')).toBe(true);
    });

    it('does not match unrelated errors that just contain the word "token"', () => {
      // Regression for joewalker/loop-the-loop#8: the bare substring
      // `"token"` was previously broad enough to misclassify unrelated
      // errors (tokenisers, JWTs, OAuth tokens, etc.) as transient
      // glitches and keep retrying them indefinitely.
      expect(isTokenLimitError('TypeError: failed to tokenize input')).toBe(
        false,
      );
      expect(
        isTokenLimitError('OAuth bearer token rejected: invalid signature'),
      ).toBe(false);
      expect(
        isTokenLimitError('Unexpected token < in JSON at position 0'),
      ).toBe(false);
    });

    it('does not match an unrelated failure', () => {
      expect(isTokenLimitError('ENOENT: no such file or directory')).toBe(
        false,
      );
    });
  });

  describe('classifyResultStatus', () => {
    it('classifies the SDK `error_max_budget_usd` subtype as a glitch', () => {
      // The SDK signals that the budget cap was hit via the result
      // subtype rather than the reason string; prefer the structured
      // field over substring sniffing.
      expect(
        classifyResultStatus('error_max_budget_usd', {}, 'budget exhausted'),
      ).toBe('glitch');
    });

    it('classifies a `blocking_limit` terminal_reason as a glitch', () => {
      expect(
        classifyResultStatus(
          'error_during_execution',
          { terminal_reason: 'blocking_limit' },
          'failure',
        ),
      ).toBe('glitch');
    });

    it('classifies a `rapid_refill_breaker` terminal_reason as a glitch', () => {
      expect(
        classifyResultStatus(
          'error_during_execution',
          { terminal_reason: 'rapid_refill_breaker' },
          'failure',
        ),
      ).toBe('glitch');
    });

    it('falls back to substring matching when no structured signal is set', () => {
      expect(
        classifyResultStatus(
          'error_during_execution',
          {},
          'HTTP 429: Rate limit exceeded',
        ),
      ).toBe('glitch');
    });

    it('returns `error` for an unrelated failure with no structured signal', () => {
      expect(
        classifyResultStatus(
          'error_during_execution',
          {},
          'unexpected JSON parse failure',
        ),
      ).toBe('error');
    });
  });

  describe('permissionMode', () => {
    it('uses the default permission mode when source updates are not allowed', () => {
      const result = configureQueryOptions({ allowedTools: ['Read'] });
      expect(result.permissionMode).toBe('default');
    });

    it('uses acceptEdits when source updates are allowed', () => {
      const result = configureQueryOptions({ allowedTools: ['Read'] }, true);
      expect(result.permissionMode).toBe('acceptEdits');
    });
  });
});
