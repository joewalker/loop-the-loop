import { glob } from 'glob';

import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type { LoopState } from '../util/loop-state.js';
import {
  assertKnownProperties,
  assertOptionalStringArray,
  assertRequiredString,
  isRecord,
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
}

/**
 * Normalize per-file task config values loaded from JSON.
 */
export function normalizePerFileTaskConfig(config: unknown): PerFileTask {
  assertPerFileTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that works on a template that iterates over a subset of
 * files in the filesystem. `basePath` is used to resolve `{{include:...}}`
 * macros in the prompt template and defaults to `process.cwd()`. CLI config
 * loading passes the config file's directory.
 */
export class PerFilePromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'per-file';

  static async create(
    task: PerFileTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new PerFilePromptGenerator(task, basePath);
  }

  readonly #task: PerFileTask;
  readonly #basePath: string;

  constructor(task: PerFileTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const { filePattern, excludePatterns } = this.#task;
    const allFiles = await resolveFiles(filePattern, excludePatterns);

    for (const file of allFiles) {
      if (loopState.isOutstanding(file)) {
        const template = this.#task.promptTemplate;
        const prompt = await expandPrompt(template, this.#basePath, { file });
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
    ['filePattern', 'excludePatterns', 'promptTemplate'],
    'per-file',
  );
  assertRequiredString(value, 'filePattern', 'per-file.filePattern');
  assertRequiredString(value, 'promptTemplate', 'per-file.promptTemplate');
  assertOptionalStringArray(
    value,
    'excludePatterns',
    'per-file.excludePatterns',
  );
}
