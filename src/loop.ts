/* eslint-disable no-console */
import { join } from 'node:path';

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { createAgent, type Agent } from './agents.js';
import { createLogger, type Logger } from './loggers/loggers.js';
import {
  createPromptGenerator,
  type PromptGenerator,
} from './prompt-generators.js';
import {
  createReporter,
  DEFAULT_REPORTER,
  type Reporter,
} from './reporters/reporters.js';
import type { LoopCliConfig, OutputSchema } from './types.js';
import { expandIncludes } from './util/expand-includes.js';
import { Git } from './util/git.js';
import { LoopState } from './util/loop-state.js';

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
export async function loop(config: LoopCliConfig): Promise<string> {
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
    interPromptPause: config.interPromptPause ?? PAUSE_SECS,
    systemPrompt:
      config.systemPrompt != null
        ? await expandIncludes(config.systemPrompt, process.cwd())
        : undefined,
    outputSchema: config.outputSchema,
    allowedTools: config.allowedTools,
    disallowedTools: config.disallowedTools,
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
  readonly interPromptPause: number;
  readonly systemPrompt?: string | undefined;
  readonly outputSchema?: OutputSchema | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  readonly disallowedTools?: ReadonlyArray<string> | undefined;
  readonly mcpServers?: Record<string, McpServerConfig> | undefined;
  readonly allowSourceUpdate: boolean;
  readonly logger: Logger;
}

/**
 * The actual implementation for `loop(…)`
 * Processes prompts sequentially, saving state and report after each file.
 * Resumes from saved state if a previous run was interrupted.
 */
async function loopImpl(config: LoopConfig): Promise<string> {
  const {
    name,
    outputDir,
    agent,
    promptGenerator,
    reporter,
    maxPrompts,
    interPromptPause,
    systemPrompt,
    outputSchema,
    allowedTools,
    disallowedTools,
    mcpServers,
    allowSourceUpdate,
    logger,
  } = config;

  const git = allowSourceUpdate ? new Git(process.cwd()) : undefined;

  if (git && !(await git.isClean())) {
    throw new Error(
      'Working directory is not clean. Commit or stash changes before starting.',
    );
  }

  const path = join(outputDir, `${name}-loop-state.json`);
  const loopState = await LoopState.create(path);
  logger.state(`Loaded loop state from ${path}`);

  let completed = 0;
  let glitchCount = 0;
  for await (const prompt of promptGenerator.generate(loopState)) {
    console.log(`Processing: ${prompt.id}`);
    logger.state(`Begin: ${prompt.id}`);
    await loopState.begin(prompt.id);

    const result = await agent.invoke(prompt.prompt, {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      logger,
    });
    await reporter.append(prompt, result);
    await loopState.end(prompt.id, result);
    logger.state(`End: ${prompt.id} (${result.status})`);

    if (result.status === 'success') {
      const message = `Loop: ${config.name} / ${prompt.id}\n\n${result.output}`;
      if (git) {
        logger.info(`Committing changes for ${prompt.id}`);
        await git.maybeCommitAll(message);
      }
      console.log(message);
      logger.success(`${prompt.id}: ${result.output.slice(0, 120)}`);
      glitchCount = 0;
    } else if (result.status === 'glitch') {
      glitchCount++;
      if (glitchCount >= MAX_CONSECUTIVE_GLITCHES) {
        logger.error(
          `Aborting after ${MAX_CONSECUTIVE_GLITCHES} consecutive glitches`,
        );
        return `Aborting after ${MAX_CONSECUTIVE_GLITCHES} consecutive glitches. Last: ${result.reason}`;
      }
      console.log(
        `Glitch ${glitchCount}/${MAX_CONSECUTIVE_GLITCHES} on ${prompt.id}: ${result.reason}`,
      );
      logger.error(`Glitch on ${prompt.id}: ${result.reason}`);
    } else {
      logger.error(`Error on ${prompt.id}: ${result.reason}`);
      return `Error on ${prompt.id}: ${result.reason}`;
    }

    completed++;
    if (completed >= maxPrompts) {
      logger.state(`Reached limit of ${maxPrompts} prompts`);
      return `Done (reached limit of ${maxPrompts} prompts)`;
    }

    if (interPromptPause !== 0) {
      logger.info(`Pausing ${interPromptPause}s before next prompt`);
      console.log(`Pause (${interPromptPause}s) before starting next prompt`);
      await new Promise(resolve => {
        setTimeout(resolve, interPromptPause * 1_000);
      });
    }
  }

  return 'Done';
}
