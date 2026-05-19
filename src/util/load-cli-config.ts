import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { AgentSpec } from '../agents.js';
import { ClaudeSDKAgent } from '../agents/claude-sdk.js';
import { normalizePromptGeneratorSpec } from '../prompt-generators.js';
import type { LoopCliConfig } from '../types.js';
import { expandIncludes } from './expand-prompt.js';

/**
 * These are the properties that parseArgs understands
 */
export interface ParsedArgs {
  readonly configPath: string;
  readonly verbose?: boolean | undefined;
  readonly maxPrompts?: number | undefined;
}

/**
 * Simple `process.argv.slice(2)` parsing to turn an array of strings into
 * a ParsedArgs object which describes how to act
 */
export function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const verbose = args.includes('--verbose');
  const positional: Array<string> = [];
  let maxPrompts: number | undefined;

  for (const arg of args) {
    if (arg === '--verbose') {
      continue;
    }
    const match = arg.match(/^--(\w+)=(.+)$/u); // eslint-disable-line @typescript-eslint/prefer-regexp-exec
    if (match) {
      const [, key, value] = match;
      if (key === 'maxPrompts') {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 0) {
          throw new Error(`Invalid --maxPrompts value: ${value}`);
        }
        maxPrompts = n;
      } else {
        throw new Error(`Unknown option: --${key}`);
      }
    } else {
      positional.push(arg);
    }
  }

  const configPath = positional[0];
  if (!configPath) {
    throw new Error(
      'Usage: loop-the-loop [--verbose] [--maxPrompts=N] <config.json>',
    );
  }

  return {
    configPath,
    verbose,
    maxPrompts,
  };
}

/**
 * Load a CLI JSON config file and normalize paths that should be interpreted
 * relative to the config file itself.
 */
export async function loadCliConfig(
  parsedArgs: ParsedArgs,
): Promise<LoopCliConfig> {
  const { configPath, maxPrompts, verbose } = parsedArgs;
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, 'utf-8');

  let config: LoopCliConfig;
  try {
    config = JSON.parse(raw) as LoopCliConfig;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${resolvedPath}: ${detail}`, {
      cause: err,
    });
  }

  return {
    ...(await normalizeCliConfig(config, resolvedPath)),
    ...(maxPrompts !== undefined
      ? /* istanbul ignore next */ { maxPrompts }
      : {}),
    ...(verbose
      ? /* istanbul ignore next */ { logger: 'verbose' as const }
      : {}),
  };
}

/**
 * Normalize a parsed CLI config so includes in JSON-defined prompt templates
 * and system prompts are resolved relative to the config file directory.
 */
export async function normalizeCliConfig(
  config: LoopCliConfig,
  configPath: string,
): Promise<LoopCliConfig> {
  const resolvedPath = resolve(configPath);
  const configDir = dirname(resolvedPath);

  const outputDir =
    config.outputDir === undefined
      ? configDir
      : resolve(configDir, config.outputDir);

  return {
    ...config,
    outputDir,
    agent: await normalizeAgentSpec(config.agent, configDir),
    promptGenerator: normalizePromptGeneratorSpec(config.promptGenerator, {
      configDir,
    }),
  };
}

/**
 * Resolve any `{{include:...}}` macros in agent-specific config fields that
 * accept file references (currently just `claude-sdk`'s `systemPrompt`).
 * Includes are resolved relative to the config file directory; non-claude-sdk
 * specs are passed through unchanged.
 */
async function normalizeAgentSpec(
  agent: AgentSpec,
  configDir: string,
): Promise<AgentSpec> {
  if (!Array.isArray(agent) || agent[0] !== ClaudeSDKAgent.agentName) {
    return agent;
  }

  const [name, config] = agent;
  const systemPrompt = config?.systemPrompt;
  if (systemPrompt === undefined) {
    return agent;
  }

  return [
    name,
    {
      ...config,
      systemPrompt: await expandIncludes(systemPrompt, configDir),
    },
  ];
}
