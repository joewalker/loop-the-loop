// @module-tag local

import {
  classifyResultStatus,
  configureQueryOptions,
  describeResultError,
  formatSystemMessage,
  formatToolUseSummary,
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

  describe('model', () => {
    it('omits the SDK model option when not configured', () => {
      const result = configureQueryOptions({});
      expect(result.model).toBeUndefined();
    });

    it('forwards the configured model verbatim', () => {
      const result = configureQueryOptions({ model: 'claude-opus-4-7' });
      expect(result.model).toBe('claude-opus-4-7');
    });

    it('accepts an alias (e.g. "sonnet") and forwards it verbatim', () => {
      const result = configureQueryOptions({ model: 'sonnet' });
      expect(result.model).toBe('sonnet');
    });
  });

  describe('fallbackModel', () => {
    it('omits the SDK fallbackModel option when not configured', () => {
      const result = configureQueryOptions({});
      expect(result.fallbackModel).toBeUndefined();
    });

    it('forwards the configured fallbackModel verbatim', () => {
      const result = configureQueryOptions({
        fallbackModel: 'claude-haiku-4-5',
      });
      expect(result.fallbackModel).toBe('claude-haiku-4-5');
    });
  });

  describe('effort', () => {
    it('omits the SDK effort option when not configured', () => {
      const result = configureQueryOptions({});
      expect(result.effort).toBeUndefined();
    });

    it('forwards the configured effort level verbatim', () => {
      const result = configureQueryOptions({ effort: 'low' });
      expect(result.effort).toBe('low');
    });
  });

  describe('thinking', () => {
    it('omits the SDK thinking option when not configured', () => {
      const result = configureQueryOptions({});
      expect(result.thinking).toBeUndefined();
    });

    it('forwards an adaptive thinking config', () => {
      const result = configureQueryOptions({ thinking: { type: 'adaptive' } });
      expect(result.thinking).toEqual({ type: 'adaptive' });
    });

    it('forwards an enabled thinking config with a budget', () => {
      const result = configureQueryOptions({
        thinking: { type: 'enabled', budgetTokens: 2048 },
      });
      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 2048 });
    });

    it('forwards a disabled thinking config', () => {
      const result = configureQueryOptions({ thinking: { type: 'disabled' } });
      expect(result.thinking).toEqual({ type: 'disabled' });
    });
  });

  describe('additionalDirectories', () => {
    it('omits the SDK additionalDirectories option when not configured', () => {
      const result = configureQueryOptions({});
      expect(result.additionalDirectories).toBeUndefined();
    });

    it('forwards the configured directories as a mutable array', () => {
      const result = configureQueryOptions({
        additionalDirectories: ['/tmp/work', '/var/data'],
      });
      expect(result.additionalDirectories).toEqual(['/tmp/work', '/var/data']);
    });

    it('passes an empty additionalDirectories list straight through', () => {
      const result = configureQueryOptions({ additionalDirectories: [] });
      expect(result.additionalDirectories).toEqual([]);
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

  describe('describeResultError', () => {
    it('surfaces the SDK `errors` array joined into the reason', () => {
      // Regression for joewalker/loop-the-loop#6: the SDK puts the
      // diagnostic strings on `errors: string[]`, not on `error` or
      // `message`. Previously the reason only said
      // `subtype=error_during_execution` with no detail.
      const reason = describeResultError('error_during_execution', {
        errors: ['mcp tool failed', 'connection refused'],
      });
      expect(reason).toContain('subtype=error_during_execution');
      expect(reason).toContain('errors=mcp tool failed; connection refused');
    });

    it('ignores non-string entries in the SDK `errors` array', () => {
      const reason = describeResultError('error_during_execution', {
        errors: ['boom', 42, null, 'kaboom'],
      });
      expect(reason).toContain('errors=boom; kaboom');
    });

    it('omits the errors clause when the array is empty', () => {
      const reason = describeResultError('error_during_execution', {
        errors: [],
      });
      expect(reason).not.toContain('errors=');
    });

    it('surfaces `terminal_reason` and `stop_reason` when present', () => {
      const reason = describeResultError('error_during_execution', {
        errors: ['boom'],
        terminal_reason: 'blocking_limit',
        stop_reason: 'max_tokens',
      });
      expect(reason).toContain('terminal_reason=blocking_limit');
      expect(reason).toContain('stop_reason=max_tokens');
    });

    it('falls back to legacy `error` and `message` fields if no `errors` array', () => {
      // Keep the legacy reads as a defensive fallback so older or
      // alternative result shapes still produce useful diagnostics.
      const reason = describeResultError('error_during_execution', {
        error: 'legacy error string',
        message: 'legacy message string',
      });
      expect(reason).toContain('error=legacy error string');
      expect(reason).toContain('message=legacy message string');
    });

    it('describes the subtype even when no diagnostic fields are present', () => {
      const reason = describeResultError('error_during_execution', {});
      expect(reason).toBe(
        'Agent invocation failed (subtype=error_during_execution)',
      );
    });

    it('handles an undefined subtype gracefully', () => {
      const reason = describeResultError(undefined, {});
      expect(reason).toContain('subtype=unknown');
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

describe('formatToolUseSummary', () => {
  it('uses the SDK-provided summary field and counts preceding tool uses', () => {
    // Regression for joewalker/loop-the-loop#9: earlier code read
    // `tool_name` and `status` from this message shape, which the SDK
    // does not populate, so the log line always read
    // "Summary: unknown -> ".
    const line = formatToolUseSummary({
      type: 'tool_use_summary',
      summary: 'Inspected three files and ran the linter',
      preceding_tool_use_ids: ['a', 'b', 'c'],
      uuid: '00000000-0000-0000-0000-000000000001',
      session_id: 'sess-1',
    });
    expect(line).toBe(
      'Summary (3 tool uses): Inspected three files and ran the linter',
    );
  });

  it('uses the singular noun for a single tool use', () => {
    const line = formatToolUseSummary({
      type: 'tool_use_summary',
      summary: 'Read one file',
      preceding_tool_use_ids: ['a'],
      uuid: '00000000-0000-0000-0000-000000000002',
      session_id: 'sess-1',
    });
    expect(line).toBe('Summary (1 tool use): Read one file');
  });

  it('reports zero uses when the list is empty', () => {
    const line = formatToolUseSummary({
      type: 'tool_use_summary',
      summary: 'nothing to do',
      preceding_tool_use_ids: [],
      uuid: '00000000-0000-0000-0000-000000000003',
      session_id: 'sess-1',
    });
    expect(line).toBe('Summary (0 tool uses): nothing to do');
  });
});

describe('formatSystemMessage', () => {
  // Regression for joewalker/loop-the-loop#9: the previous "[subtype]
  // <body>" template read `msg.message`, which no SDK system subtype
  // populates, so every line had an empty body.

  it('summarizes init with model, tool count, mcp count, permission mode', () => {
    // The SDK's SDKSystemMessage has many fields we don't surface; only
    // the four operationally useful ones are typed below.
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'user',
      claude_code_version: '1.2.3',
      cwd: '/tmp',
      tools: ['Read', 'Grep', 'Bash'],
      mcp_servers: [{ name: 'one', status: 'connected' }],
      model: 'claude-opus-4-7',
      permissionMode: 'acceptEdits',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: '00000000-0000-0000-0000-000000000004',
      session_id: 'sess-1',
    });
    expect(line).toBe(
      '[init] model=claude-opus-4-7, tools=3, mcp_servers=1, permissionMode=acceptEdits',
    );
  });

  it('renders a status message with only the status field', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: '00000000-0000-0000-0000-000000000005',
      session_id: 'sess-1',
    });
    expect(line).toBe('[status] status=compacting');
  });

  it('renders idle when status is null', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'status',
      status: null,
      uuid: '00000000-0000-0000-0000-000000000006',
      session_id: 'sess-1',
    });
    expect(line).toBe('[status] status=idle');
  });

  it('includes compact_result and compact_error when present', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'context too small',
      uuid: '00000000-0000-0000-0000-000000000007',
      session_id: 'sess-1',
    });
    expect(line).toBe(
      '[status] status=idle, compact_result=failed, compact_error=context too small',
    );
  });

  it('omits an empty compact_error', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_error: '',
      uuid: '00000000-0000-0000-0000-000000000008',
      session_id: 'sess-1',
    });
    expect(line).toBe('[status] status=idle');
  });

  it('renders session_state_changed with the state', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: '00000000-0000-0000-0000-000000000009',
      session_id: 'sess-1',
    });
    expect(line).toBe('[session_state_changed] state=idle');
  });

  it('renders task_started with the description', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      description: 'Run the unit tests',
      uuid: '00000000-0000-0000-0000-00000000000a',
      session_id: 'sess-1',
    });
    expect(line).toBe('[task_started] Run the unit tests');
  });

  it('renders task_progress with description only when no summary', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'Still working',
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
      uuid: '00000000-0000-0000-0000-00000000000b',
      session_id: 'sess-1',
    });
    expect(line).toBe('[task_progress] Still working');
  });

  it('renders task_progress with a summary suffix when present', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'Still working',
      summary: 'half done',
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
      uuid: '00000000-0000-0000-0000-00000000000c',
      session_id: 'sess-1',
    });
    expect(line).toBe('[task_progress] Still working - half done');
  });

  it('renders task_notification with status and summary', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      output_file: '/dev/null',
      summary: 'All tests passed',
      uuid: '00000000-0000-0000-0000-00000000000d',
      session_id: 'sess-1',
    });
    expect(line).toBe('[task_notification] completed: All tests passed');
  });

  it('renders task_updated with the patch field names', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'running', description: 'now working' },
      uuid: '00000000-0000-0000-0000-00000000000e',
      session_id: 'sess-1',
    });
    expect(line).toBe('[task_updated] status, description');
  });

  it('renders compact_boundary with trigger and pre_tokens', () => {
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 1234 },
      uuid: '00000000-0000-0000-0000-00000000000f',
      session_id: 'sess-1',
    });
    expect(line).toBe('[compact_boundary] trigger=auto, pre_tokens=1234');
  });

  it('falls back to JSON for unknown subtypes', () => {
    // Forward-compat path: cast through unknown so we can fabricate a
    // subtype the SDK union does not (yet) include.
    const line = formatSystemMessage({
      type: 'system',
      subtype: 'brand_new_thing',
      payload: { foo: 'bar' },
      uuid: '00000000-0000-0000-0000-000000000010',
      session_id: 'sess-1',
    } as unknown as Parameters<typeof formatSystemMessage>[0]);
    expect(line).toBe(
      '[brand_new_thing] {"subtype":"brand_new_thing","payload":{"foo":"bar"}}',
    );
  });

  it('falls back to literal "system" when the subtype is not a string', () => {
    const line = formatSystemMessage({
      type: 'system',
      payload: { foo: 'bar' },
      uuid: '00000000-0000-0000-0000-000000000011',
      session_id: 'sess-1',
    } as unknown as Parameters<typeof formatSystemMessage>[0]);
    expect(line).toBe('[system] {"payload":{"foo":"bar"}}');
  });
});
