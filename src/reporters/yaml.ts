import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Prompt } from '../prompt-generators.js';
import type { Reporter, ReporterConfig } from '../reporters.js';
import type { InvokeResult } from '../types.js';

/**
 * Manages an append-only YAML document stream report file.
 *
 * Each call to `append()` adds a new YAML document (`---` delimited)
 * to the file. The resulting file is both human-readable and trivially
 * parseable by any YAML multi-document loader.
 */
export class YamlReporter implements Reporter {
  static readonly reporterName = 'yaml-report';

  static async create(config: ReporterConfig): Promise<YamlReporter> {
    await mkdir(config.outputDir, { recursive: true });
    const path = join(config.outputDir, `${config.jobName}-report.yaml`);
    return new YamlReporter(path);
  }

  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Serialize a single ReportEntry as a YAML document (including the
   * leading `---` separator).
   *
   * Block scalars use the explicit indentation indicator `|2` so the
   * parser anchors content indent at 2 columns regardless of the first
   * non-empty line. Without it, an `output` or `reason` value that starts
   * with leading whitespace would push the auto-detected content indent
   * past 2, and any subsequent line whose total indent is less than the
   * detected base would terminate the block early - either corrupting the
   * YAML or silently truncating the captured text.
   */
  async append(prompt: Prompt, result: InvokeResult): Promise<void> {
    const lines: Array<string> = ['---'];
    lines.push(`id: "${prompt.id}"`);
    lines.push(`status: ${result.status}`);
    // lines.push('prompt: |');
    // for (const line of formatBlockScalar(prompt.prompt).split('\n')) {
    //   lines.push(line === '' ? '' : `  ${line}`);
    // }

    if (result.status === 'success') {
      lines.push('output: |2');
      for (const line of formatBlockScalar(result.output).split('\n')) {
        lines.push(line === '' ? '' : `  ${line}`);
      }
      if (result.structuredOutput !== undefined) {
        lines.push('structuredOutput: |2');
        const json = JSON.stringify(result.structuredOutput, null, 2);
        for (const line of formatBlockScalar(json).split('\n')) {
          lines.push(line === '' ? /* istanbul ignore next */ '' : `  ${line}`);
        }
      }
    } else {
      lines.push('reason: |2');
      for (const line of formatBlockScalar(result.reason).split('\n')) {
        lines.push(line === '' ? '' : `  ${line}`);
      }
    }

    lines.push('');

    await appendFile(this.#path, lines.join('\n'));
  }
}

/**
 * Escape a string value for use in a YAML block scalar. Block scalars
 * preserve content as-is, but trailing whitespace on lines can be
 * surprising so we trim each line's trailing spaces.
 */
function formatBlockScalar(value: string): string {
  return value
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');
}
