import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Prompt } from '../prompt-generators/prompt-generators.js';
import type { InvokeResult } from '../types.js';
import type { Reporter } from './report.js';

/**
 * Manages an append-only YAML document stream report file.
 *
 * Each call to `append()` adds a new YAML document (`---` delimited)
 * to the file. The resulting file is both human-readable and trivially
 * parseable by any YAML multi-document loader.
 */
export class YamlReporter implements Reporter {
  static readonly reportName = 'yaml-report';
  static readonly fileExtension = 'yaml';

  static async create(basePath: string): Promise<YamlReporter> {
    const path = `${basePath}.${YamlReporter.fileExtension}`;
    await mkdir(dirname(path), { recursive: true });
    return new YamlReporter(path);
  }

  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Serialize a single ReportEntry as a YAML document (including the
   * leading `---` separator).
   */
  async append(prompt: Prompt, result: InvokeResult): Promise<void> {
    const lines: Array<string> = ['---'];
    lines.push(`id: "${prompt.id}"`);
    lines.push(`status: ${result.status}`);
    lines.push('prompt: |');
    for (const line of formatBlockScalar(prompt.prompt).split('\n')) {
      lines.push(line === '' ? '' : `  ${line}`);
    }

    if (result.status === 'success') {
      lines.push('output: |');
      for (const line of formatBlockScalar(result.output).split('\n')) {
        lines.push(line === '' ? '' : `  ${line}`);
      }
    } else {
      lines.push('reason: |');
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
