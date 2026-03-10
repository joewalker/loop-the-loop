/* eslint-disable no-console */
import type { Agent } from './agents/agents.js';
import { Git } from './git.js';
import type { PromptGenerator } from './prompt-generators/prompt-generators.js';

export interface MainOptions {
  /** Maximum number of prompts to process. Unlimited when null/undefined. */
  readonly maxTurns?: number | null | undefined;
}

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
 * Run an agentic loop for the given task.
 * Processes files sequentially, saving state and report after each file.
 * Resumes from saved state if a previous run was interrupted.
 */
export async function agenticLoop(
  agent: Agent,
  promptGenerator: PromptGenerator,
  options?: MainOptions,
): Promise<string> {
  const git = new Git(process.cwd());
  const maxTurns = options?.maxTurns ?? Infinity;

  if (!(await git.isClean())) {
    throw new Error(
      'Working directory is not clean. Commit or stash changes before starting.',
    );
  }

  let completed = 0;
  let glitchCount = 0;
  for await (const prompt of promptGenerator) {
    console.log(`Processing: ${prompt.id}`);
    const result = await agent.invoke(prompt.prompt);
    await prompt.recordResult(result);

    if (result.status === 'success') {
      const message = `Agentic: ${promptGenerator.name} / ${prompt.id}\n\n${result.output}`;
      await git.maybeCommitAll(message, {
        committer: { name: 'Agentic Loop', email: 'noreply@eireneh.com' },
      });
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

    console.log(`Pause (${PAUSE_SECS}s) before starting next file`);
    await new Promise(resolve => setTimeout(resolve, PAUSE_SECS * 1_000));
  }

  return 'Done';
}
