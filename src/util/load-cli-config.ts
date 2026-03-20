import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { BugzillaAgenticTask } from '../prompt-generators/bugzilla.js';
import type { PerFileAgenticTask } from '../prompt-generators/per-file.js';
import type { AgenticLoopCliConfig } from '../types.js';
import { expandIncludes } from './expand-includes.js';

/**
 * Load a CLI JSON config file and normalize paths that should be interpreted
 * relative to the config file itself.
 */
export async function loadCliConfig(
  configPath: string,
): Promise<AgenticLoopCliConfig> {
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, 'utf-8');

  let config: AgenticLoopCliConfig;
  try {
    config = JSON.parse(raw) as AgenticLoopCliConfig;
  } catch {
    throw new Error(`Failed to parse config file: ${resolvedPath}`);
  }

  return normalizeCliConfig(config, resolvedPath);
}

/**
 * Normalize a parsed CLI config so includes in JSON-defined prompt templates
 * and system prompts are resolved relative to the config file directory.
 */
export async function normalizeCliConfig(
  config: AgenticLoopCliConfig,
  configPath: string,
): Promise<AgenticLoopCliConfig> {
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
    promptGenerator: normalizePromptGenerator(config.promptGenerator, configDir),
  };
}

function normalizePromptGenerator(
  promptGenerator: AgenticLoopCliConfig['promptGenerator'],
  configDir: string,
): AgenticLoopCliConfig['promptGenerator'] {
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

function isPerFileTaskConfig(value: unknown): value is PerFileAgenticTask {
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

function isBugzillaTaskConfig(value: unknown): value is BugzillaAgenticTask {
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
