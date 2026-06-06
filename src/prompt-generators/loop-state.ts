import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LoopState, PromptOutcome } from '../loop-states.js';
import { FileLoopState } from '../loop-states/file.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import {
  assertKnownProperties,
  assertRequiredString,
  isRecord,
} from './util/config.js';

/**
 * Which terminal outcomes the `loop-state` reader yields. `success` is the
 * default because it is the safe choice for forward progress.
 */
export type LoopStateSelect = 'success' | 'error' | 'all';

/**
 * Configuration for the `loop-state` reader, which yields prompts from the
 * per-id terminal outcomes recorded in a strict v2 loop-state snapshot.
 */
export interface LoopStateTask {
  /**
   * Path to the v2 state file, config-relative or a `{{steps.<name>.state}}`
   * handoff substitution.
   */
  stateFile: string;

  /**
   * Prompt template. Placeholders: `{{id}}`, `{{status}}`, and `{{reason}}`
   * (only for error outcomes). Supports `{{include:path}}` macros.
   */
  promptTemplate: string;

  /**
   * Which outcomes to yield. Defaults to `success`.
   */
  select?: LoopStateSelect;
}

/**
 * Normalize a `loop-state` task config loaded from JSON.
 */
export function normalizeLoopStateTaskConfig(config: unknown): LoopStateTask {
  assertLoopStateTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that reads a strict v2 loop-state snapshot and yields one
 * prompt per terminal outcome, for status-based routing without the full
 * report. Entries are derived from `results`; `claims` are ignored because an
 * active claim is not a terminal routing decision. The reader cannot provide
 * `output` or `structuredOutput`, which the state file deliberately does not
 * store; use the `jsonl` reader when the upstream text or a verdict is needed.
 */
export class LoopStatePromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'loop-state';

  static async create(
    task: LoopStateTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new LoopStatePromptGenerator(task, basePath);
  }

  readonly #task: LoopStateTask;
  readonly #basePath: string;

  constructor(task: LoopStateTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const filePath = resolve(this.#basePath, this.#task.stateFile);
    const results = await loadResults(filePath);
    const select = this.#task.select ?? 'success';

    for (const [id, outcome] of results) {
      if (select !== 'all' && outcome.status !== select) {
        continue;
      }
      if (loopState.isOutstanding(id)) {
        const variables: Record<string, string> = {
          id,
          status: outcome.status,
        };
        if (outcome.status === 'error' && outcome.reason !== undefined) {
          variables['reason'] = outcome.reason;
        }
        const prompt = await expandPrompt(
          this.#task.promptTemplate,
          this.#basePath,
          variables,
        );
        yield { id, prompt };
      }
    }
  }
}

/**
 * Load the `results` map from a v2 state file. A missing file is empty input;
 * a present-but-malformed or non-v2 file throws (the v2 contract is enforced
 * by `FileLoopState.fromPersisted`).
 */
async function loadResults(
  filePath: string,
): Promise<ReadonlyMap<string, PromptOutcome>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      return new Map();
    }
    throw err;
  }
  const data = JSON.parse(raw) as unknown;
  const snapshot = await FileLoopState.fromPersisted(
    filePath,
    data,
  ).getSnapshot();
  return new Map(Object.entries(snapshot.results));
}

/**
 * Whether an unknown error is a "file not found" error.
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/**
 * Assert the runtime shape of a `loop-state` task config.
 */
function assertLoopStateTaskConfig(
  value: unknown,
): asserts value is LoopStateTask {
  if (!isRecord(value)) {
    throw new Error('loop-state task config must be an object');
  }
  assertKnownProperties(
    value,
    ['stateFile', 'promptTemplate', 'select'],
    'loop-state',
  );
  assertRequiredString(value, 'stateFile', 'loop-state.stateFile');
  assertRequiredString(value, 'promptTemplate', 'loop-state.promptTemplate');
  if (
    'select' in value &&
    value['select'] !== 'success' &&
    value['select'] !== 'error' &&
    value['select'] !== 'all'
  ) {
    throw new Error('loop-state.select must be one of success, error, all');
  }
}
