// @module-tag local

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BatchTask } from 'loop-the-loop/prompt-generators/batch';
import type { BugzillaTask } from 'loop-the-loop/prompt-generators/bugzilla';
import type { GitHubTask } from 'loop-the-loop/prompt-generators/github';
import type { GitLabTask } from 'loop-the-loop/prompt-generators/gitlab';
import type { JsonTask } from 'loop-the-loop/prompt-generators/json';
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

  it('should reject Bugzilla config without an object search', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              promptTemplate: 'Review {{id}}',
              basePath: './prompts',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search must be an object');
  });

  it('should reject Bugzilla config without a string promptTemplate', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: {},
              basePath: './prompts',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.promptTemplate must be a string');
  });

  it('should reject malformed Bugzilla search field values', async () => {
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
                components: 'DOM: Workers',
              },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search.components must be an array of strings');
  });

  it('should reject malformed Bugzilla search ids', async () => {
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
                ids: ['1'],
              },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow(
      'bugzilla.search.ids must be an array of positive integers',
    );
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

  it('should normalize GitLab task basePath relative to the config file', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'gitlab',
          {
            search: {
              project: 'gitlab-org/gitlab',
              state: 'opened',
            },
            promptTemplate: 'Review {{id}}',
            basePath: './prompts',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getGitLabTask(config).basePath).toBe(join(configDir, 'prompts'));
  });

  it('should normalize JSON task basePath relative to the config file', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'json',
          {
            dataFile: 'bugs.json',
            promptTemplate: 'Review {{id}}',
            basePath: './data',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getJsonTask(config).basePath).toBe(join(configDir, 'data'));
  });

  it('should normalize batch tasks and their nested source configs', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'batch',
          {
            source: [
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
                basePath: './bug-prompts',
              },
            ],
            summaryPromptTemplate: 'Summarize {{batchIds}}',
            reportFile: 'report.yaml',
            basePath: './summary-prompts',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    const batchTask = getBatchTask(config);
    expect(batchTask.basePath).toBe(join(configDir, 'summary-prompts'));

    if (!Array.isArray(batchTask.source)) {
      throw new TypeError('Expected a tuple source generator config');
    }

    const [, nestedTask] = batchTask.source;
    const bugzillaTask = nestedTask as BugzillaTask;
    const change = bugzillaTask.search.change;

    expect(bugzillaTask.basePath).toBe(join(configDir, 'bug-prompts'));
    expect(change?.from).toBeInstanceOf(Date);
    expect(change?.from.toISOString()).toBe('2025-01-15T00:00:00.000Z');
    expect(change?.to).toBeInstanceOf(Date);
    expect(change?.to.toISOString()).toBe('2025-02-15T00:00:00.000Z');
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

  it('should reject GitLab search config without a string project', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: {
                state: 'opened',
              },
              promptTemplate: 'Review {{id}}',
              basePath: './prompts',
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.search.project must be a string');
  });

  it('should reject malformed GitLab label filters', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: {
                project: 'gitlab-org/gitlab',
                labels: 'bug',
              },
              promptTemplate: 'Review {{id}}',
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.search.labels must be an array of strings');
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

  it('should reject GitHub task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: ['github', 'nope' as unknown as GitHubTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('github task config must be an object');
  });

  it('should reject GitHub config without a string promptTemplate', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'github',
            {
              search: { repository: 'octocat/Hello-World', query: 'is:open' },
            } as unknown as GitHubTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('github.promptTemplate must be a string');
  });

  it('should reject GitHub config with a non-string basePath', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'github',
            {
              search: { repository: 'octocat/Hello-World', query: 'is:open' },
              promptTemplate: 'Review {{id}}',
              basePath: 42,
            } as unknown as GitHubTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('github.basePath must be a string');
  });

  it('should reject GitHub config without an object search', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'github',
            {
              promptTemplate: 'Review {{id}}',
            } as unknown as GitHubTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('github.search must be an object');
  });

  it('should reject GitLab task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: ['gitlab', null as unknown as GitLabTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab task config must be an object');
  });

  it('should reject GitLab config without a string promptTemplate', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: { project: 'gitlab-org/gitlab' },
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.promptTemplate must be a string');
  });

  it('should reject GitLab config with a non-string basePath', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: { project: 'gitlab-org/gitlab' },
              promptTemplate: 'Review {{id}}',
              basePath: 7,
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.basePath must be a string');
  });

  it('should reject GitLab config without an object search', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              promptTemplate: 'Review {{id}}',
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.search must be an object');
  });

  it('should reject GitLab search with a non-integer perPage', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: {
                project: 'gitlab-org/gitlab',
                perPage: 2.5,
              },
              promptTemplate: 'Review {{id}}',
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.search.perPage must be an integer');
  });

  it('should reject Bugzilla task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: ['bugzilla', 'oops' as unknown as BugzillaTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla task config must be an object');
  });

  it('should reject Bugzilla config with a non-string basePath', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { product: 'Core' },
              promptTemplate: 'Review {{id}}',
              basePath: 3,
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.basePath must be a string');
  });

  it('should reject Bugzilla search ids containing a non-integer number', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { ids: [1.5] },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow(
      'bugzilla.search.ids must be an array of positive integers',
    );
  });

  it('should reject Bugzilla search ids containing a non-positive integer', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { ids: [0] },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow(
      'bugzilla.search.ids must be an array of positive integers',
    );
  });

  it('should accept Bugzilla search with valid advanced clauses', async () => {
    const configDir = join(tempDir, 'config');

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: [
          'bugzilla',
          {
            search: {
              advanced: [
                {
                  field: 'product',
                  matchType: 'equals',
                  value: 'Firefox',
                },
              ],
            },
            promptTemplate: 'Review {{id}}',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getBugzillaTask(config).search.advanced).toEqual([
      { field: 'product', matchType: 'equals', value: 'Firefox' },
    ]);
  });

  it('should reject Bugzilla search advanced that is not an array', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { advanced: 'nope' },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search.advanced must be an array');
  });

  it('should reject Bugzilla advanced clauses that are not objects', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { advanced: ['nope'] },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search.advanced[0] must be an object');
  });

  it('should reject Bugzilla advanced clauses missing a field', async () => {
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
                advanced: [{ matchType: 'equals', value: 'Firefox' }],
              },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search.advanced[0].field must be a string');
  });

  it('should reject Bugzilla search change that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { change: 'nope' },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search.change must be an object');
  });

  it('should reject Bugzilla search change missing the from date', async () => {
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
                  to: '2025-02-15',
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow(
      'bugzilla.search.change.from must be a yyyy-MM-dd date string',
    );
  });

  it('should reject GitLab search with a non-boolean dryRun', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: { project: 'gitlab-org/gitlab', dryRun: 'yes' },
              promptTemplate: 'Review {{id}}',
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.search.dryRun must be a boolean');
  });

  it('should reject GitLab search with a non-string state', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'gitlab',
            {
              search: { project: 'gitlab-org/gitlab', state: 42 },
              promptTemplate: 'Review {{id}}',
            } as unknown as GitLabTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('gitlab.search.state must be a string');
  });

  it('should reject Bugzilla search components containing non-strings', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'bugzilla',
            {
              search: { components: ['valid', 42] },
              promptTemplate: 'Review {{id}}',
            } as unknown as BugzillaTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla.search.components must be an array of strings');
  });

  it('should reject test task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'test',
            'oops' as unknown as { prompts: ReadonlyArray<string> },
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('test task config must be an object');
  });

  it('should reject test task config with non-string prompts', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'test',
            { prompts: [42] as unknown as ReadonlyArray<string> },
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('test.prompts must be an array of strings');
  });

  it('should normalize a valid test task config', async () => {
    const configDir = join(tempDir, 'config');

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'test',
        promptGenerator: ['test', { prompts: ['hello'] }],
      },
      join(configDir, 'config.json'),
    );

    if (!Array.isArray(config.promptGenerator)) {
      throw new TypeError('Expected a tuple prompt generator config');
    }
    expect(config.promptGenerator[0]).toBe('test');
  });

  it('should reject json task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: ['json', 'oops' as unknown as JsonTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('json task config must be an object');
  });

  it('should reject json task config that specifies neither data nor dataFile', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'json',
            {
              promptTemplate: 'Review {{id}}',
            } as unknown as JsonTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow(
      'json task config must specify exactly one of json.data or json.dataFile',
    );
  });

  it('should reject per-file task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: ['per-file', 'oops' as unknown as PerFileTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('per-file task config must be an object');
  });

  it('should reject batch task config that is not an object', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: ['batch', 'oops' as unknown as BatchTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('batch task config must be an object');
  });

  it('should reject batch task config missing source', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'batch',
            {
              summaryPromptTemplate: 'Summarize',
              reportFile: 'report.yaml',
            } as unknown as BatchTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('batch.source is required');
  });

  it('should reject batch task config with a non-integer batchSize', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'batch',
            {
              source: ['per-file', { filePattern: 'a', promptTemplate: 'b' }],
              summaryPromptTemplate: 'Summarize',
              reportFile: 'report.yaml',
              batchSize: 1.5,
            } as unknown as BatchTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('batch.batchSize must be a positive integer');
  });

  it('should reject batch task config with a non-positive batchSize', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'test',
          promptGenerator: [
            'batch',
            {
              source: ['per-file', { filePattern: 'a', promptTemplate: 'b' }],
              summaryPromptTemplate: 'Summarize',
              reportFile: 'report.yaml',
              batchSize: 0,
            } as unknown as BatchTask,
          ],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('batch.batchSize must be a positive integer');
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

function getGitLabTask(config: LoopCliConfig): GitLabTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as GitLabTask;
}

function getJsonTask(config: LoopCliConfig): JsonTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as JsonTask;
}

function getBatchTask(config: LoopCliConfig): BatchTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as BatchTask;
}
