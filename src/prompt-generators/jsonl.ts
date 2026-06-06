import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import { resolveAttemptId } from './util/attempt.js';
import {
  assertKnownProperties,
  assertOptionalBoolean,
  assertOptionalString,
  assertRequiredString,
  isRecord,
} from './util/config.js';

/**
 * A scalar value accepted in a `filter` map. Equality matching is
 * string-coerced, so a number or boolean matches its stringified line value.
 */
export type FilterScalar = string | number | boolean;

/**
 * Configuration for the `jsonl` reader, which iterates a `jsonl-report` one
 * JSON object per line. Distinct from `json`, which does one whole-file
 * `JSON.parse`.
 */
export interface JsonlTask {
  /**
   * Path to the JSONL file, config-relative or a `{{steps.<name>.report}}`
   * handoff substitution. A missing file is treated as empty input.
   */
  dataFile: string;

  /**
   * Prompt template. Each line's top-level fields become `{{field}}`
   * placeholders (object-valued fields are JSON-stringified), plus `{{id}}`
   * (the emitted, possibly attempt-incremented id) and `{{index}}`. Supports
   * `{{include:path}}` macros.
   */
  promptTemplate: string;

  /**
   * Line field used as the prompt id. Defaults to `id`. Falls back to the
   * line index when the field is absent.
   */
  idField?: string;

  /**
   * Field-path equality filter, for example `{ "status": "success" }` or
   * `{ "structuredOutput.verdict": "rework" }`. Dotted paths navigate into
   * nested objects. Equality only.
   */
  filter?: Readonly<Record<string, FilterScalar>>;

  /**
   * Emit a line only while its parsed `#N` attempt is below this value.
   */
  maxAttempts?: number;

  /**
   * Emit a line only once its parsed `#N` attempt is at or above this value.
   */
  minAttempts?: number;

  /**
   * When true, re-emit the line at the next attempt id (`#(N+1)`).
   */
  incrementAttempt?: boolean;
}

/**
 * Normalize a `jsonl` task config loaded from JSON.
 */
export function normalizeJsonlTaskConfig(config: unknown): JsonlTask {
  assertJsonlTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that reads a `jsonl-report` line by line and yields a
 * prompt per matching line. It can only read line-delimited JSON; a `.yaml`
 * report fails with a clear format-mismatch message. A missing file is empty
 * input; a malformed line is an error naming the line number. Emitted ids are
 * gated through the consuming step's own `loopState.isOutstanding`.
 */
export class JsonlPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'jsonl';

  static async create(
    task: JsonlTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new JsonlPromptGenerator(task, basePath);
  }

  readonly #task: JsonlTask;
  readonly #basePath: string;

  constructor(task: JsonlTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const filePath = resolve(this.#basePath, this.#task.dataFile);
    const entries = await loadLines(filePath);
    const seenIds = new Map<string, number>();

    for (let index = 0; index < entries.length; index++) {
      const { lineNumber, line } = entries[index];

      if (
        this.#task.filter !== undefined &&
        !matchesFilter(line, this.#task.filter)
      ) {
        continue;
      }

      const rawId = resolveRawId(line, this.#task.idField, index);
      const id = resolveAttemptId(rawId, this.#task);
      if (id === null) {
        continue;
      }

      const previousLine = seenIds.get(id);
      if (previousLine !== undefined) {
        throw new Error(
          `JsonlTask: duplicate id "${id}" at line ${lineNumber} (already used at line ${previousLine})`,
        );
      }
      seenIds.set(id, lineNumber);

      if (loopState.isOutstanding(id)) {
        const variables = buildVariables(line, id, index);
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

interface JsonlLine {
  readonly lineNumber: number;
  readonly line: Record<string, unknown>;
}

/**
 * Read and parse the JSONL file into one record per non-blank line. A missing
 * file is empty input; a `.yaml`/`.yml` path is a clear format mismatch; a
 * line that is not a JSON object throws with its line number.
 */
async function loadLines(filePath: string): Promise<ReadonlyArray<JsonlLine>> {
  if (/\.ya?ml$/iu.test(filePath)) {
    throw new Error(
      `JsonlTask: ${filePath} looks like a YAML report; the jsonl reader needs a jsonl-report (one JSON object per line). Configure the upstream reporter as "jsonl-report".`,
    );
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const out: Array<JsonlLine> = [];
  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i].trim();
    if (text === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : /* istanbul ignore next */ String(err);
      throw new Error(
        `JsonlTask: malformed JSON on line ${i + 1} in ${filePath}: ${detail}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `JsonlTask: line ${i + 1} in ${filePath} is not a JSON object`,
      );
    }
    out.push({ lineNumber: i + 1, line: parsed });
  }
  return out;
}

/**
 * Resolve the raw id for a line: the `idField` value (default `id`) if
 * present, otherwise the line index as a string.
 */
function resolveRawId(
  line: Record<string, unknown>,
  idField: string | undefined,
  index: number,
): string {
  const field = idField ?? 'id';
  const value = line[field];
  if (value !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(value);
  }
  return String(index);
}

/**
 * Whether a line satisfies every field-path equality in the filter.
 */
function matchesFilter(
  line: Record<string, unknown>,
  filter: Readonly<Record<string, FilterScalar>>,
): boolean {
  for (const [path, expected] of Object.entries(filter)) {
    const actual = getPath(line, path);
    if (actual === undefined) {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    if (String(actual) !== String(expected)) {
      return false;
    }
  }
  return true;
}

/**
 * Walk a dot-notation path into a parsed line, returning `undefined` when any
 * intermediate value is missing or not a plain object.
 */
function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Build the template variables for a line. Each top-level field becomes a
 * variable (object-valued fields JSON-stringified), then `id` (the emitted
 * attempt id) and `index` are set last so they win over any same-named line
 * field.
 */
function buildVariables(
  line: Record<string, unknown>,
  id: string,
  index: number,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(line)) {
    variables[key] =
      value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : // eslint-disable-next-line @typescript-eslint/no-base-to-string
          String(value);
  }
  variables['id'] = id;
  variables['index'] = String(index);
  return variables;
}

/**
 * Whether an unknown error is a "file not found" error.
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/**
 * Assert the runtime shape of a `jsonl` task config.
 */
function assertJsonlTaskConfig(value: unknown): asserts value is JsonlTask {
  if (!isRecord(value)) {
    throw new Error('jsonl task config must be an object');
  }
  assertKnownProperties(
    value,
    [
      'dataFile',
      'promptTemplate',
      'idField',
      'filter',
      'maxAttempts',
      'minAttempts',
      'incrementAttempt',
    ],
    'jsonl',
  );
  assertRequiredString(value, 'dataFile', 'jsonl.dataFile');
  assertRequiredString(value, 'promptTemplate', 'jsonl.promptTemplate');
  assertOptionalString(value, 'idField', 'jsonl.idField');
  assertOptionalBoolean(value, 'incrementAttempt', 'jsonl.incrementAttempt');
  assertFilter(value);
  assertPositiveInteger(value, 'maxAttempts', 'jsonl.maxAttempts');
  assertPositiveInteger(value, 'minAttempts', 'jsonl.minAttempts');
}

/**
 * Assert that `filter`, if present, is an object whose values are scalars.
 */
function assertFilter(value: Record<string, unknown>): void {
  if (!('filter' in value)) {
    return;
  }
  const filter = value['filter'];
  if (!isRecord(filter) || Object.values(filter).some(v => !isScalar(v))) {
    throw new Error('jsonl.filter must be an object of scalar values');
  }
}

/**
 * Whether a value is a string, number, or boolean.
 */
function isScalar(value: unknown): value is FilterScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Assert that an optional property, if present, is a positive integer.
 */
function assertPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value)) {
    return;
  }
  const n = value[key];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}
