import type { CheckResult } from './doctor.js';
import type { LoopState } from './loop-states.js';
import {
  BatchPromptGenerator,
  type BatchTask,
  normalizeBatchTaskConfig,
} from './prompt-generators/batch.js';
import { BugzillaPromptGenerator } from './prompt-generators/bugzilla.js';
import { normalizeBugzillaTaskConfig } from './prompt-generators/bugzilla/config.js';
import { GitHubPromptGenerator } from './prompt-generators/github.js';
import { normalizeGitHubTaskConfig } from './prompt-generators/github/config.js';
import { GitLabPromptGenerator } from './prompt-generators/gitlab.js';
import { normalizeGitLabTaskConfig } from './prompt-generators/gitlab/config.js';
import { JsonPromptGenerator } from './prompt-generators/json.js';
import { normalizeJsonTaskConfig } from './prompt-generators/json.js';
import {
  LoopStatePromptGenerator,
  normalizeLoopStateTaskConfig,
} from './prompt-generators/loop-state.js';
import {
  normalizePerFileTaskConfig,
  PerFilePromptGenerator,
} from './prompt-generators/per-file.js';
import {
  normalizeTestTaskConfig,
  TestPromptGenerator,
} from './prompt-generators/test.js';
import type { PromptGeneratorConfigContext } from './prompt-generators/util/config.js';

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
 * skipped on resume. `isOutstanding()` reflects terminal results only; active
 * claim arbitration happens in the loop runner.
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
 *
 * Under `concurrency > 1`, multiple yielded items may be in flight at once.
 * Generators must yield each id exactly once per run and must not rely on
 * `isOutstanding` reflecting items yielded earlier in the same run.
 */
export interface PromptGenerator {
  /**
   * Yield prompts for the loop to process. Called once per run.
   * Use `loopState.isOutstanding(id)` to skip previously processed items.
   */
  generate(loopState: LoopState): AsyncIterable<Prompt>;

  /**
   * Optional preflight probe used by `--doctor` (see Agent.check).
   */
  check?(): AsyncIterable<CheckResult>;
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
  [LoopStatePromptGenerator.promptGeneratorName]:
    LoopStatePromptGenerator.create,
  [PerFilePromptGenerator.promptGeneratorName]: PerFilePromptGenerator.create,
  [TestPromptGenerator.promptGeneratorName]: TestPromptGenerator.create,
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
  | [typeof BatchPromptGenerator.promptGeneratorName, BatchTask, string?];

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
 * The returned spec appends `context.configDir` as a third tuple element so
 * that `createPromptGenerator` can pass it to the generator factory as the
 * `basePath` used for resolving `{{include:...}}` macros. Programmatic
 * callers that bypass normalization fall back to `process.cwd()` inside the
 * generator factory.
 */
export function normalizePromptGeneratorSpec(
  promptGeneratorSpec: PromptGeneratorSpec,
  context: PromptGeneratorConfigContext,
): PromptGeneratorSpec {
  if (!Array.isArray(promptGeneratorSpec)) {
    return promptGeneratorSpec;
  }

  const [type, config] = promptGeneratorSpec;
  const { configDir } = context;

  if (type === BatchPromptGenerator.promptGeneratorName) {
    return [
      type,
      normalizeBatchTaskConfig(config, source =>
        normalizePromptGeneratorSpec(source as PromptGeneratorSpec, context),
      ),
      configDir,
    ];
  }

  if (type === BugzillaPromptGenerator.promptGeneratorName) {
    return [type, normalizeBugzillaTaskConfig(config), configDir];
  }

  if (type === GitHubPromptGenerator.promptGeneratorName) {
    return [type, normalizeGitHubTaskConfig(config), configDir];
  }

  if (type === GitLabPromptGenerator.promptGeneratorName) {
    return [type, normalizeGitLabTaskConfig(config), configDir];
  }

  if (type === JsonPromptGenerator.promptGeneratorName) {
    return [type, normalizeJsonTaskConfig(config), configDir];
  }

  if (type === LoopStatePromptGenerator.promptGeneratorName) {
    return [type, normalizeLoopStateTaskConfig(config), configDir];
  }

  if (type === PerFilePromptGenerator.promptGeneratorName) {
    return [type, normalizePerFileTaskConfig(config), configDir];
  }

  /* istanbul ignore else */
  if (type === TestPromptGenerator.promptGeneratorName) {
    return [type, normalizeTestTaskConfig(config)];
  }

  /* istanbul ignore next */
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
      const [task, basePath] = args as [BatchTask, string?];
      return BatchPromptGenerator.create(
        task,
        spec => createPromptGenerator(spec as PromptGeneratorSpec),
        basePath,
      );
    }
    const creator = promptGeneratorCreators[type] as PromptGeneratorCreator;
    return creator(...args);
  }

  return promptGeneratorSpec;
}
