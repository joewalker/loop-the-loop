import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type { LoopState } from '../util/loop-state.js';
import {
  assertKnownProperties,
  assertOptionalString,
  assertRequiredString,
  isRecord,
} from './util/config.js';

/**
 * Configuration for a prompt generator that iterates over elements of a JSON
 * data source.
 */
export interface JsonTask {
  /**
   * Inline JSON data to iterate over. Mutually exclusive with `dataFile`.
   */
  data?: unknown;

  /**
   * Path to a JSON file to read. Mutually exclusive with `data`. Resolved
   * relative to the generator's `basePath`.
   */
  dataFile?: string;

  /**
   * Dot-notation path into the parsed JSON to reach the array or object to
   * iterate over. For example, `"response.items"` navigates to
   * `json.response.items`. Defaults to the root value.
   */
  path?: string;

  /**
   * Field name on each element to use as the unique ID for LoopState
   * tracking. Only applies when the element is an object. Defaults to the
   * array index (for arrays) or the object key (for plain objects).
   */
  idField?: string;

  /**
   * Prompt template. Available placeholders:
   *
   * - `{{field}}` - any top-level field of the current element (objects only)
   * - `{{value}}` - the element stringified (non-object elements only)
   * - `{{id}}` - the resolved ID used for LoopState tracking
   * - `{{index}}` - the 0-based position in the iteration
   * - `{{include:path}}` - file include macro (resolved against `basePath`)
   */
  promptTemplate: string;
}

/**
 * Normalize JSON task config values loaded from JSON.
 */
export function normalizeJsonTaskConfig(config: unknown): JsonTask {
  assertJsonTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that iterates over the elements of a JSON array or object,
 * yielding one prompt per element. `basePath` is used to resolve
 * `{{include:...}}` macros in the prompt template and `dataFile`, and defaults
 * to `process.cwd()`. CLI config loading passes the config file's directory.
 */
export class JsonPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'json';

  static async create(
    task: JsonTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new JsonPromptGenerator(task, basePath);
  }

  readonly #task: JsonTask;
  readonly #basePath: string;

  constructor(task: JsonTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const rawData = await loadData(this.#task, this.#basePath);
    const data = this.#task.path
      ? navigatePath(rawData, this.#task.path)
      : rawData;
    const entries = toEntries(data);

    for (let index = 0; index < entries.length; index++) {
      const [key, element] = entries[index];
      const id = resolveId(element, key, this.#task.idField);

      if (loopState.isOutstanding(id)) {
        const variables = buildVariables(element, id, index);
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
 * Load and parse the JSON data from either inline `data` or `dataFile`.
 */
async function loadData(task: JsonTask, basePath: string): Promise<unknown> {
  if (task.data !== undefined && task.dataFile !== undefined) {
    throw new Error('JsonTask: specify either "data" or "dataFile", not both');
  }
  if (task.data !== undefined) {
    return task.data;
  }
  if (task.dataFile !== undefined) {
    const filePath = resolve(basePath, task.dataFile);
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as unknown;
  }
  throw new Error('JsonTask: either "data" or "dataFile" must be specified');
}

/**
 * Walk a dot-notation path (e.g. `"response.items"`) into a parsed JSON value,
 * returning the value found at that location.
 */
export function navigatePath(data: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;

  for (const part of parts) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      throw new Error(
        `JsonTask: cannot navigate path "${path}": intermediate value at "${part}" is not a plain object`,
      );
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Convert the target JSON value into an ordered list of [key, element] pairs
 * suitable for iteration. Arrays produce string indices as keys; plain objects
 * produce their own keys in insertion order.
 */
export function toEntries(data: unknown): Array<[string, unknown]> {
  if (Array.isArray(data)) {
    return data.map((element, index) => [String(index), element]);
  }
  if (data !== null && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>);
  }
  throw new Error(
    `JsonTask: target value must be an array or plain object, got ${typeof data}`,
  );
}

/**
 * Resolve the unique ID for a given element. Uses `idField` when the element
 * is a plain object and the field is present; otherwise falls back to the
 * natural key (array index or object key).
 */
function resolveId(element: unknown, key: string, idField?: string): string {
  if (
    idField !== undefined &&
    element !== null &&
    typeof element === 'object' &&
    !Array.isArray(element)
  ) {
    const value = (element as Record<string, unknown>)[idField];
    if (value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      return String(value);
    }
  }
  return key;
}

/**
 * Build the variables map for template substitution. Always includes `id` and
 * `index`. For object elements, each top-level field is added. For non-object
 * elements, `value` is added with the stringified element.
 */
function buildVariables(
  element: unknown,
  id: string,
  index: number,
): Record<string, string> {
  const variables: Record<string, string> = {
    id,
    index: String(index),
  };

  if (
    element !== null &&
    typeof element === 'object' &&
    !Array.isArray(element)
  ) {
    for (const [key, val] of Object.entries(
      element as Record<string, unknown>,
    )) {
      variables[key] = String(val);
    }
  } else {
    variables['value'] = String(element);
  }

  return variables;
}

/**
 * Assert that an unknown value has the runtime shape required for a JSON task
 * config.
 */
function assertJsonTaskConfig(value: unknown): asserts value is JsonTask {
  if (!isRecord(value)) {
    throw new Error('json task config must be an object');
  }

  assertKnownProperties(
    value,
    ['data', 'dataFile', 'path', 'idField', 'promptTemplate'],
    'json',
  );
  assertRequiredString(value, 'promptTemplate', 'json.promptTemplate');
  assertOptionalString(value, 'dataFile', 'json.dataFile');
  assertOptionalString(value, 'path', 'json.path');
  assertOptionalString(value, 'idField', 'json.idField');

  const hasData = value['data'] !== undefined;
  const hasDataFile = value['dataFile'] !== undefined;
  if (hasData === hasDataFile) {
    throw new Error(
      'json task config must specify exactly one of json.data or json.dataFile',
    );
  }
}
