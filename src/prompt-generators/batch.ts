import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import {
  assertKnownProperties,
  assertRequiredString,
  isRecord,
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
  normalizeSource: BatchSourceNormalizer,
): BatchTask {
  assertBatchTaskConfig(config);

  return {
    ...config,
    source: normalizeSource(config.source),
  };
}

/**
 * A PromptGenerator that wraps a source generator and processes its items
 * in fixed-size batches, injecting a summary prompt after each batch.
 * A final summary is also yielded for any leftover items at the end of the
 * source, including on resumed runs where every source item already
 * completed in an earlier run.
 *
 * Summary prompt IDs take the form `batch-summary-after-{lastItemId}`,
 * where `lastItemId` is the source's logical last item in the batch (i.e.
 * the Nth source item independent of whether earlier items completed).
 * That makes summary IDs stable and trackable in LoopState across runs.
 *
 * To achieve that stability, the batch generator passes the source a
 * LoopState whose `isOutstanding` always returns true. The source therefore
 * yields every item every run, and the batch generator does its own
 * outstanding-item filtering using the real loopState. This avoids the
 * earlier behavior where summary IDs (and the trailing summary itself)
 * shifted whenever inner items had already been completed in a previous
 * run.
 *
 * `basePath` is used to resolve `{{include:...}}` macros in
 * `summaryPromptTemplate` and defaults to `process.cwd()`. CLI config loading
 * passes the config file's directory.
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
   * @param basePath - directory used to resolve `{{include:...}}` macros in
   *   `summaryPromptTemplate`. Defaults to `process.cwd()`.
   */
  static async create(
    task: BatchTask,
    createSource: (spec: unknown) => Promise<PromptGenerator>,
    basePath?: string,
  ): Promise<PromptGenerator> {
    const source = await createSource(task.source);
    return new BatchPromptGenerator(task, source, basePath);
  }

  readonly #task: BatchTask;
  readonly #source: PromptGenerator;
  readonly #basePath: string;

  constructor(task: BatchTask, source: PromptGenerator, basePath?: string) {
    this.#task = task;
    this.#source = source;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const batchSize = this.#task.batchSize ?? DEFAULT_BATCH_SIZE;
    // The source iterates every item every run (see class doc); the batch
    // generator does the outstanding-item filtering itself.
    const sourceLoopState = makePassthroughLoopState(loopState);
    let batch: Array<Prompt> = [];

    for await (const item of this.#source.generate(sourceLoopState)) {
      batch.push(item);
      if (loopState.isOutstanding(item.id)) {
        yield item;
      }

      if (batch.length >= batchSize) {
        const summary = await this.#buildSummary(batch, loopState);
        if (summary !== undefined) {
          yield summary;
        }
        batch = [];
      }
    }

    if (batch.length > 0) {
      const summary = await this.#buildSummary(batch, loopState);
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
  ): Promise<Prompt | undefined> {
    const lastId = batch[batch.length - 1].id;
    const summaryId = `batch-summary-after-${lastId}`;

    if (!loopState.isOutstanding(summaryId)) {
      return undefined;
    }

    const prompt = await expandPrompt(
      this.#task.summaryPromptTemplate,
      this.#basePath,
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
 * Wrap a LoopState so that `isOutstanding` always returns true while every
 * other method delegates to the original. This is used to expose the
 * source's logical position to the batch generator: the source filters
 * items via `isOutstanding`, so by short-circuiting that filter we make the
 * source yield every item on every run, giving the batch generator a
 * stable view of the source's iteration order.
 */
function makePassthroughLoopState(original: LoopState): LoopState {
  return {
    isOutstanding: () => true,
    claim: original.claim.bind(original),
    complete: original.complete.bind(original),
    release: original.release.bind(original),
    getSnapshot: original.getSnapshot.bind(original),
  };
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
    ['source', 'batchSize', 'summaryPromptTemplate', 'reportFile'],
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
