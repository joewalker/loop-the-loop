// @module-tag local

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent } from 'loop-the-loop/agents';
import { doctor } from 'loop-the-loop/doctor';
import { createLogger, type Logger } from 'loop-the-loop/loggers';
import type { LoopCliConfig } from 'loop-the-loop/types';
import { Git } from 'loop-the-loop/util/git';
import { describe, expect, it, vi } from 'vitest';

const okAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
  async *check() {
    yield { name: 'all good', status: 'ok' };
  },
};

const throwingAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
  // eslint-disable-next-line require-yield
  async *check() {
    throw new Error('boom');
  },
};

const stringThrowingAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
  // eslint-disable-next-line require-yield
  async *check() {
    throw 'plain string failure';
  },
};

const noStackThrowingAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
  // eslint-disable-next-line require-yield
  async *check() {
    const err = new Error('no stack here');
    delete err.stack;
    throw err;
  },
};

const noCheckAgent: Agent = {
  invoke: async () => ({ status: 'success', output: '' }),
};

async function baseConfig(
  overrides: Partial<LoopCliConfig>,
): Promise<LoopCliConfig> {
  const outputDir = await mkdtemp(join(tmpdir(), 'doctor-'));
  return {
    name: 'job',
    outputDir,
    agent: noCheckAgent,
    promptGenerator: { generate: async function* () {} },
    reporter: { append: async () => {} },
    ...overrides,
  } as LoopCliConfig;
}

function collect(): { lines: Array<string>; write: (line: string) => void } {
  const lines: Array<string> = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('doctor', () => {
  it('returns true and prints an ok line for a passing check', async () => {
    const { lines, write } = collect();
    const ok = await doctor(
      await baseConfig({ agent: okAgent }),
      createLogger(undefined),
      write,
    );
    expect(ok).toBe(true);
    expect(lines.some(l => l.includes('agent (custom): all good'))).toBe(true);
    expect(lines.some(l => l.startsWith('[ok]'))).toBe(true);
  });

  it('yields a synthetic fail (return false) when check() throws', async () => {
    const { lines, write } = collect();
    const ok = await doctor(
      await baseConfig({ agent: throwingAgent }),
      createLogger(undefined),
      write,
    );
    expect(ok).toBe(false);
    expect(lines.some(l => l.startsWith('[fail]') && l.includes('boom'))).toBe(
      true,
    );
  });

  it('yields exactly one skip for a component without check()', async () => {
    const { lines, write } = collect();
    await doctor(
      await baseConfig({ agent: noCheckAgent }),
      createLogger(undefined),
      write,
    );
    const skips = lines.filter(
      l => l.includes('agent (custom)') && l.startsWith('[skip]'),
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('no diagnostics defined');
  });

  it('runs the other components when one fails to construct', async () => {
    const { lines, write } = collect();
    const ok = await doctor(
      await baseConfig({ agent: 'no-such-agent' as never }),
      createLogger(undefined),
      write,
    );
    expect(ok).toBe(false);
    expect(lines.some(l => l.includes('agent (no-such-agent)'))).toBe(true);
    expect(lines.some(l => l.includes('reporter'))).toBe(true);
    expect(lines.some(l => l.includes('environment'))).toBe(true);
  });

  it('reports the environment output-directory and state checks', async () => {
    const { lines, write } = collect();
    await doctor(await baseConfig({}), createLogger(undefined), write);
    expect(
      lines.some(
        l =>
          l.includes('environment') && l.includes('output directory writable'),
      ),
    ).toBe(true);
    expect(lines.some(l => l.includes('resumable state'))).toBe(true);
  });

  it('fails on a malformed (non-v2) state file', async () => {
    const config = await baseConfig({});
    await writeFile(
      join(config.outputDir as string, `${config.name}-loop-state.json`),
      JSON.stringify({ version: 1 }),
    );
    const { lines, write } = collect();
    const ok = await doctor(config, createLogger(undefined), write);
    expect(ok).toBe(false);
    expect(
      lines.some(l => l.startsWith('[fail]') && l.includes('resumable state')),
    ).toBe(true);
  });

  it('reports ok for a valid v2 state file', async () => {
    const config = await baseConfig({});
    await writeFile(
      join(config.outputDir as string, `${config.name}-loop-state.json`),
      JSON.stringify({ version: 2, results: {}, claims: {}, totalUsd: 0 }),
    );
    const { lines, write } = collect();
    await doctor(config, createLogger(undefined), write);
    expect(
      lines.some(l => l.startsWith('[ok]') && l.includes('resumable state')),
    ).toBe(true);
  });

  it('fails when the output directory is not writable', async () => {
    const { lines, write } = collect();
    const ok = await doctor(
      await baseConfig({ outputDir: '/no/such/path/for/doctor' }),
      createLogger(undefined),
      write,
    );
    expect(ok).toBe(false);
    expect(
      lines.some(
        l => l.startsWith('[fail]') && l.includes('output directory writable'),
      ),
    ).toBe(true);
  });

  it('does not run the git preflight when allowSourceUpdate is unset', async () => {
    const { lines, write } = collect();
    await doctor(await baseConfig({}), createLogger(undefined), write);
    expect(lines.some(l => l.includes('inside work tree'))).toBe(false);
  });

  it('reports an ok git preflight against a clean repo with identity', async () => {
    const originalCwd = process.cwd();
    const repoPath = await mkdtemp(join(tmpdir(), 'doctor-git-'));
    try {
      const git = new Git(repoPath);
      await git.init();
      execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Test']);
      execFileSync('git', [
        '-C',
        repoPath,
        'config',
        'user.email',
        'test@test.com',
      ]);
      await writeFile(join(repoPath, 'a.txt'), 'a');
      await git.add('a.txt');
      await git.commit('init', {
        committer: { name: 'Test', email: 'test@test.com' },
      });
      process.chdir(repoPath);

      const { lines, write } = collect();
      const ok = await doctor(
        await baseConfig({ allowSourceUpdate: true, outputDir: repoPath }),
        createLogger(undefined),
        write,
      );
      expect(ok).toBe(true);
      expect(
        lines.some(l => l.startsWith('[ok]') && l.includes('inside work tree')),
      ).toBe(true);
      expect(
        lines.some(
          l => l.startsWith('[ok]') && l.includes('committer identity'),
        ),
      ).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it('fails the git preflight when cwd is not a work tree', async () => {
    const originalCwd = process.cwd();
    const nonRepo = await mkdtemp(join(tmpdir(), 'doctor-nonrepo-'));
    try {
      process.chdir(nonRepo);
      const { lines, write } = collect();
      const ok = await doctor(
        await baseConfig({ allowSourceUpdate: true, outputDir: nonRepo }),
        createLogger(undefined),
        write,
      );
      expect(ok).toBe(false);
      expect(
        lines.some(
          l => l.startsWith('[fail]') && l.includes('inside work tree'),
        ),
      ).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await rm(nonRepo, { recursive: true, force: true });
    }
  });

  it('writes to stdout by default when no sink is injected', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await doctor(
        await baseConfig({ agent: okAgent }),
        createLogger(undefined),
      );
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('falls back to cwd when outputDir is absent', async () => {
    const { agent, promptGenerator, reporter, name } = await baseConfig({
      agent: okAgent,
    });
    const { lines, write } = collect();
    const ok = await doctor(
      { name, agent, promptGenerator, reporter } as LoopCliConfig,
      createLogger(undefined),
      write,
    );
    expect(ok).toBe(true);
    expect(lines.some(l => l.includes('output directory writable'))).toBe(true);
  });

  it('builds a reporter from a string spec name', async () => {
    const config = await baseConfig({ reporter: 'jsonl-report' });
    const { lines, write } = collect();
    await doctor(config, createLogger(undefined), write);
    expect(lines.some(l => l.includes('reporter (jsonl-report)'))).toBe(true);
  });

  it('logs an Error cause stack through the logger when enabled', async () => {
    const logger: Logger = createLogger('verbose');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { write } = collect();
    await doctor(await baseConfig({ agent: throwingAgent }), logger, write);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('logs a non-Error cause via String() when enabled', async () => {
    const logger: Logger = createLogger('verbose');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { write } = collect();
    await doctor(
      await baseConfig({ agent: stringThrowingAgent }),
      logger,
      write,
    );
    expect(errorSpy).toHaveBeenCalledWith('plain string failure');
  });

  it('falls back to the message when an Error cause has no stack', async () => {
    const logger: Logger = createLogger('verbose');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { write } = collect();
    await doctor(
      await baseConfig({ agent: noStackThrowingAgent }),
      logger,
      write,
    );
    expect(errorSpy).toHaveBeenCalledWith('no stack here');
  });

  it('does not log the cause when the logger is disabled', async () => {
    const logger: Logger = createLogger(undefined);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { write } = collect();
    await doctor(await baseConfig({ agent: throwingAgent }), logger, write);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('names a tuple-spec component by its type', async () => {
    const { lines, write } = collect();
    await doctor(
      await baseConfig({
        agent: ['test', { responses: [{ status: 'success', output: 'x' }] }],
      }),
      createLogger(undefined),
      write,
    );
    expect(lines.some(l => l.includes('agent (test)'))).toBe(true);
  });

  it('names a default reporter when none is configured', async () => {
    const { lines, write } = collect();
    const { reporter: _omitted, ...withoutReporter } = await baseConfig({});
    await doctor(
      withoutReporter as LoopCliConfig,
      createLogger(undefined),
      write,
    );
    expect(lines.some(l => l.includes('reporter (default)'))).toBe(true);
  });

  it('prints a trailing summary counting statuses', async () => {
    const { lines, write } = collect();
    await doctor(
      await baseConfig({ agent: okAgent }),
      createLogger(undefined),
      write,
    );
    expect(lines.at(-1)).toMatch(
      /^Summary: \d+ ok, \d+ warn, \d+ fail, \d+ skip$/u,
    );
  });
});
