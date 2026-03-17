/* eslint-disable no-console */
import { join } from 'node:path';

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { createAgent, type Agent } from './agents/agents.js';
import {
  createPromptGenerator,
  type PromptGenerator,
} from './prompt-generators/prompt-generators.js';
import {
  createReporter,
  DEFAULT_REPORTER,
  type Reporter,
} from './reporters/report.js';
import type { AgenticLoopCliConfig, OutputSchema } from './types.js';
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
 * Run the agentic loop.
 * Processes files sequentially, saving state and report after each file.
 * Resumes from saved state if a previous run was interrupted.
 */
export async function agenticLoop(
  config: AgenticLoopCliConfig,
): Promise<string> {
  const {
    name,
    outputDir = process.cwd(),
    agent,
    promptGenerator,
    reporter = DEFAULT_REPORTER,
    maxTurns = Infinity,
    interPromptPause = PAUSE_SECS,
    systemPrompt,
    outputSchema,
    allowedTools,
    disallowedTools,
    mcpServers,
  } = config;

  const resolvedSystemPrompt =
    systemPrompt !== undefined
      ? await expandIncludes(systemPrompt, process.cwd())
      : undefined;

  return agenticLoopImpl({
    name,
    outputDir,
    agent: typeof agent === 'string' ? createAgent(agent) : agent,
    promptGenerator: Array.isArray(promptGenerator)
      ? createPromptGenerator(...promptGenerator)
      : promptGenerator,
    reporter:
      typeof reporter === 'string'
        ? await createReporter(outputDir, name, reporter)
        : reporter,
    maxTurns,
    interPromptPause,
    ...(resolvedSystemPrompt !== undefined
      ? { systemPrompt: resolvedSystemPrompt }
      : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  });
}

/**
 * As AgenticLoopCliConfig with the names resolved to concrete implementations
 * and defaults applied.
 */
interface AgenticLoopConfig {
  readonly name: string;
  readonly outputDir: string;
  readonly agent: Agent;
  readonly promptGenerator: PromptGenerator;
  readonly reporter: Reporter;
  readonly maxTurns: number;
  readonly interPromptPause: number;
  readonly systemPrompt?: string;
  readonly outputSchema?: OutputSchema;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly mcpServers?: Record<string, McpServerConfig>;
}

/**
 * The actual implementation for `agenticLoop(…)`
 */
async function agenticLoopImpl(config: AgenticLoopConfig): Promise<string> {
  const {
    name,
    outputDir,
    agent,
    promptGenerator,
    reporter,
    maxTurns,
    interPromptPause,
    systemPrompt,
    outputSchema,
    allowedTools,
    disallowedTools,
    mcpServers,
  } = config;

  const git = new Git(process.cwd());

  if (!(await git.isClean())) {
    throw new Error(
      'Working directory is not clean. Commit or stash changes before starting.',
    );
  }

  const path = join(outputDir, `${name}-loop-state.json`);
  const loopState = await LoopState.create(path);

  let completed = 0;
  let glitchCount = 0;
  for await (const prompt of promptGenerator.generate(loopState)) {
    console.log(`Processing: ${prompt.id}`);
    await loopState.begin(prompt.id);

    const result = await agent.invoke(prompt.prompt, {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    });
    await reporter.append(prompt, result);
    await loopState.end(prompt.id, result);

    if (result.status === 'success') {
      const message = `Agentic: ${config.name} / ${prompt.id}\n\n${result.output}`;
      await git.maybeCommitAll(message);
      console.log(message);
      glitchCount = 0;
    } else if (result.status === 'glitch') {
      glitchCount++;
      if (glitchCount >= MAX_CONSECUTIVE_GLITCHES) {
        return `Aborting after ${MAX_CONSECUTIVE_GLITCHES} consecutive glitches. Last: ${result.reason}`;
      }
      console.log(
        `Glitch ${glitchCount}/${MAX_CONSECUTIVE_GLITCHES} on ${prompt.id}: ${result.reason}`,
      );
    } else {
      return `Error on ${prompt.id}: ${result.reason}`;
    }

    completed++;
    if (completed >= maxTurns) {
      return `Done (reached limit of ${maxTurns} turns)`;
    }

    if (interPromptPause !== 0) {
      console.log(`Pause (${interPromptPause}s) before starting next prompt`);
      await new Promise(resolve => {
        setTimeout(resolve, interPromptPause * 1_000);
      });
    }
  }

  return 'Done';
}
