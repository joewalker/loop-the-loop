import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BugzillaTask } from 'loop-the-loop/prompt-generators/bugzilla';
import type { GitHubTask } from 'loop-the-loop/prompt-generators/github';
import type { PerFileTask } from 'loop-the-loop/prompt-generators/per-file';
import type { LoopCliConfig } from 'loop-the-loop/types';
import {
  loadCliConfig,
  normalizeCliConfig,
  parseArgs,
} from 'loop-the-loop/util/load-cli-config';
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

  it('should preserve Bugzilla search params when change is omitted', async () => {
    const configDir = join(tempDir, 'config');
    const search = { product: 'Core' };

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'bugzilla',
          {
            search,
            promptTemplate: 'Review {{id}}',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getBugzillaTask(config).search).toBe(search);
  });

  it('should normalize GitHub task basePath relative to the config file', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'github',
          {
            search: {
              repository: 'octocat/Hello-World',
              query: 'is:open label:bug',
            },
            promptTemplate: 'Review {{id}}',
            basePath: './prompts',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getGitHubTask(config).basePath).toBe(join(configDir, 'prompts'));
  });

  it('should reject GitHub search config without a string repository', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'github',
            {
              search: {
                query: 'is:open',
              },
              promptTemplate: 'Review {{id}}',
              basePath: './prompts',
            } as unknown as GitHubTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('github.search.repository must be a string');
  });

  it('should reject GitHub search config without a string query', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'github',
            {
              search: {
                repository: 'octocat/Hello-World',
              },
              promptTemplate: 'Review {{id}}',
              basePath: './prompts',
            } as unknown as GitHubTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('github.search.query must be a string');
  });

  it('should convert Bugzilla change date strings into Date objects', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    await writeFile(
      join(configDir, 'config.json'),
      `${JSON.stringify(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: {
                change: {
                  field: 'bug_status',
                  from: '2025-01-15',
                  to: '2025-02-15',
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'Review {{id}}',
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
    const change = getBugzillaTask(config).search.change;

    expect(change?.from).toBeInstanceOf(Date);
    expect(change?.from.toISOString()).toBe('2025-01-15T00:00:00.000Z');
    expect(change?.to).toBeInstanceOf(Date);
    expect(change?.to.toISOString()).toBe('2025-02-15T00:00:00.000Z');
  });

  it('should reject invalid Bugzilla change date strings', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    await writeFile(
      join(configDir, 'config.json'),
      `${JSON.stringify(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: {
                change: {
                  field: 'bug_status',
                  from: 'not-a-date',
                  to: '2025-02-15',
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'Review {{id}}',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      loadCliConfig({
        configPath: join(configDir, 'config.json'),
        verbose: false,
        maxPrompts: undefined,
      }),
    ).rejects.toThrow(
      'search.change.from must be a valid yyyy-MM-dd date string: not-a-date',
    );
  });

  it('should reject invalid Bugzilla change to-date strings', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    await writeFile(
      join(configDir, 'config.json'),
      `${JSON.stringify(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: {
                change: {
                  field: 'bug_status',
                  from: '2025-01-15',
                  to: '2025-02-31',
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'Review {{id}}',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      loadCliConfig({
        configPath: join(configDir, 'config.json'),
        verbose: false,
        maxPrompts: undefined,
      }),
    ).rejects.toThrow(
      'search.change.to must be a valid yyyy-MM-dd date string: 2025-02-31',
    );
  });

  it('should throw a clear error for malformed JSON', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, '{ not valid json');

    await expect(
      loadCliConfig({
        configPath,
        verbose: false,
        maxPrompts: undefined,
      }),
    ).rejects.toThrow(`Failed to parse config file: ${configPath}`);
  });

  it('should preserve a pre-constructed promptGenerator instance', async () => {
    const generator = { generate: async function* () {} };
    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: generator,
      },
      join(tempDir, 'config.json'),
    );

    expect(config.promptGenerator).toBe(generator);
  });

  it('should preserve an explicit outputDir', async () => {
    const configDir = join(tempDir, 'config');
    const outputDir = join(tempDir, 'custom-output');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        outputDir,
        promptGenerator: [
          'per-file',
          { filePattern: '**/*.ts', promptTemplate: 'Review {{file}}' },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(config.outputDir).toBe(outputDir);
  });

  it('should accept a Bugzilla change date already parsed as a Date', async () => {
    const configDir = join(tempDir, 'config');
    const from = new Date(Date.UTC(2025, 0, 15));
    const to = new Date(Date.UTC(2025, 1, 15));

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'bugzilla',
          {
            search: {
              change: {
                field: 'bug_status',
                from,
                to,
                value: 'RESOLVED',
              },
            },
            promptTemplate: 'Review {{id}}',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    const change = getBugzillaTask(config).search.change;
    expect(change?.from).toBe(from);
    expect(change?.to).toBe(to);
  });

  it('should reject a non-string non-Date Bugzilla change field', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: {
                change: {
                  field: 'bug_status',
                  from: 12345 as unknown as Date,
                  to: '2025-02-15' as unknown as Date,
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'Review {{id}}',
            },
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('search.change.from must be a yyyy-MM-dd date string');
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

function getPerFileTask(config: LoopCliConfig): PerFileTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as PerFileTask;
}

function getBugzillaTask(config: LoopCliConfig): BugzillaTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as BugzillaTask;
}

function getGitHubTask(config: LoopCliConfig): GitHubTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as GitHubTask;
}
