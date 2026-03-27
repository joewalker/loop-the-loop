import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPrompt,
  type PerFileAgenticTask,
} from 'agentic-loop/prompt-generators/per-file';
import type { AgenticLoopCliConfig } from 'agentic-loop/types';
import {
  loadCliConfig,
  normalizeCliConfig,
  parseArgs,
} from 'agentic-loop/util/load-cli-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('parseArgs', () => {
  it('returns the config path', () => {
    expect(parseArgs(['config.json'])).toMatchObject({
      configPath: 'config.json',
    });
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

  it('maxPrompts is empty when no overrides given', () => {
    expect(parseArgs(['config.json']).maxPrompts).toBeUndefined();
  });

  it('parses --maxPrompts=N', () => {
    expect(parseArgs(['--maxPrompts=5', 'config.json']).maxPrompts).toEqual(5);
  });

  it('parses --maxPrompts=0 (allow zero)', () => {
    expect(parseArgs(['--maxPrompts=0', 'config.json']).maxPrompts).toEqual(0);
  });

  it('combines --verbose and --maxPrompts', () => {
    const result = parseArgs(['--verbose', '--maxPrompts=3', 'config.json']);
    expect(result).toMatchObject({
      verbose: true,
      maxPrompts: 3,
      configPath: 'config.json',
    });
  });

  it('throws on missing config path', () => {
    expect(() => parseArgs([])).toThrow('Usage:');
  });

  it('throws on invalid --maxPrompts value', () => {
    expect(() => parseArgs(['--maxPrompts=abc', 'config.json'])).toThrow(
      'Invalid --maxPrompts value: abc',
    );
  });

  it('throws on negative --maxPrompts value', () => {
    expect(() => parseArgs(['--maxPrompts=-1', 'config.json'])).toThrow(
      'Invalid --maxPrompts value: -1',
    );
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--unknown=x', 'config.json'])).toThrow(
      'Unknown option: --unknown',
    );
  });
});

describe('loadCliConfig', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'load-cli-config-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should resolve prompt template includes relative to the config file', async () => {
    const configDir = join(tempDir, 'config');
    const cwdDir = join(tempDir, 'cwd');
    await mkdir(join(configDir, 'prompts'), { recursive: true });
    await mkdir(cwdDir, { recursive: true });
    process.chdir(cwdDir);

    await writeFile(
      join(configDir, 'prompts', 'shared.md'),
      'Shared guidance.',
    );
    await writeFile(
      join(configDir, 'config.json'),
      `${JSON.stringify(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'per-file',
            {
              filePattern: 'src/**/*.ts',
              promptTemplate:
                'Review {{file}} for issues.\n{{include:prompts/shared.md}}',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const config = await loadCliConfig({
      configPath: join(configDir, 'config.json'),
      verbose: false,
      maxPrompts: undefined,
    });
    const task = getPerFileTask(config);

    expect(config.outputDir).toBe(configDir);
    expect(task.basePath).toBe(configDir);
    await expect(buildPrompt(task, 'src/example.ts')).resolves.toContain(
      'Shared guidance.',
    );
  });

  it('should rebase a relative basePath against the config file directory', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'per-file',
          {
            filePattern: 'src/**/*.ts',
            promptTemplate: 'Review {{file}}',
            basePath: './prompts',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getPerFileTask(config).basePath).toBe(join(configDir, 'prompts'));
  });

  it('should preserve an absolute basePath', async () => {
    const configDir = join(tempDir, 'config');
    const absoluteBasePath = join(tempDir, 'absolute-prompts');
    await mkdir(configDir, { recursive: true });
    await mkdir(absoluteBasePath, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'per-file',
          {
            filePattern: 'src/**/*.ts',
            promptTemplate: 'Review {{file}}',
            basePath: absoluteBasePath,
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getPerFileTask(config).basePath).toBe(absoluteBasePath);
  });

  it('should resolve system prompt includes relative to the config file', async () => {
    const configDir = join(tempDir, 'config');
    const cwdDir = join(tempDir, 'cwd');
    await mkdir(join(configDir, 'partials'), { recursive: true });
    await mkdir(cwdDir, { recursive: true });
    process.chdir(cwdDir);

    await writeFile(
      join(configDir, 'partials', 'nested.md'),
      'Nested system instructions.',
    );
    await writeFile(
      join(configDir, 'system.md'),
      'System preface.\n{{include:partials/nested.md}}',
    );
    await writeFile(
      join(configDir, 'config.json'),
      `${JSON.stringify(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'per-file',
            {
              filePattern: 'src/**/*.ts',
              promptTemplate: 'Review {{file}}',
            },
          ],
          systemPrompt: 'Header\n{{include:system.md}}\nFooter',
        },
        null,
        2,
      )}\n`,
    );

    const config = await loadCliConfig({
      configPath: join(configDir, 'config.json'),
      verbose: false,
      maxPrompts: undefined,
    });

    expect(config.systemPrompt).toBe(
      'Header\nSystem preface.\nNested system instructions.\nFooter',
    );
  });
});

function getPerFileTask(config: AgenticLoopCliConfig): PerFileAgenticTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as PerFileAgenticTask;
}
