import { glob } from 'glob';

import { expandIncludes } from '../util/expand-includes.js';
import type { LoopState } from '../util/loop-state.js';
import type { Prompt, PromptGenerator } from './prompt-generators.js';

/**
 * Configuration for a single agentic loop task. Describes which files to
 * process, what prompt to send for each one, and where to write the report.
 */
export interface PerFileAgenticTask {
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
   * Additional files to add to the prompt context
   */
  contextFiles?: Array<string>;

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
 * A PromptGenerator that works on a template that iterates over a subset of
 * files in the filesystem
 */
export class PerFilePromptGenerator implements PromptGenerator {
  readonly #task: PerFileAgenticTask;

  constructor(task: PerFileAgenticTask) {
    this.#task = task;
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const { filePattern, excludePatterns } = this.#task;
    const allFiles = await resolveFiles(filePattern, excludePatterns);

    for (const file of allFiles) {
      if (loopState.isOutstanding(file)) {
        yield {
          id: file,
          prompt: await buildPrompt(this.#task, file),
        };
      }
    }
  }
}

/**
 * Build the full prompt for a single file by substituting `{{file}}` in the
 * template and appending any context file references.
 */
export async function buildPrompt(
  task: PerFileAgenticTask,
  file: string,
): Promise<string> {
  let prompt = task.promptTemplate.replaceAll('{{file}}', file);

  if (task.contextFiles && task.contextFiles.length > 0) {
    prompt += '\n\nAdditional context files:\n';
    for (const contextFile of task.contextFiles) {
      prompt += `- ${contextFile}\n`;
    }
  }

  return expandIncludes(prompt, task.basePath ?? process.cwd());
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
