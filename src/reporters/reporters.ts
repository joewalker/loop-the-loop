import { join } from 'node:path';

import type { Prompt } from '../prompt-generators/prompt-generators.js';
import type { InvokeResult } from '../types.js';
import { JsonlReporter } from './jsonl.js';
import { YamlReporter } from './yaml.js';

/**
 * Report the results of running a prompt through an agent.
 */
export interface Reporter {
  /**
   * Serialize a single result entry and append it to the report.
   */
  append(prompt: Prompt, result: InvokeResult): Promise<void>;
}

export const DEFAULT_REPORTER = 'default';

/**
 * To add a new reporter, add its creator function here
 */
/**
 * To add a new reporter, add its creator function here
 */
const reporterConstructors = {
  [DEFAULT_REPORTER]: YamlReporter.create,
  [YamlReporter.reportName]: YamlReporter.create,
  [JsonlReporter.reportName]: JsonlReporter.create,
} satisfies Record<string, (basePath: string) => Promise<Reporter>>;

/**
 * Enable TypeScript to know what reporters are available
 */
export type ReporterType = keyof typeof reporterConstructors;

/**
 * Enable the command line to know what reporters are available
 */
export const reporterTypes = Object.keys(reporterConstructors);

/**
 * Allow easy switching between different reporter types
 */
export function createReporter(
  outputDir: string,
  name: string,
  type: ReporterType = DEFAULT_REPORTER,
): Promise<Reporter> {
  return reporterConstructors[type](join(outputDir, `${name}-report`));
}
