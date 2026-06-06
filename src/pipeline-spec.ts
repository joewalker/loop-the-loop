import {
  assertKnownProperties,
  isRecord,
} from './prompt-generators/util/config.js';
import type { PipelineStep, PipelineTask } from './types.js';

/**
 * The generator-spec name under which a pipeline is nested in the
 * `promptGenerator` slot: `["pipeline", PipelineTask]`.
 */
export const PIPELINE_GENERATOR_NAME = 'pipeline';

/**
 * Matches `{{steps.<name>.report}}` markers; used by the reporter/handoff
 * contract check, which runs on the raw (pre-substitution) config.
 */
const REPORT_MARKER = /\{\{steps\.([A-Za-z0-9_-]+)\.report\}\}/gu;

/**
 * Whether a prompt-generator spec is a pipeline tuple. Cheap structural check
 * used by the CLI to dispatch to `runPipeline` instead of `loop`.
 */
export function isPipelineSpec(spec: unknown): boolean {
  return Array.isArray(spec) && spec[0] === PIPELINE_GENERATOR_NAME;
}

/**
 * Validate the shape of a pipeline task config loaded from JSON: a non-empty
 * `steps` map, each step with a `promptGenerator`, a declared `output` step,
 * and `dependsOn` entries that name existing steps. Cycles are allowed.
 * Nested pipelines are not rejected here; `normalizePromptGeneratorSpec`
 * throws when a step generator is itself a pipeline.
 */
export function normalizePipelineTaskConfig(config: unknown): PipelineTask {
  if (!isRecord(config)) {
    throw new Error('pipeline task config must be an object');
  }
  assertKnownProperties(config, ['output', 'steps', 'maxPasses'], 'pipeline');

  if (typeof config['output'] !== 'string') {
    throw new Error('pipeline.output must be a string');
  }
  if (!isRecord(config['steps'])) {
    throw new Error('pipeline.steps must be an object');
  }
  const stepKeys = Object.keys(config['steps']);
  if (stepKeys.length === 0) {
    throw new Error('pipeline.steps must have at least one step');
  }
  for (const [key, step] of Object.entries(config['steps'])) {
    assertStep(key, step, stepKeys);
  }
  if (!stepKeys.includes(config['output'])) {
    throw new Error(
      `pipeline.output "${config['output']}" is not a declared step`,
    );
  }
  if ('maxPasses' in config) {
    const maxPasses = config['maxPasses'];
    if (
      typeof maxPasses !== 'number' ||
      !Number.isInteger(maxPasses) ||
      maxPasses < 1
    ) {
      throw new Error('pipeline.maxPasses must be a positive integer');
    }
  }
  return config as unknown as PipelineTask;
}

/**
 * Validate one step entry.
 */
function assertStep(
  key: string,
  step: unknown,
  stepKeys: ReadonlyArray<string>,
): void {
  if (!isRecord(step)) {
    throw new Error(`pipeline.steps.${key} must be an object`);
  }
  assertKnownProperties(
    step,
    [
      'promptGenerator',
      'agent',
      'reporter',
      'outputDir',
      'allowSourceUpdate',
      'maxPrompts',
      'interPromptPause',
      'logger',
      'dependsOn',
    ],
    `pipeline.steps.${key}`,
  );
  if (!('promptGenerator' in step)) {
    throw new Error(`pipeline.steps.${key}.promptGenerator is required`);
  }
  if ('dependsOn' in step) {
    const dependsOn = step['dependsOn'];
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.some(d => typeof d !== 'string')
    ) {
      throw new Error(
        `pipeline.steps.${key}.dependsOn must be an array of strings`,
      );
    }
    for (const dep of dependsOn) {
      if (!stepKeys.includes(dep)) {
        throw new Error(
          `pipeline.steps.${key}.dependsOn references unknown step "${dep}"`,
        );
      }
    }
  }
}

/**
 * The set of producer step keys whose `{{steps.<key>.report}}` a generator
 * spec consumes. Walks `jsonl` readers (including array `dataFile`s) and
 * recurses into `batch` sources. State markers are intentionally ignored:
 * a state file is always JSON and readable regardless of reporter.
 */
export function collectReportConsumers(spec: unknown): Set<string> {
  const out = new Set<string>();
  walk(spec, out);
  return out;
}

/**
 * Recursive worker for `collectReportConsumers`.
 */
function walk(spec: unknown, out: Set<string>): void {
  if (!Array.isArray(spec)) {
    return;
  }
  const [type, config] = spec as [string, unknown];
  if (type === 'jsonl' && isRecord(config)) {
    const dataFile = config['dataFile'];
    const files = Array.isArray(dataFile) ? dataFile : [dataFile];
    for (const file of files) {
      if (typeof file === 'string') {
        for (const match of file.matchAll(REPORT_MARKER)) {
          out.add(match[1]);
        }
      }
    }
  } else if (type === 'batch' && isRecord(config)) {
    walk(config['source'], out);
  }
}

/**
 * Reject a pipeline that hands off a report through a `jsonl` reader while the
 * producing step resolves to a non-`jsonl-report` reporter. The default
 * `yaml-report` cannot be read back by the `jsonl` reader, and because handoff
 * resolves to a `.jsonl` filename the mismatch would otherwise surface only as
 * silent empty input at run time. Runs on the raw config, before handoff
 * substitution, so markers still name bare step keys.
 */
export function assertReporterHandoffContract(
  task: PipelineTask,
  topLevelReporter: unknown,
): void {
  for (const [stepKey, step] of Object.entries(task.steps)) {
    for (const producerKey of collectReportConsumers(step.promptGenerator)) {
      const producer = task.steps[producerKey];
      const reporter = producer?.reporter ?? topLevelReporter;
      if (reporter !== 'jsonl-report') {
        throw new Error(
          `Pipeline handoff contract: step "${stepKey}" reads {{steps.${producerKey}.report}} with a jsonl reader, but step "${producerKey}" uses reporter "${String(
            reporter,
          )}". A jsonl handoff requires the producer to set reporter "jsonl-report".`,
        );
      }
    }
  }
}

/**
 * A pipeline step augmented with the fields needed to synthesise its config.
 * Re-exported for `runPipeline`.
 */
export type { PipelineStep, PipelineTask };
