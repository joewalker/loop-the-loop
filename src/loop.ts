/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';

import { createAgent, type Agent } from './agents.js';
import { gitPreflight } from './git-preflight.js';
import { createLogger, type Logger } from './loggers.js';
import { createLoopState, DEFAULT_LOOP_STATE } from './loop-states.js';
import {
  createPromptGenerator,
  type PromptGenerator,
} from './prompt-generators.js';
import { BatchPromptGenerator } from './prompt-generators/batch.js';
import {
  createReporter,
  DEFAULT_REPORTER,
  type Reporter,
} from './reporters.js';
import type { CostInfo, LoopCliConfig, LoopRunResult } from './types.js';
import { Git } from './util/git.js';
import { runPool } from './util/run-pool.js';
import { serializeReporter } from './util/serialize-reporter.js';

/**
 * We pause in between processing files
 */
const PAUSE_SECS = 5;

/**
 * Bail out if we get this many consecutive glitches, since they indicate a
 * transient problem with the agent (e.g. rate limits, network issues) that
 * is unlikely to resolve itself within a single run.
 */
const MAX_CONSECUTIVE_GLITCHES = 5;

/**
 * Convert a configuration spec into a set of concrete implementations all with
 * defaults applied, then call the actual `loop(…)` function.
 */
export async function loop(config: LoopCliConfig): Promise<LoopRunResult> {
  const { outputDir = process.cwd(), reporter = DEFAULT_REPORTER } = config;

  return loopImpl({
    name: config.name,
    outputDir,
    agent: await createAgent(config.agent),
    promptGenerator: await createPromptGenerator(config.promptGenerator),
    reporter:
      typeof reporter === 'string'
        ? await createReporter(reporter, { outputDir, jobName: config.name })
        : reporter,
    maxPrompts: config.maxPrompts ?? Infinity,
    maxBudgetUsd: config.maxBudgetUsd ?? Infinity,
    concurrency: config.concurrency ?? 1,
    interPromptPause: config.interPromptPause ?? PAUSE_SECS,
    allowSourceUpdate: config.allowSourceUpdate ?? false,
    logger: createLogger(config.logger),
  });
}

/**
 * As LoopCliConfig with the names resolved to concrete implementations
 * and defaults applied.
 */
interface LoopConfig {
  readonly name: string;
  readonly outputDir: string;
  readonly agent: Agent;
  readonly promptGenerator: PromptGenerator;
  readonly reporter: Reporter;
  readonly maxPrompts: number;
  readonly maxBudgetUsd: number;
  readonly concurrency: number;
  readonly interPromptPause: number;
  readonly allowSourceUpdate: boolean;
  readonly logger: Logger;
}

/**
 * The actual implementation for `loop(…)`
 * Processes prompts sequentially, saving state and report after each file.
 * Resumes from saved state if a previous run was interrupted.
 */
async function loopImpl(config: LoopConfig): Promise<LoopRunResult> {
  const {
    name,
    outputDir,
    agent,
    promptGenerator,
    reporter,
    maxPrompts,
    maxBudgetUsd,
    concurrency,
    interPromptPause,
    allowSourceUpdate,
    logger,
  } = config;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency: ${concurrency}`);
  }
  if (concurrency > 1 && allowSourceUpdate) {
    throw new Error(
      'concurrency > 1 is not supported with allowSourceUpdate: git commits cannot safely interleave',
    );
  }
  if (concurrency > 1 && promptGenerator instanceof BatchPromptGenerator) {
    throw new Error(
      'concurrency > 1 is not supported with the batch prompt generator: summary prompts would race with in-flight batch items',
    );
  }

  const git = allowSourceUpdate ? new Git(process.cwd()) : undefined;

  if (git) {
    const failed = (await gitPreflight(git)).find(item => !item.ok);
    if (failed) {
      throw new Error(
        failed.message !== undefined
          ? failed.message
          : /* istanbul ignore next */ `Git preflight failed: ${failed.name}`,
      );
    }
  }

  const loopState = await createLoopState(DEFAULT_LOOP_STATE, {
    outputDir,
    jobName: name,
  });
  const runId = randomUUID();
  logger.state(`Loaded loop state for ${name}`);

  const startingTotal = (await loopState.getSnapshot()).totalUsd;
  if (startingTotal >= maxBudgetUsd) {
    const message = `Budget already reached: $${startingTotal.toFixed(4)} >= $${maxBudgetUsd}`;
    logger.state(message);
    return { status: 'stopped', reason: 'maxBudgetUsd', message };
  }

  if (maxPrompts <= 0) {
    logger.state(`Reached limit of ${maxPrompts} prompts`);
    return {
      status: 'stopped',
      reason: 'maxPrompts',
      message: `Reached limit of ${maxPrompts} prompts`,
    };
  }

  let completed = 0;
  let glitchCount = 0;
  let stopResult: LoopRunResult | undefined;

  // Serialize report appends and stagger worker startup only when running
  // concurrently; at concurrency 1 both are no-ops and the serial path is
  // unchanged.
  const activeReporter =
    concurrency > 1 ? serializeReporter(reporter) : reporter;
  const staggerSeconds =
    interPromptPause > 0 && concurrency > 1
      ? interPromptPause / concurrency
      : 0;

  try {
    await runPool(
      promptGenerator.generate(loopState),
      concurrency,
      async (prompt): Promise<'continue' | 'stop'> => {
        if (!(await loopState.claim(runId, prompt.id))) {
          logger.state(`Skip (claimed elsewhere): ${prompt.id}`);
          return 'continue';
        }

        console.log(`Processing: ${prompt.id}`);
        logger.state(`Begin: ${prompt.id}`);
        logger.system(`Prompt:\n${prompt.prompt}`);

        const result = await agent.invoke(prompt.prompt, {
          logger,
          allowSourceUpdate,
        });
        await activeReporter.append(prompt, result);
        await loopState.complete(runId, prompt.id, result);
        logger.state(`End: ${prompt.id} (${result.status})`);

        if (result.status === 'success') {
          const message = `Loop: ${config.name} / ${prompt.id}\n\n${result.output}`;
          // istanbul ignore if
          if (git) {
            logger.info(`Committing changes for ${prompt.id}`);
            await git.maybeCommitAll(message);
          }
          console.log(message);
          logger.success(`${prompt.id}: ${result.output.slice(0, 120)}`);
          glitchCount = 0;
        } else if (result.status === 'glitch') {
          // "Consecutive" under concurrency means in completion order, not
          // dispatch order: workers complete in whatever order their agents
          // return, and the counter is shared across them.
          glitchCount++;
          if (glitchCount >= MAX_CONSECUTIVE_GLITCHES) {
            const message = `Aborting after ${MAX_CONSECUTIVE_GLITCHES} consecutive glitches. Last: ${result.reason}`;
            logger.error(message);
            stopResult = {
              status: 'failed',
              reason: 'tooManyGlitches',
              message,
            };
            return 'stop';
          }
          console.log(
            `Glitch ${glitchCount}/${MAX_CONSECUTIVE_GLITCHES} on ${prompt.id}: ${result.reason}`,
          );
          logger.error(`Glitch on ${prompt.id}: ${result.reason}`);
        } else {
          const message = `Error on ${prompt.id}: ${result.reason}`;
          logger.error(message);
          stopResult = { status: 'failed', reason: 'errorResult', message };
          return 'stop';
        }

        if (result.cost !== undefined) {
          logger.state(`Cost: ${formatCost(result.cost)}`);
        }
        // Budget is checked before maxPrompts so a prompt crossing both caps
        // stops with reason 'maxBudgetUsd'.
        const runningTotal = (await loopState.getSnapshot()).totalUsd;
        if (runningTotal >= maxBudgetUsd) {
          const message = `Budget reached after ${prompt.id}: $${runningTotal.toFixed(4)} >= $${maxBudgetUsd}`;
          logger.state(message);
          stopResult = { status: 'stopped', reason: 'maxBudgetUsd', message };
          return 'stop';
        }

        completed++;
        if (completed >= maxPrompts) {
          logger.state(`Reached limit of ${maxPrompts} prompts`);
          stopResult = {
            status: 'stopped',
            reason: 'maxPrompts',
            message: `Reached limit of ${maxPrompts} prompts`,
          };
          return 'stop';
        }

        if (interPromptPause !== 0) {
          logger.info(`Pausing ${interPromptPause}s before next prompt`);
          console.log(
            `Pause (${interPromptPause}s) before starting next prompt`,
          );
          await new Promise(resolve => {
            setTimeout(resolve, interPromptPause * 1_000);
          });
        }
        return 'continue';
      },
      { staggerSeconds },
    );
  } finally {
    await loopState.release(runId);
  }

  return stopResult ?? { status: 'completed' };
}

/**
 * One-line human summary of a cost record for the verbose log.
 */
function formatCost(cost: CostInfo): string {
  if (cost.costSource === 'unavailable') {
    return `tokens only (in=${cost.inputTokens ?? 0}, out=${cost.outputTokens ?? 0})`;
  }
  const model = cost.model !== undefined ? `, ${cost.model}` : '';
  return `$${cost.usd.toFixed(4)} (${cost.costSource}${model})`;
}
