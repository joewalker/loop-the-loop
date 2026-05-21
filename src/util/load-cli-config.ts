import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { AgentSpec } from '../agents.js';
import { ClaudeSDKAgent } from '../agents/claude-sdk.js';
import { normalizePromptGeneratorSpec } from '../prompt-generators.js';
import type { LoopCliConfig } from '../types.js';
import { expandIncludes } from './expand-prompt.js';

/**
 * These are the properties that parseArgs understands. `configPath` is
 * optional because `--help` and `--version` are allowed without one.
 */
export interface ParsedArgs {
  readonly configPath?: string | undefined;
  readonly help?: boolean | undefined;
  readonly version?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly maxPrompts?: number | undefined;
}

/**
 * Single-line usage string shared by the parser's "missing config path" error
 * and the `--help` output in cli.ts.
 */
export const USAGE =
  'Usage: loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] <config.json>';

type BooleanField = 'verbose' | 'dryRun' | 'help' | 'version';

/**
 * Canonical name for each supported flag. Lookups are done after
 * `normalizeFlagName`, so the keys here are the normalized (lower-case,
 * alphanumeric-only) form.
 */
const BOOLEAN_FLAGS: ReadonlyMap<string, BooleanField> = new Map([
  ['verbose', 'verbose'],
  ['dryrun', 'dryRun'],
  ['help', 'help'],
  ['version', 'version'],
]);

const VALUE_FLAGS: ReadonlyMap<string, 'maxPrompts'> = new Map([
  ['maxprompts', 'maxPrompts'],
]);

/**
 * Strip case and any separators (`-`, `_`, etc.) so that `--max-prompts`,
 * `--max_prompts`, `--MaxPrompts`, and `--MAX_PROMPTS` all resolve to the
 * same canonical flag.
 */
function normalizeFlagName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/gu, '').toLowerCase();
}

/**
 * Parse `process.argv.slice(2)` into a ParsedArgs object.
 *
 * Flag names are matched case-insensitively and ignore separators, so any
 * of `--max-prompts`, `--max_prompts`, `--maxPrompts`, `--MaxPrompts`, or
 * `--MAX_PROMPTS` are accepted. Value flags may be written either as
 * `--max-prompts=5` or `--max-prompts 5`. Flags and the positional config
 * path may appear in any order.
 */
export function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const positional: Array<string> = [];
  const booleans: Record<BooleanField, boolean> = {
    verbose: false,
    dryRun: false,
    help: false,
    version: false,
  };
  let maxPrompts: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eqIndex = body.indexOf('=');
    const rawKey = eqIndex >= 0 ? body.slice(0, eqIndex) : body;
    const inlineValue = eqIndex >= 0 ? body.slice(eqIndex + 1) : undefined;
    const key = normalizeFlagName(rawKey);

    const booleanField = BOOLEAN_FLAGS.get(key);
    if (booleanField !== undefined) {
      if (inlineValue !== undefined) {
        throw new Error(`Option --${rawKey} does not take a value`);
      }
      booleans[booleanField] = true;
      continue;
    }

    const valueField = VALUE_FLAGS.get(key);
    if (valueField === undefined) {
      throw new Error(`Unknown option: --${rawKey}`);
    }

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Option --${rawKey} requires a value`);
      }
      value = next;
      i += 1;
    }

    /* istanbul ignore else -- forward-compat: VALUE_FLAGS currently has only
       the `maxPrompts` entry, so the else branch is unreachable today. */
    if (valueField === 'maxPrompts') {
      const n = /^\d+$/u.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid --${rawKey} value: ${value}`);
      }
      maxPrompts = n;
    }
  }

  // --help and --version are short-circuit flags: they don't need a config
  // path and the caller (cli.ts) handles them before any other work.
  if (booleans.help || booleans.version) {
    return {
      help: booleans.help,
      version: booleans.version,
      verbose: booleans.verbose,
      dryRun: booleans.dryRun,
      maxPrompts,
    };
  }

  if (positional.length > 1) {
    throw new Error(
      `Unexpected extra arguments: ${positional.slice(1).join(' ')}`,
    );
  }

  const configPath = positional[0];
  if (!configPath) {
    throw new Error(USAGE);
  }

  return {
    configPath,
    help: false,
    version: false,
    verbose: booleans.verbose,
    dryRun: booleans.dryRun,
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
  /* istanbul ignore next -- cli.ts handles --help/--version before reaching
     here, so configPath is always defined for real callers. */
  if (configPath === undefined) {
    throw new Error(USAGE);
  }
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, 'utf-8');

  let config: LoopCliConfig;
  try {
    config = JSON.parse(raw) as LoopCliConfig;
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message
        : /* istanbul ignore next */ String(err);
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
