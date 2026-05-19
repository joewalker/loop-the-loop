// @module-tag local

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSpec } from 'loop-the-loop/agents';
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

  // #region Case-insensitive flag names

  it('accepts --max-prompts in kebab-case', () => {
    expect(parseArgs(['--max-prompts=5', 'config.json']).maxPrompts).toEqual(5);
  });

  it('accepts --max_prompts in snake_case', () => {
    expect(parseArgs(['--max_prompts=5', 'config.json']).maxPrompts).toEqual(5);
  });

  it('accepts --MaxPrompts in PascalCase', () => {
    expect(parseArgs(['--MaxPrompts=5', 'config.json']).maxPrompts).toEqual(5);
  });

  it('accepts --MAX_PROMPTS in SCREAMING_SNAKE_CASE', () => {
    expect(parseArgs(['--MAX_PROMPTS=5', 'config.json']).maxPrompts).toEqual(5);
  });

  it('accepts --VERBOSE in any case', () => {
    expect(parseArgs(['--VERBOSE', 'config.json']).verbose).toBe(true);
  });

  // #endregion

  // #region Space-separated value form

  it('accepts --max-prompts followed by a separate value arg', () => {
    expect(parseArgs(['--max-prompts', '5', 'config.json']).maxPrompts).toEqual(
      5,
    );
  });

  it('accepts space-separated max-prompts in any case', () => {
    expect(parseArgs(['--MaxPrompts', '7', 'config.json']).maxPrompts).toEqual(
      7,
    );
  });

  it('throws when --max-prompts is not followed by a value', () => {
    expect(() => parseArgs(['--max-prompts'])).toThrow(
      'Option --max-prompts requires a value',
    );
  });

  it('throws when --max-prompts is followed by another flag', () => {
    expect(() =>
      parseArgs(['--max-prompts', '--verbose', 'config.json']),
    ).toThrow('Option --max-prompts requires a value');
  });

  // #endregion

  // #region Order independence

  it('parses flags interleaved before and after the positional arg', () => {
    expect(
      parseArgs(['--verbose', 'config.json', '--max-prompts=2']),
    ).toMatchObject({
      verbose: true,
      maxPrompts: 2,
      configPath: 'config.json',
    });
  });

  it('parses flags after the positional arg', () => {
    expect(
      parseArgs(['config.json', '--max-prompts=2', '--verbose']),
    ).toMatchObject({
      verbose: true,
      maxPrompts: 2,
      configPath: 'config.json',
    });
  });

  // #endregion

  // #region --dry-run

  it('dryRun defaults to false', () => {
    expect(parseArgs(['config.json']).dryRun).toBe(false);
  });

  it('sets dryRun when --dry-run is present', () => {
    expect(parseArgs(['--dry-run', 'config.json']).dryRun).toBe(true);
  });

  it('accepts --dry-run after the config path', () => {
    expect(parseArgs(['config.json', '--dry-run']).dryRun).toBe(true);
  });

  it('accepts --dryRun in camelCase', () => {
    expect(parseArgs(['--dryRun', 'config.json']).dryRun).toBe(true);
  });

  it('accepts --dry_run in snake_case', () => {
    expect(parseArgs(['--dry_run', 'config.json']).dryRun).toBe(true);
  });

  it('accepts --DRY-RUN in upper case', () => {
    expect(parseArgs(['--DRY-RUN', 'config.json']).dryRun).toBe(true);
  });

  // #endregion

  it('throws when --verbose is given a value', () => {
    expect(() => parseArgs(['--verbose=true', 'config.json'])).toThrow(
      'Option --verbose does not take a value',
    );
  });

  it('throws when --dry-run is given a value', () => {
    expect(() => parseArgs(['--dry-run=true', 'config.json'])).toThrow(
      'Option --dry-run does not take a value',
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
          agent: 'claude-sdk',
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

    expect(config.outputDir).toBe(configDir);
    expect(getSpecBasePath(config)).toBe(configDir);
  });

  it('should resolve claude-sdk systemPrompt includes relative to the config file', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(join(configDir, 'prompts'), { recursive: true });
    await writeFile(
      join(configDir, 'prompts', 'system.md'),
      'Shared system guidance.',
    );

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: [
          'claude-sdk',
          { systemPrompt: 'Header\n{{include:prompts/system.md}}\nFooter' },
        ],
        promptGenerator: ['test', { prompts: ['noop'] }],
      },
      join(configDir, 'config.json'),
    );

    if (!Array.isArray(config.agent) || config.agent[0] !== 'claude-sdk') {
      throw new TypeError('Expected a claude-sdk agent tuple');
    }
    expect(config.agent[1]?.systemPrompt).toBe(
      'Header\nShared system guidance.\nFooter',
    );
  });

  it('should pass through a claude-sdk agent spec with no systemPrompt', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const agent: AgentSpec = ['claude-sdk', { maxTurns: 7 }];
    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent,
        promptGenerator: ['test', { prompts: ['noop'] }],
      },
      join(configDir, 'config.json'),
    );

    expect(config.agent).toBe(agent);
  });

  it('should preserve Bugzilla search params when change is omitted', async () => {
    const configDir = join(tempDir, 'config');
    const search = { product: 'Core' };

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
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
          agent: 'claude-sdk',
          promptGenerator: [
            'bugzilla',
            {
              promptTemplate: 'Review {{id}}',
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
          agent: 'claude-sdk',
          promptGenerator: [
            'bugzilla',
            {
              search: {},
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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

  it('should normalize batch tasks and their nested source configs', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
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
              },
            ],
            summaryPromptTemplate: 'Summarize {{batchIds}}',
            reportFile: 'report.yaml',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getSpecBasePath(config)).toBe(configDir);

    const batchTask = getBatchTask(config);
    if (!Array.isArray(batchTask.source)) {
      throw new TypeError('Expected a tuple source generator config');
    }

    const [, nestedTask, nestedBasePath] = batchTask.source as [
      string,
      BugzillaTask,
      string?,
    ];
    const change = nestedTask.search.change;

    expect(nestedBasePath).toBe(configDir);
    expect(change?.from).toBeInstanceOf(Date);
    expect(change?.from.toISOString()).toBe('2025-01-15T00:00:00.000Z');
    expect(change?.to).toBeInstanceOf(Date);
    expect(change?.to.toISOString()).toBe('2025-02-15T00:00:00.000Z');
  });

  it('should accept a valid GitHub task config', async () => {
    const configDir = join(tempDir, 'config');

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
        promptGenerator: [
          'github',
          {
            search: {
              repository: 'octocat/Hello-World',
              query: 'is:open',
            },
            promptTemplate: 'Review {{id}}',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getSpecBasePath(config)).toBe(configDir);
  });

  it('should accept a valid JSON task config with dataFile', async () => {
    const configDir = join(tempDir, 'config');

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
        promptGenerator: [
          'json',
          {
            dataFile: 'bugs.json',
            promptTemplate: 'Review {{id}}',
          },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(getSpecBasePath(config)).toBe(configDir);
  });

  it('should reject GitHub search config without a string repository', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'claude-sdk',
          promptGenerator: [
            'github',
            {
              search: {
                query: 'is:open',
              },
              promptTemplate: 'Review {{id}}',
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
          agent: 'claude-sdk',
          promptGenerator: [
            'github',
            {
              search: {
                repository: 'octocat/Hello-World',
              },
              promptTemplate: 'Review {{id}}',
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
          agent: 'claude-sdk',
          promptGenerator: [
            'gitlab',
            {
              search: {
                state: 'opened',
              },
              promptTemplate: 'Review {{id}}',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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

  it('should throw a clear error for malformed JSON that includes the parser detail', async () => {
    const configDir = join(tempDir, 'config');
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, '{ not valid json');

    let caught: unknown;
    try {
      await loadCliConfig({
        configPath,
        verbose: false,
        maxPrompts: undefined,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain(
      `Failed to parse config file: ${configPath}`,
    );
    // The original SyntaxError from JSON.parse should be surfaced, both in
    // the message (so it shows up in CLI output) and via `cause` (so callers
    // can inspect the underlying error programmatically).
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.message).toContain((error.cause as Error).message);
  });

  it('should preserve a pre-constructed promptGenerator instance', async () => {
    const generator = { generate: async function* () {} };
    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
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
        agent: 'claude-sdk',
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

  it('should resolve a relative outputDir against the config file directory', async () => {
    const configDir = join(tempDir, 'config');
    const cwdDir = join(tempDir, 'cwd');
    await mkdir(configDir, { recursive: true });
    await mkdir(cwdDir, { recursive: true });
    process.chdir(cwdDir);

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
        outputDir: 'reports',
        promptGenerator: [
          'per-file',
          { filePattern: '**/*.ts', promptTemplate: 'Review {{file}}' },
        ],
      },
      join(configDir, 'config.json'),
    );

    expect(config.outputDir).toBe(join(configDir, 'reports'));
  });

  it('should accept a Bugzilla change date already parsed as a Date', async () => {
    const configDir = join(tempDir, 'config');
    const from = new Date(Date.UTC(2025, 0, 15));
    const to = new Date(Date.UTC(2025, 1, 15));

    const config = await normalizeCliConfig(
      {
        name: 'test',
        agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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

  it('should reject GitHub config without an object search', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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

  it('should reject GitLab config without an object search', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
          promptGenerator: ['bugzilla', 'oops' as unknown as BugzillaTask],
        },
        join(configDir, 'config.json'),
      ),
    ).rejects.toThrow('bugzilla task config must be an object');
  });

  it('should reject Bugzilla search ids containing a non-integer number', async () => {
    const configDir = join(tempDir, 'config');

    await expect(
      normalizeCliConfig(
        {
          name: 'test',
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
        agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
        agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
          agent: 'claude-sdk',
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
});

function getBugzillaTask(config: LoopCliConfig): BugzillaTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as BugzillaTask;
}

function getBatchTask(config: LoopCliConfig): BatchTask {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  const [, task] = config.promptGenerator;
  return task as BatchTask;
}

/**
 * Return the basePath that `normalizePromptGeneratorSpec` appended as the
 * third tuple element. Generators that take no basePath omit it.
 */
function getSpecBasePath(config: LoopCliConfig): string | undefined {
  if (!Array.isArray(config.promptGenerator)) {
    throw new TypeError('Expected a tuple prompt generator config');
  }

  return config.promptGenerator[2] as string | undefined;
}
