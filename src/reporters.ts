import type { CheckResult } from './doctor.js';
import type { Prompt } from './prompt-generators.js';
import { JsonlReporter } from './reporters/jsonl.js';
import { YamlReporter } from './reporters/yaml.js';
import type { InvokeResult } from './types.js';

/**
 * A reporter persists the results of running prompts through an agent.
 *
 * The loop calls `append()` after every invocation, successful or not.
 * Reporters are append-only; each call should serialize one entry to
 * whatever backing store the reporter uses (file, database, HTTP, etc.).
 *
 * To create a custom reporter:
 *
 * 1. Create a class that implements this interface.
 * 2. Add a static `reporterName` string, a static `fileExtension` string,
 *    and a static async `create(basePath)` factory method.
 * 3. Register it in the `reporterConstructors` map in this file.
 *
 * See `YamlReporter` and `JsonlReporter` for reference implementations.
 */
export interface Reporter {
  /**
   * Serialize a single result entry and append it to the report.
   */
  append(prompt: Prompt, result: InvokeResult): Promise<void>;

  /**
   * Optional preflight probe used by `--doctor` (see Agent.check).
   */
  check?(): AsyncIterable<CheckResult>;
}

export interface ReporterConfig {
  readonly outputDir: string;
  readonly jobName: string;
}

export const DEFAULT_REPORTER = 'default';

/**
 * To add a new reporter, add its creator function here
 */
const reporterConstructors = {
  [DEFAULT_REPORTER]: YamlReporter.create,
  [YamlReporter.reporterName]: YamlReporter.create,
  [JsonlReporter.reporterName]: JsonlReporter.create,
} satisfies Record<string, (config: ReporterConfig) => Promise<Reporter>>;

/**
 * Enable TypeScript to know what reporters are available
 */
type ReporterName = keyof typeof reporterConstructors;

export type ReporterSpec = Reporter | ReporterName;

/**
 * Enable the command line to know what reporters are available
 */
export const reporterTypes = Object.keys(reporterConstructors);

/**
 * Allow easy switching between different reporter types
 */
export function createReporter(
  type: ReporterName = DEFAULT_REPORTER,
  config: ReporterConfig,
): Promise<Reporter> {
  return reporterConstructors[type](config);
}
