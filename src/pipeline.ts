import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loop } from './loop.js';
import {
  assertReporterHandoffContract,
  isPipelineSpec,
  PIPELINE_GENERATOR_NAME,
} from './pipeline-spec.js';
import type { LoopCliConfig, LoopRunResult, PipelineTask } from './types.js';

/**
 * Default safety ceiling on fixed-point passes.
 */
const DEFAULT_MAX_PASSES = 100;

/**
 * Run a pipeline to a fixed point. Runs every step's `loop()` once per pass,
 * in dependency-hint order, repeating passes until a whole pass records zero
 * new terminal outcomes across all steps. Under the strict default policy a
 * step whose result is not `completed` stops the pipeline immediately and is
 * reported. `maxPasses` is the backstop against a misconfiguration that keeps
 * producing new work.
 */
export async function runPipeline(
  config: LoopCliConfig,
): Promise<LoopRunResult> {
  /* istanbul ignore next -- cli.ts only calls this when isPipelineSpec holds */
  if (!isPipelineSpec(config.promptGenerator)) {
    throw new Error('runPipeline called without a pipeline spec');
  }
  const spec = config.promptGenerator as unknown as [
    string,
    PipelineTask,
    string?,
  ];
  const task = spec[1];
  assertReporterHandoffContract(task, config.reporter);

  const stepKeys = orderStepKeys(task);
  const maxPasses = task.maxPasses ?? DEFAULT_MAX_PASSES;

  let previousTotal = await countAllOutcomes(config, task, stepKeys);
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    for (const key of stepKeys) {
      const stepConfig = buildStepConfig(config, task, key);
      const result = await loop(stepConfig);
      if (result.status !== 'completed') {
        /* istanbul ignore next -- loop() always sets `message` on a
           non-completed result, so the reason/status fallbacks are defensive
           and unreachable from a real loop. */
        const detail = result.message ?? result.reason ?? result.status;
        return {
          ...result,
          message: `Pipeline stopped at step "${stepConfig.name}": ${detail}`,
        };
      }
    }
    const total = await countAllOutcomes(config, task, stepKeys);
    if (total === previousTotal) {
      return { status: 'completed' };
    }
    previousTotal = total;
  }
  return {
    status: 'stopped',
    reason: 'maxPasses',
    message: `Pipeline did not converge within ${maxPasses} passes`,
  };
}

/**
 * Order the step keys so a step follows the steps it `dependsOn` where that is
 * acyclic, falling back to configuration order when a cycle would otherwise
 * stall placement. Order is a pass-count optimisation only; convergence does
 * not depend on it.
 */
function orderStepKeys(task: PipelineTask): ReadonlyArray<string> {
  const configOrder = Object.keys(task.steps);
  const placed = new Set<string>();
  const order: Array<string> = [];
  const remaining = [...configOrder];

  while (remaining.length > 0) {
    const ready = remaining.find(key => {
      const deps = task.steps[key].dependsOn ?? [];
      return deps.every(dep => placed.has(dep));
    });
    // No step's deps are all placed (a cycle): take the next in config order.
    const next = ready ?? remaining[0];
    order.push(next);
    placed.add(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

/**
 * Synthesise a full LoopCliConfig for one step: top-level defaults, then the
 * step's own fields, then the derived name. The step generator is already
 * normalized (handoff resolved); `outputDir` is already absolute.
 */
function buildStepConfig(
  config: LoopCliConfig,
  task: PipelineTask,
  key: string,
): LoopCliConfig {
  const step = task.steps[key];
  const reporter = step.reporter ?? config.reporter;
  const outputDir = step.outputDir ?? config.outputDir;
  const allowSourceUpdate = step.allowSourceUpdate ?? config.allowSourceUpdate;
  const maxPrompts = step.maxPrompts ?? config.maxPrompts;
  const interPromptPause = step.interPromptPause ?? config.interPromptPause;
  const logger = step.logger ?? config.logger;

  return {
    name: `${config.name}-${key}`,
    agent: step.agent ?? config.agent,
    promptGenerator: step.promptGenerator,
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(reporter !== undefined ? { reporter } : {}),
    ...(allowSourceUpdate !== undefined ? { allowSourceUpdate } : {}),
    ...(maxPrompts !== undefined ? { maxPrompts } : {}),
    ...(interPromptPause !== undefined ? { interPromptPause } : {}),
    ...(logger !== undefined ? { logger } : {}),
  };
}

/**
 * Total number of terminal outcomes recorded across all steps' state files.
 * The fixed-point check compares this between passes.
 */
async function countAllOutcomes(
  config: LoopCliConfig,
  task: PipelineTask,
  stepKeys: ReadonlyArray<string>,
): Promise<number> {
  let total = 0;
  for (const key of stepKeys) {
    const stepConfig = buildStepConfig(config, task, key);
    const dir = stepConfig.outputDir ?? process.cwd();
    const statePath = resolve(dir, `${stepConfig.name}-loop-state.json`);
    total += await countOutcomes(statePath);
  }
  return total;
}

/**
 * Count `results` entries in one v2 state file. A missing file is zero
 * outcomes (the step has not run, or produced nothing).
 */
async function countOutcomes(statePath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf-8');
  } catch (err) {
    /* istanbul ignore if -- a missing state file is the only read error
       exercised; other read errors are defensive re-throws. */
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
      throw err;
    }
    return 0;
  }
  const data = JSON.parse(raw) as { results?: Record<string, unknown> };
  return data.results ? Object.keys(data.results).length : 0;
}

export { PIPELINE_GENERATOR_NAME };
