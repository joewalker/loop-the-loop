import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Prompt } from '../prompt-generators/prompt-generators.js';
import type { InvokeResult } from '../types.js';
import type { Reporter } from './reporters.js';

/**
 * A single record written to the JSONL report.
 * Each call to `append()` serializes one of these as a JSON line.
 */
type JsonlEntry =
  | {
      readonly id: string;
      readonly status: 'success';
      readonly prompt: string;
      readonly output: string;
      readonly structuredOutput?: unknown;
    }
  | {
      readonly id: string;
      readonly status: 'error' | 'glitch';
      readonly prompt: string;
      readonly reason: string;
    };

/**
 * Manages an append-only JSONL report file.
 *
 * Each call to `append()` serializes one JSON object to a new line.
 * The resulting file can be processed line-by-line with any standard
 * JSON tooling or streamed incrementally.
 */
export class JsonlReporter implements Reporter {
  static readonly reportName = 'jsonl-report';
  static readonly fileExtension = 'jsonl';

  static async create(basePath: string): Promise<JsonlReporter> {
    const path = `${basePath}.${JsonlReporter.fileExtension}`;
    await mkdir(dirname(path), { recursive: true });
    return new JsonlReporter(path);
  }

  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Serialize a single entry as a JSON line and append it to the report file.
   */
  async append(prompt: Prompt, result: InvokeResult): Promise<void> {
    let entry: JsonlEntry;

    if (result.status === 'success') {
      entry = {
        id: prompt.id,
        status: result.status,
        prompt: prompt.prompt,
        output: result.output,
        ...(result.structuredOutput !== undefined
          ? { structuredOutput: result.structuredOutput }
          : {}),
      };
    } else {
      entry = {
        id: prompt.id,
        status: result.status,
        prompt: prompt.prompt,
        reason: result.reason,
      };
    }

    await appendFile(this.#path, `${JSON.stringify(entry)}\n`);
  }
}
