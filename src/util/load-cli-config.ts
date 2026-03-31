import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { BugzillaTask } from '../prompt-generators/bugzilla.js';
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
    return [
      type,
      {
        ...config,
        basePath: normalizeBasePath(config.basePath, configDir),
      },
    ];
  }

  return promptGenerator;
}

function normalizeBasePath(
  basePath: string | undefined,
  configDir: string,
): string {
  if (basePath === undefined) {
    return configDir;
  }

  return isAbsolute(basePath) ? basePath : resolve(configDir, basePath);
}

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
