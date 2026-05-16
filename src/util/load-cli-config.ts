import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { BugzillaTask } from '../prompt-generators/bugzilla.js';
import type { GitHubTask } from '../prompt-generators/github.js';
import type { PerFileTask } from '../prompt-generators/per-file.js';
import type { LoopCliConfig } from '../types.js';
import { expandIncludes } from './expand-prompt.js';

/**
 * These are the properties that parseArgs understands
 */
export interface ParsedArgs {
  readonly configPath: string;
  readonly verbose?: boolean | undefined;
  readonly maxPrompts?: number | undefined;
}

/**
 * Simple `process.argv.slice(2)` parsing to turn an array of strings into
 * a ParsedArgs object which describes how to act
 */
export function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const verbose = args.includes('--verbose');
  const positional: Array<string> = [];
  let maxPrompts: number | undefined;

  for (const arg of args) {
    if (arg === '--verbose') {
      continue;
    }
    const match = arg.match(/^--(\w+)=(.+)$/u); // eslint-disable-line @typescript-eslint/prefer-regexp-exec
    if (match) {
      const [, key, value] = match;
      if (key === 'maxPrompts') {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 0) {
          throw new Error(`Invalid --maxPrompts value: ${value}`);
        }
        maxPrompts = n;
      } else {
        throw new Error(`Unknown option: --${key}`);
      }
    } else {
      positional.push(arg);
    }
  }

  const configPath = positional[0];
  if (!configPath) {
    throw new Error(
      'Usage: loop-the-loop [--verbose] [--maxPrompts=N] <config.json>',
    );
  }

  return {
    configPath,
    verbose,
    maxPrompts,
  };
}

/**
 * Load a CLI JSON config file and normalize paths that should be interpreted
 * relative to the config file itself.
 */
export async function loadCliConfig(
  parsedArgs: ParsedArgs,
): Promise<LoopCliConfig> {
  const { configPath, maxPrompts, verbose } = parsedArgs;
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, 'utf-8');

  let config: LoopCliConfig;
  try {
    config = JSON.parse(raw) as LoopCliConfig;
  } catch {
    throw new Error(`Failed to parse config file: ${resolvedPath}`);
  }

  return {
    ...(await normalizeCliConfig(config, resolvedPath)),
    ...(maxPrompts !== undefined ? { maxPrompts } : {}),
    ...(verbose ? { logger: 'verbose' as const } : {}),
  };
}

/**
 * Normalize a parsed CLI config so includes in JSON-defined prompt templates
 * and system prompts are resolved relative to the config file directory.
 */
export async function normalizeCliConfig(
  config: LoopCliConfig,
  configPath: string,
): Promise<LoopCliConfig> {
  const resolvedPath = resolve(configPath);
  const configDir = dirname(resolvedPath);

  return {
    ...config,
    ...(config.outputDir === undefined ? { outputDir: configDir } : {}),
    ...(config.systemPrompt !== undefined
      ? {
          systemPrompt: await expandIncludes(config.systemPrompt, configDir),
        }
      : {}),
    promptGenerator: normalizePromptGenerator(
      config.promptGenerator,
      configDir,
    ),
  };
}

/**
 * Normalize prompt-generator config values that need CLI-specific path or type
 * conversions.
 */
function normalizePromptGenerator(
  promptGenerator: LoopCliConfig['promptGenerator'],
  configDir: string,
): LoopCliConfig['promptGenerator'] {
  if (!Array.isArray(promptGenerator)) {
    return promptGenerator;
  }

  const [type, config] = promptGenerator;

  if (type === 'per-file' && isPerFileTaskConfig(config)) {
    return [
      type,
      {
        ...config,
        basePath: normalizeBasePath(config.basePath, configDir),
      },
    ];
  }

  if (type === 'bugzilla' && isBugzillaTaskConfig(config)) {
    return [type, normalizeBugzillaTaskConfig(config, configDir)];
  }

  if (type === 'github') {
    return [type, normalizeGitHubTaskConfig(config, configDir)];
  }

  return promptGenerator;
}

/**
 * Normalize Bugzilla task config values loaded from JSON.
 */
function normalizeBugzillaTaskConfig(
  config: BugzillaTask,
  configDir: string,
): BugzillaTask {
  return {
    ...config,
    basePath: normalizeBasePath(config.basePath, configDir),
    search: normalizeBugzillaSearchParams(config.search),
  };
}

/**
 * Normalize GitHub task config values loaded from JSON.
 */
function normalizeGitHubTaskConfig(
  config: unknown,
  configDir: string,
): GitHubTask {
  assertGitHubTaskConfig(config);

  return {
    ...config,
    basePath: normalizeBasePath(config.basePath, configDir),
  };
}

/**
 * Normalize Bugzilla search parameters loaded from JSON.
 */
function normalizeBugzillaSearchParams(
  search: BugzillaTask['search'],
): BugzillaTask['search'] {
  if (search.change === undefined) {
    return search;
  }

  return {
    ...search,
    change: {
      ...search.change,
      from: parseDateField(search.change.from, 'search.change.from'),
      to: parseDateField(search.change.to, 'search.change.to'),
    },
  };
}

/**
 * Parse a JSON date field as a UTC yyyy-MM-dd date.
 */
function parseDateField(value: unknown, field: string): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a yyyy-MM-dd date string`);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    throw new Error(
      `${field} must be a valid yyyy-MM-dd date string: ${value}`,
    );
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      `${field} must be a valid yyyy-MM-dd date string: ${value}`,
    );
  }

  return date;
}

/**
 * Resolve a possibly relative base path against the config file directory.
 */
function normalizeBasePath(
  basePath: string | undefined,
  configDir: string,
): string {
  if (basePath === undefined) {
    return configDir;
  }

  return isAbsolute(basePath) ? basePath : resolve(configDir, basePath);
}

/**
 * Check whether an unknown value has the shape of a per-file task config.
 */
function isPerFileTaskConfig(value: unknown): value is PerFileTask {
  return (
    typeof value === 'object' &&
    value !== null &&
    'filePattern' in value &&
    typeof value.filePattern === 'string' &&
    'promptTemplate' in value &&
    typeof value.promptTemplate === 'string' &&
    (!('basePath' in value) || typeof value.basePath === 'string')
  );
}

/**
 * Check whether an unknown value has the shape of a Bugzilla task config.
 */
function isBugzillaTaskConfig(value: unknown): value is BugzillaTask {
  return (
    typeof value === 'object' &&
    value !== null &&
    'search' in value &&
    typeof value.search === 'object' &&
    value.search !== null &&
    'promptTemplate' in value &&
    typeof value.promptTemplate === 'string' &&
    (!('basePath' in value) || typeof value.basePath === 'string')
  );
}

/**
 * Check whether an unknown value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assert that an unknown value has the runtime shape required for a GitHub
 * task config.
 */
function assertGitHubTaskConfig(value: unknown): asserts value is GitHubTask {
  if (!isRecord(value)) {
    throw new Error('github task config must be an object');
  }

  if (
    !('promptTemplate' in value) ||
    typeof value['promptTemplate'] !== 'string'
  ) {
    throw new Error('github.promptTemplate must be a string');
  }

  if ('basePath' in value && typeof value['basePath'] !== 'string') {
    throw new Error('github.basePath must be a string');
  }

  const search = value['search'];
  if (!isRecord(search)) {
    throw new Error('github.search must be an object');
  }

  if (!('repository' in search) || typeof search['repository'] !== 'string') {
    throw new Error('github.search.repository must be a string');
  }

  if (!('query' in search) || typeof search['query'] !== 'string') {
    throw new Error('github.search.query must be a string');
  }
}
