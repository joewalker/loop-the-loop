import { glob } from 'glob';

import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type { LoopState } from '../util/loop-state.js';
import {
  assertKnownProperties,
  assertOptionalString,
  assertOptionalStringArray,
  assertRequiredString,
  isRecord,
  normalizeTaskBasePath,
  type PromptGeneratorConfigContext,
} from './util/config.js';

/**
 * Configuration for a single loop task. Describes which files to process,
 * what prompt to send for each one, and where to write the report.
 */
export interface PerFileTask {
  /**
   * Glob pattern for files to process
   */
  filePattern: string;

  /**
   * Optional glob patterns to exclude
   */
  excludePatterns?: Array<string>;

  /**
   * How should we construct a prompt for the given file. During processing,
   * {{file}} is replaced with the file path.
   */
  promptTemplate: string;

  /**
   * Directory used to resolve `{{include:...}}` paths in `promptTemplate`.
   * Defaults to `process.cwd()` when not specified. Callers that load this
   * task from a config file should pass `path.dirname(configFilePath)` so
   * that includes are resolved relative to the config file rather than the
   * process working directory.
   */
  basePath?: string;
}

/**
 * Normalize per-file task config values loaded from JSON.
 */
export function normalizePerFileTaskConfig(
  config: unknown,
  context: PromptGeneratorConfigContext,
): PerFileTask {
  assertPerFileTaskConfig(config);
  return normalizeTaskBasePath(config, context);
}

/**
 * A PromptGenerator that works on a template that iterates over a subset of
 * files in the filesystem
 */
export class PerFilePromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'per-file';

  static async create(task: PerFileTask): Promise<PromptGenerator> {
    return new PerFilePromptGenerator(task);
  }

  readonly #task: PerFileTask;

  constructor(task: PerFileTask) {
    this.#task = task;
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const { filePattern, excludePatterns } = this.#task;
    const allFiles = await resolveFiles(filePattern, excludePatterns);

    for (const file of allFiles) {
      if (loopState.isOutstanding(file)) {
        const basePath = this.#task.basePath ?? process.cwd();
        const template = this.#task.promptTemplate;
        const prompt = await expandPrompt(template, basePath, { file });
        yield { id: file, prompt };
      }
    }
  }
}

/**
 * Resolve a glob pattern into an ordered list of file paths, excluding
 * any files that match the exclusion patterns.
 */
export async function resolveFiles(
  filePattern: string,
  excludePatterns?: Array<string>,
): Promise<Array<string>> {
  const files = await glob(filePattern, {
    ...(excludePatterns ? { ignore: excludePatterns } : {}),
    nodir: true,
  });

  // Sort for deterministic processing order
  files.sort();
  return files;
}

/**
 * Assert that an unknown value has the runtime shape required for a per-file
 * task config.
 */
function assertPerFileTaskConfig(value: unknown): asserts value is PerFileTask {
  if (!isRecord(value)) {
    throw new Error('per-file task config must be an object');
  }

  assertKnownProperties(
    value,
    ['filePattern', 'excludePatterns', 'promptTemplate', 'basePath'],
    'per-file',
  );
  assertRequiredString(value, 'filePattern', 'per-file.filePattern');
  assertRequiredString(value, 'promptTemplate', 'per-file.promptTemplate');
  assertOptionalString(value, 'basePath', 'per-file.basePath');
  assertOptionalStringArray(
    value,
    'excludePatterns',
    'per-file.excludePatterns',
  );
}
