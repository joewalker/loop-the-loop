// @module-tag local

import {
  MaxTurnsExceededError,
  ModelRefusalError,
  ToolTimeoutError,
  UserError,
} from '@openai/agents';
import {
  buildCapabilities,
  buildSandboxAgentOptions,
  buildSandboxManifest,
  classifyOpenAIError,
  describeOpenAIError,
  normalizeFinalOutput,
  toOpenAIOutputType,
} from 'loop-the-loop/agents/openai-sdk';
import { describe, expect, it } from 'vitest';

describe('buildSandboxAgentOptions', () => {
  it('maps config fields into SandboxAgent options', () => {
    const options = buildSandboxAgentOptions(
      {
        systemPrompt: 'Project-specific guidance.',
        outputSchema: {
          title: 'Review Result',
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        model: 'gpt-5.5',
        modelSettings: { temperature: 0 },
        maxTurns: 2,
      },
      true,
      '/repo',
    );

    expect(options.name).toBe('Loop the Loop OpenAI SDK Agent');
    expect(options.instructions).toContain('/workspace/repo');
    expect(options.instructions).toContain('Project-specific guidance.');
    expect(options.model).toBe('gpt-5.5');
    expect(options.modelSettings).toStrictEqual({ temperature: 0 });
    expect(options.outputType).toMatchObject({
      type: 'json_schema',
      name: 'Review_Result',
      strict: true,
    });
  });

  it('does not set optional SDK fields when config omits them', () => {
    const options = buildSandboxAgentOptions({}, false, '/repo');

    expect(options.model).toBeUndefined();
    expect(options.modelSettings).toBeUndefined();
    expect(options.outputType).toBeUndefined();
  });
});

describe('buildSandboxManifest', () => {
  it('mounts the working tree at /workspace/repo using a local bind mount', () => {
    expect(buildSandboxManifest('/repo')).toStrictEqual({
      root: '/workspace',
      entries: {
        repo: {
          type: 'mount',
          source: '/repo',
          readOnly: false,
          mountStrategy: { type: 'local_bind' },
        },
      },
    });
  });
});

describe('buildCapabilities', () => {
  it('uses the default sandbox capabilities when source updates are allowed', () => {
    expect(buildCapabilities(true).map(capability => capability.type)).toEqual([
      'filesystem',
      'shell',
      'compaction',
    ]);
  });

  it('keeps read-oriented capabilities when source updates are not allowed', () => {
    expect(buildCapabilities(false).map(capability => capability.type)).toEqual(
      ['filesystem', 'shell', 'compaction'],
    );
  });
});

describe('toOpenAIOutputType', () => {
  it('wraps Loop JSON Schema for the Agents SDK', () => {
    expect(
      toOpenAIOutputType({
        title: 'Bug Report',
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      }),
    ).toStrictEqual({
      type: 'json_schema',
      name: 'Bug_Report',
      strict: true,
      schema: {
        title: 'Bug Report',
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
    });
  });
});

describe('normalizeFinalOutput', () => {
  it('returns a success result for text output', () => {
    expect(normalizeFinalOutput('done')).toStrictEqual({
      status: 'success',
      output: 'done',
    });
  });

  it('returns structuredOutput for non-string output', () => {
    expect(normalizeFinalOutput({ ok: true })).toStrictEqual({
      status: 'success',
      output: '{"ok":true}',
      structuredOutput: { ok: true },
    });
  });

  it('returns an error when the SDK omits finalOutput', () => {
    expect(normalizeFinalOutput(undefined)).toStrictEqual({
      status: 'error',
      reason: 'No output received from OpenAI SDK agent',
    });
  });
});

describe('OpenAI SDK error handling', () => {
  it('classifies max-turn exhaustion as a prompt error', () => {
    expect(
      classifyOpenAIError(new MaxTurnsExceededError('too many turns')),
    ).toBe('error');
  });

  it('classifies model refusals as prompt errors', () => {
    expect(classifyOpenAIError(new ModelRefusalError('no'))).toBe('error');
  });

  it('classifies user configuration errors as prompt errors', () => {
    expect(classifyOpenAIError(new UserError('bad config'))).toBe('error');
  });

  it('classifies tool timeouts as glitches', () => {
    expect(
      classifyOpenAIError(
        new ToolTimeoutError({ toolName: 'exec_command', timeoutMs: 1000 }),
      ),
    ).toBe('glitch');
  });

  it('classifies API rate limit text as a glitch', () => {
    expect(
      classifyOpenAIError(new Error('HTTP 429: rate limit exceeded')),
    ).toBe('glitch');
  });

  it('describes SDK errors with their useful fields', () => {
    const error = Object.assign(new Error('request failed'), {
      status: 429,
      code: 'rate_limit_exceeded',
      type: 'rate_limit_error',
    });

    expect(describeOpenAIError(error)).toBe(
      'Error: request failed (status=429, code=rate_limit_exceeded, type=rate_limit_error)',
    );
  });
});
