import {
  BatchPromptGenerator,
  type BatchTask,
  normalizeBatchTaskConfig,
} from './prompt-generators/batch.js';
import { BugzillaPromptGenerator } from './prompt-generators/bugzilla.js';
import { normalizeBugzillaTaskConfig } from './prompt-generators/bugzilla/config.js';
import type { PromptGeneratorConfigContext } from './prompt-generators/config.js';
import { GitHubPromptGenerator } from './prompt-generators/github.js';
import { normalizeGitHubTaskConfig } from './prompt-generators/github/config.js';
import { GitLabPromptGenerator } from './prompt-generators/gitlab.js';
import { normalizeGitLabTaskConfig } from './prompt-generators/gitlab/config.js';
import { JsonPromptGenerator } from './prompt-generators/json.js';
import { normalizeJsonTaskConfig } from './prompt-generators/json.js';
import {
  normalizePerFileTaskConfig,
  PerFilePromptGenerator,
} from './prompt-generators/per-file.js';
import type { LoopState } from './util/loop-state.js';

/**
 * A prompt is basically just a string that we pass to an agent to kick off
 * some work. In addition to the prompt string, we also store an id for
 * tracking / debugging purposes.
 */
export interface Prompt {
  /**
   * Unique identifier which could be useful in debugging to quickly identify
   * a prompt that is causing problems. Likely to be a bug-id, filename, index
   * into an array, etc.
   * Typically we won't be able to use the prompt as an identifier due to its
   * length and the likelihood that the unique part will be embedded deep in
   * the prompt.
   */
  readonly id: string;

  /**
   * The initial text to send to the agent
   */
  readonly prompt: string;
}

/**
 * A PromptGenerator is a source of prompts for the main loop.
 *
 * The loop calls `generate()` once per run, iterating over the yielded
 * prompts sequentially. Generators should check `loopState.isOutstanding(id)`
 * before yielding a prompt so that already-completed or failed items are
 * skipped on resume.
 *
 * To create a custom prompt generator:
 *
 * 1. Create a class that implements this interface with an async generator
 *    `generate()` method.
 * 2. Add a static `promptGeneratorName` string and a static async
 *    `create(config)` factory method.
 * 3. Register it in the `promptGeneratorCreators` map in this file.
 *
 * See `PerFilePromptGenerator` and `BugzillaPromptGenerator` for reference
 * implementations.
 */
export interface PromptGenerator {
  /**
   * Yield prompts for the loop to process. Called once per run.
   * Use `loopState.isOutstanding(id)` to skip previously processed items.
   */
  generate(loopState: LoopState): AsyncIterable<Prompt>;
}

/**
 * Pattern for an async creator function for PromptGenerators so we can
 * register a library of PromptGeneratorCreators to allow easy command line
 * configuration.
 */
export type PromptGeneratorCreator = (
  ...args: Array<any>
) => Promise<PromptGenerator>;

/**
 * To add a new built-in PromptGenerator, add it in here.
 *
 * Note: BatchPromptGenerator is handled separately in createPromptGenerator
 * below because its source spec creates a circular type dependency if it is
 * registered here.
 */
const promptGeneratorCreators = {
  [BugzillaPromptGenerator.promptGeneratorName]: BugzillaPromptGenerator.create,
  [GitHubPromptGenerator.promptGeneratorName]: GitHubPromptGenerator.create,
  [GitLabPromptGenerator.promptGeneratorName]: GitLabPromptGenerator.create,
  [JsonPromptGenerator.promptGeneratorName]: JsonPromptGenerator.create,
  [PerFilePromptGenerator.promptGeneratorName]: PerFilePromptGenerator.create,
} satisfies Record<string, PromptGeneratorCreator>;

type PromptGeneratorCreators = typeof promptGeneratorCreators;
type PromptGeneratorName = keyof PromptGeneratorCreators;
type PromptGeneratorConfig =
  | {
      [T in PromptGeneratorName]: [
        T,
        ...Parameters<PromptGeneratorCreators[T]>,
      ];
    }[PromptGeneratorName]
  | [typeof BatchPromptGenerator.promptGeneratorName, BatchTask];

/**
 * To specify a PromptGenerator in a config file, pass either:
 * - a PromptGenerator instance
 * - an array where the first element is the PromptGeneratorName (i.e.
 *   'bugzilla', 'per-file', etc) and subsequent parameters are then passed to
 *   the creator function for that type of PromptGenerator.
 * PromptGeneratorSpec defines these options.
 */
export type PromptGeneratorSpec = PromptGenerator | PromptGeneratorConfig;

/**
 * Enable unit tests to know what prompt generators are available
 */
export const promptGeneratorTypes = [
  ...Object.keys(promptGeneratorCreators),
  BatchPromptGenerator.promptGeneratorName,
];

/**
 * Normalize prompt-generator config values loaded from a CLI JSON config.
 */
export function normalizePromptGeneratorSpec(
  promptGeneratorSpec: PromptGeneratorSpec,
  context: PromptGeneratorConfigContext,
): PromptGeneratorSpec {
  if (!Array.isArray(promptGeneratorSpec)) {
    return promptGeneratorSpec;
  }

  const [type, config] = promptGeneratorSpec;

  if (type === BatchPromptGenerator.promptGeneratorName) {
    return [
      type,
      normalizeBatchTaskConfig(config, context, source =>
        normalizePromptGeneratorSpec(source as PromptGeneratorSpec, context),
      ),
    ];
  }

  if (type === BugzillaPromptGenerator.promptGeneratorName) {
    return [type, normalizeBugzillaTaskConfig(config, context)];
  }

  if (type === GitHubPromptGenerator.promptGeneratorName) {
    return [type, normalizeGitHubTaskConfig(config, context)];
  }

  if (type === GitLabPromptGenerator.promptGeneratorName) {
    return [type, normalizeGitLabTaskConfig(config, context)];
  }

  if (type === JsonPromptGenerator.promptGeneratorName) {
    return [type, normalizeJsonTaskConfig(config, context)];
  }

  if (type === PerFilePromptGenerator.promptGeneratorName) {
    return [type, normalizePerFileTaskConfig(config, context)];
  }

  return promptGeneratorSpec;
}

/**
 * Allow easy switching between different PromptGenerator types
 */
export async function createPromptGenerator(
  promptGeneratorSpec: PromptGeneratorSpec,
): Promise<PromptGenerator> {
  if (Array.isArray(promptGeneratorSpec)) {
    const [type, ...args] = promptGeneratorSpec;
    if (type === BatchPromptGenerator.promptGeneratorName) {
      const [task] = args as [BatchTask];
      return BatchPromptGenerator.create(task, spec =>
        createPromptGenerator(spec as PromptGeneratorSpec),
      );
    }
    const creator = promptGeneratorCreators[type] as PromptGeneratorCreator;
    return creator(...args);
  }

  return promptGeneratorSpec;
}
