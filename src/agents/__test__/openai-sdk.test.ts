// @module-tag local

import {
  MaxTurnsExceededError,
  ModelRefusalError,
  ToolTimeoutError,
  UserError,
} from '@openai/agents';
import { OpenAISDKAgent } from 'loop-the-loop/agents/openai-sdk';
import {
  buildCapabilities,
  buildSandboxAgentOptions,
  buildSandboxManifest,
  classifyOpenAIError,
  describeOpenAIError,
  isDestructiveShellCommand,
  normalizeFinalOutput,
  toOpenAIOutputType,
  wrapShellToolsForReadOnly,
} from 'loop-the-loop/agents/openai-sdk';
import type { CheckResult } from 'loop-the-loop/doctor';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function drainCheck(agent: {
  check?(): AsyncIterable<CheckResult>;
}): Promise<Array<CheckResult>> {
  const check = agent.check;
  if (check === undefined) {
    throw new Error('agent.check is not defined');
  }
  const results: Array<CheckResult> = [];
  for await (const result of check.call(agent)) {
    results.push(result);
  }
  return results;
}

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
  it('mounts the working tree writable when source updates are allowed', () => {
    expect(buildSandboxManifest('/repo', true)).toStrictEqual({
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

  it('mounts the working tree read-only when source updates are blocked', () => {
    expect(buildSandboxManifest('/repo', false)).toStrictEqual({
      root: '/workspace',
      entries: {
        repo: {
          type: 'mount',
          source: '/repo',
          readOnly: true,
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

describe('wrapShellToolsForReadOnly', () => {
  /**
   * Build a minimal FunctionTool double good enough for the wrapper to
   * inspect and re-invoke. Real shell tools share this shape; we only need
   * `type`, `name`, and `invoke` for the wrapping logic.
   */
  function functionToolDouble(
    name: string,
    invoke: (input: string) => Promise<string>,
  ) {
    return {
      type: 'function' as const,
      name,
      description: '',
      parameters: { type: 'object' as const, properties: {} },
      strict: true,
      needsApproval: async () => false,
      isEnabled: async () => true,
      invoke: async (_runContext: unknown, input: string, _details?: unknown) =>
        invoke(input),
    };
  }

  it('drops write_stdin so interactive bypasses are not exposed', () => {
    const tools = [
      functionToolDouble('exec_command', async () => 'ok'),
      functionToolDouble('write_stdin', async () => 'ok'),
    ];
    const wrapped = wrapShellToolsForReadOnly(
      tools as unknown as ReadonlyArray<
        Parameters<typeof wrapShellToolsForReadOnly>[0][number]
      >,
    );
    expect(wrapped.map(tool => tool.name)).toEqual(['exec_command']);
  });

  it('rejects destructive exec_command invocations before they reach the shell', async () => {
    let underlyingCalls = 0;
    const tools = [
      functionToolDouble('exec_command', async () => {
        underlyingCalls += 1;
        return 'ran';
      }),
    ];
    const [wrapped] = wrapShellToolsForReadOnly(
      tools as unknown as ReadonlyArray<
        Parameters<typeof wrapShellToolsForReadOnly>[0][number]
      >,
    );
    const result = await (
      wrapped as { invoke: (typeof tools)[0]['invoke'] }
    ).invoke(
      {},
      JSON.stringify({ cmd: 'echo pwned > /workspace/repo/AGENTS.md' }),
    );
    expect(underlyingCalls).toBe(0);
    expect(String(result)).toContain('rejected');
  });

  it('forwards read-only exec_command invocations to the underlying tool', async () => {
    let lastInput: string | undefined;
    const tools = [
      functionToolDouble('exec_command', async input => {
        lastInput = input;
        return 'output';
      }),
    ];
    const [wrapped] = wrapShellToolsForReadOnly(
      tools as unknown as ReadonlyArray<
        Parameters<typeof wrapShellToolsForReadOnly>[0][number]
      >,
    );
    const input = JSON.stringify({ cmd: 'rg --files -g "*.ts"' });
    const result = await (
      wrapped as { invoke: (typeof tools)[0]['invoke'] }
    ).invoke({}, input);
    expect(lastInput).toBe(input);
    expect(result).toBe('output');
  });

  it('passes non-function tools through unchanged', () => {
    const passthrough = {
      type: 'hosted_tool',
      name: 'something_else',
    } as unknown as Parameters<typeof wrapShellToolsForReadOnly>[0][number];
    const [forwarded] = wrapShellToolsForReadOnly([passthrough]);
    expect(forwarded).toBe(passthrough);
  });
});

describe('isDestructiveShellCommand', () => {
  it('flags output redirection examples from the bug', () => {
    expect(
      isDestructiveShellCommand('echo pwned > /workspace/repo/AGENTS.md'),
    ).toBe(true);
    expect(isDestructiveShellCommand('cat src/foo >> dest')).toBe(true);
  });

  it('flags sed -i and other in-place editors', () => {
    expect(isDestructiveShellCommand("sed -i 's/foo/bar/' file")).toBe(true);
    expect(isDestructiveShellCommand('perl -i -pe "s/x/y/" file')).toBe(true);
  });

  it('flags the destructive command tokens listed in the bug', () => {
    expect(isDestructiveShellCommand('rm -rf src')).toBe(true);
    expect(isDestructiveShellCommand('mv a b')).toBe(true);
    expect(isDestructiveShellCommand('tee out < in')).toBe(true);
    expect(isDestructiveShellCommand('touch new-file')).toBe(true);
  });

  it('flags destructive commands appearing after shell separators', () => {
    expect(isDestructiveShellCommand('cat foo && rm bar')).toBe(true);
    expect(isDestructiveShellCommand('echo hi ; mv old new')).toBe(true);
    expect(isDestructiveShellCommand('printf x | tee file')).toBe(true);
  });

  it('flags mutating git and package-manager subcommands', () => {
    expect(isDestructiveShellCommand('git commit -m foo')).toBe(true);
    expect(isDestructiveShellCommand('git checkout main')).toBe(true);
    expect(isDestructiveShellCommand('pnpm install')).toBe(true);
    expect(isDestructiveShellCommand('npm i react')).toBe(true);
  });

  it('does not flag common read-only commands', () => {
    expect(isDestructiveShellCommand('ls -la')).toBe(false);
    expect(isDestructiveShellCommand('cat src/foo.ts')).toBe(false);
    expect(isDestructiveShellCommand('rg --files -g "*.ts"')).toBe(false);
    expect(isDestructiveShellCommand('find . -name "*.ts"')).toBe(false);
    expect(isDestructiveShellCommand('git log --oneline -10')).toBe(false);
    expect(isDestructiveShellCommand('git status')).toBe(false);
    expect(isDestructiveShellCommand('git diff')).toBe(false);
    expect(isDestructiveShellCommand('pnpm test')).toBe(false);
    expect(isDestructiveShellCommand('pnpm tsc')).toBe(false);
  });

  it('allows numeric file-descriptor redirects like 2>&1', () => {
    expect(isDestructiveShellCommand('rg pattern 2>&1')).toBe(false);
  });

  it('treats whitespace-only commands as benign', () => {
    expect(isDestructiveShellCommand('')).toBe(false);
    expect(isDestructiveShellCommand('   ')).toBe(false);
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

describe('OpenAISDKAgent.check()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('passes every probe when the key is present and models list is reachable', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    vi.stubGlobal('fetch', fetchMock);

    const agent = await OpenAISDKAgent.create({
      model: 'gpt-5.5',
      modelSettings: { temperature: 0 },
      outputSchema: { type: 'object' },
    });
    const results = await drainCheck(agent);
    const byName = Object.fromEntries(results.map(r => [r.name, r]));

    expect(byName['credentials present']?.status).toBe('ok');
    expect(byName['config shape valid']?.status).toBe('ok');
    expect(byName['models reachable']?.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      }),
    );
  });

  it('fails credentials and skips the models probe when no key is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const agent = await OpenAISDKAgent.create({});
    const results = await drainCheck(agent);
    const byName = Object.fromEntries(results.map(r => [r.name, r]));

    expect(byName['credentials present']?.status).toBe('fail');
    expect(byName['models reachable']).toStrictEqual({
      name: 'models reachable',
      status: 'skip',
      message: 'no credentials',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails the models probe on a non-200 response', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-bad');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const agent = await OpenAISDKAgent.create({});
    const results = await drainCheck(agent);
    const probe = results.find(r => r.name === 'models reachable');
    expect(probe?.status).toBe('fail');
    expect(probe?.message).toContain('401');
  });

  it('fails the models probe when fetch rejects', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const boom = new Error('network down');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(boom));

    const agent = await OpenAISDKAgent.create({});
    const results = await drainCheck(agent);
    const probe = results.find(r => r.name === 'models reachable');
    expect(probe?.status).toBe('fail');
    expect(probe?.cause).toBe(boom);
  });

  it('fails config validation when model is not a string', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const agent = await OpenAISDKAgent.create({ model: 1 as never });
    const results = await drainCheck(agent);
    const config = results.find(r => r.name === 'config shape valid');
    expect(config?.status).toBe('fail');
    expect(config?.message).toContain('model');
  });

  it('fails config validation when modelSettings is not an object', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const agent = await OpenAISDKAgent.create({
      modelSettings: 'nope' as never,
    });
    const results = await drainCheck(agent);
    const config = results.find(r => r.name === 'config shape valid');
    expect(config?.status).toBe('fail');
    expect(config?.message).toContain('modelSettings');
  });

  it('fails config validation when outputSchema is not an object', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const agent = await OpenAISDKAgent.create({
      outputSchema: 'nope' as never,
    });
    const results = await drainCheck(agent);
    const config = results.find(r => r.name === 'config shape valid');
    expect(config?.status).toBe('fail');
    expect(config?.message).toContain('outputSchema');
  });
});
