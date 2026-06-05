import { access, appendFile, constants, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CheckResult } from '../doctor.js';
import type { Prompt } from '../prompt-generators.js';
import type { Reporter, ReporterConfig } from '../reporters.js';
import type { InvokeResult } from '../types.js';

/**
 * Manages an append-only JSONL report file.
 *
 * Each call to `append()` serializes one JSON object to a new line.
 * The resulting file can be processed line-by-line with any standard
 * JSON tooling or streamed incrementally.
 */
export class JsonlReporter implements Reporter {
  static readonly reporterName = 'jsonl-report';

  static async create(config: ReporterConfig): Promise<JsonlReporter> {
    await mkdir(config.outputDir, { recursive: true });
    const path = join(config.outputDir, `${config.jobName}-report.jsonl`);
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
    const output = `${JSON.stringify({ ...prompt, ...result })}\n`;
    await appendFile(this.#path, output);
  }

  /**
   * Preflight probe used by `--doctor`.
   *
   * First confirms the output directory exists and is writable (creating it
   * with `mkdir` the same way `create()` does), then confirms the report
   * file is appendable. Since the report file is created lazily on first
   * append, an absent file is reported as ok rather than fail.
   */
  async *check(): AsyncIterable<CheckResult> {
    const dir = dirname(this.#path);
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      yield { name: 'output directory writable', status: 'ok', message: dir };
    } catch (err) {
      yield {
        name: 'output directory writable',
        status: 'fail',
        message:
          err instanceof Error
            ? err.message
            : /* istanbul ignore next */ String(err),
        cause: err,
      };
      return;
    }
    try {
      await access(this.#path, constants.F_OK);
      await access(this.#path, constants.W_OK);
      yield {
        name: 'report file appendable',
        status: 'ok',
        message: this.#path,
      };
    } catch {
      yield {
        name: 'report file appendable',
        status: 'ok',
        message: 'will be created on first append',
      };
    }
  }
}
