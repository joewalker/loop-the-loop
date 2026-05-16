import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type { LoopState } from '../util/loop-state.js';
import {
  assertKnownProperties,
  assertOptionalString,
  assertRequiredString,
  isRecord,
  normalizeBasePath,
  type PromptGeneratorConfigContext,
} from './util/config.js';

const DEFAULT_BATCH_SIZE = 50;

/**
 * Configuration for a prompt generator that wraps a source generator and
 * injects a summary prompt after every N items.
 */
export interface BatchTask {
  /**
   * The source generator to batch. Accepts the same PromptGeneratorSpec
   * format used in LoopCliConfig: either a PromptGenerator instance or a
   * [generatorName, ...args] tuple. Typed as `unknown` to avoid a circular
   * type dependency; the value is resolved via the injected `createSource`
   * factory in `BatchPromptGenerator.create`.
   */
  source: unknown;

  /**
   * Number of source prompts per batch. Default: 50.
   */
  batchSize?: number;

  /**
   * Template for the summary prompt injected after each batch.
   *
   * Available variables:
   * - `{{batchSize}}` - number of items in this batch
   * - `{{batchIds}}` - newline-separated list of item IDs in this batch
   * - `{{reportFile}}` - path to the loop's report file
   */
  summaryPromptTemplate: string;

  /**
   * Path to the report file the loop is writing to. Injected as
   * `{{reportFile}}` in the summary template so the agent can read batch
   * results directly.
   */
  reportFile: string;

  /**
   * Directory used to resolve `{{include:...}}` paths in
   * `summaryPromptTemplate`. Defaults to `process.cwd()` when not specified.
   * Callers that load this task from a config file should pass
   * `path.dirname(configFilePath)` so that includes are resolved relative to
   * the config file rather than the process working directory.
   */
  basePath?: string;
}

/**
 * Function used to normalize a batch source prompt-generator spec.
 */
export type BatchSourceNormalizer = (source: unknown) => unknown;

/**
 * Normalize batch task config values loaded from JSON.
 */
export function normalizeBatchTaskConfig(
  config: unknown,
  context: PromptGeneratorConfigContext,
  normalizeSource: BatchSourceNormalizer,
): BatchTask {
  assertBatchTaskConfig(config);

  return {
    ...config,
    source: normalizeSource(config.source),
    basePath: normalizeBasePath(config.basePath, context.configDir),
  };
}

/**
 * A PromptGenerator that wraps a source generator and processes its items
 * in fixed-size batches, injecting a summary prompt after each batch.
 * A final summary is also yielded for any leftover items at the end of the
 * source.
 *
 * Summary prompt IDs take the form `batch-summary-after-{lastItemId}`,
 * making them stable and trackable in LoopState across runs.
 */
export class BatchPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'batch';

  /**
   * Factory used by the prompt generator registry.
   *
   * @param task - configuration for this generator
   * @param createSource - factory for resolving `task.source` into a
   *   PromptGenerator; injected from `prompt-generators.ts` to avoid a
   *   circular module dependency at runtime.
   */
  static async create(
    task: BatchTask,
    createSource: (spec: unknown) => Promise<PromptGenerator>,
  ): Promise<PromptGenerator> {
    const source = await createSource(task.source);
    return new BatchPromptGenerator(task, source);
  }

  readonly #task: BatchTask;
  readonly #source: PromptGenerator;

  constructor(task: BatchTask, source: PromptGenerator) {
    this.#task = task;
    this.#source = source;
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const batchSize = this.#task.batchSize ?? DEFAULT_BATCH_SIZE;
    const basePath = this.#task.basePath ?? process.cwd();
    let batch: Array<Prompt> = [];

    for await (const item of this.#source.generate(loopState)) {
      batch.push(item);
      yield item;

      if (batch.length >= batchSize) {
        const summary = await this.#buildSummary(batch, loopState, basePath);
        if (summary !== undefined) {
          yield summary;
        }
        batch = [];
      }
    }

    if (batch.length > 0) {
      const summary = await this.#buildSummary(batch, loopState, basePath);
      if (summary !== undefined) {
        yield summary;
      }
    }
  }

  /**
   * Build the summary prompt for a completed batch, or return undefined if
   * the summary has already been completed in a previous run.
   */
  async #buildSummary(
    batch: ReadonlyArray<Prompt>,
    loopState: LoopState,
    basePath: string,
  ): Promise<Prompt | undefined> {
    const lastId = batch[batch.length - 1].id;
    const summaryId = `batch-summary-after-${lastId}`;

    if (!loopState.isOutstanding(summaryId)) {
      return undefined;
    }

    const prompt = await expandPrompt(
      this.#task.summaryPromptTemplate,
      basePath,
      {
        batchSize: String(batch.length),
        batchIds: batch.map(p => p.id).join('\n'),
        reportFile: this.#task.reportFile,
      },
    );

    return { id: summaryId, prompt };
  }
}

/**
 * Assert that an unknown value has the runtime shape required for a batch task
 * config.
 */
function assertBatchTaskConfig(value: unknown): asserts value is BatchTask {
  if (!isRecord(value)) {
    throw new Error('batch task config must be an object');
  }

  assertKnownProperties(
    value,
    ['source', 'batchSize', 'summaryPromptTemplate', 'reportFile', 'basePath'],
    'batch',
  );

  if (!('source' in value)) {
    throw new Error('batch.source is required');
  }

  assertRequiredString(
    value,
    'summaryPromptTemplate',
    'batch.summaryPromptTemplate',
  );
  assertRequiredString(value, 'reportFile', 'batch.reportFile');
  assertOptionalString(value, 'basePath', 'batch.basePath');

  const batchSize = value['batchSize'];
  if (
    'batchSize' in value &&
    (typeof batchSize !== 'number' ||
      !Number.isInteger(batchSize) ||
      batchSize < 1)
  ) {
    throw new Error('batch.batchSize must be a positive integer');
  }
}
