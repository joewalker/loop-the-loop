/* eslint-disable no-console */
import process from 'node:process';

import { agenticLoop } from './agentic-loop.js';
import { loadCliConfig } from './util/load-cli-config.js';

/**
 * CLI overrides that can be set via command-line flags (--key=value).
 * These take precedence over values in the config file.
 * Add new overridable fields here as needed.
 */
type CliOverrides = {
  maxPrompts?: number;
};

/**
 * Parse CLI arguments into a config path, verbose flag, and config overrides.
 *
 * Supports:
 *   --verbose          enable verbose logging
 *   --maxPrompts=N     override maxPrompts from config file
 */
export function parseArgs(args: ReadonlyArray<string>): {
  configPath: string;
  verbose: boolean;
  overrides: Partial<CliOverrides>;
} {
  const verbose = args.includes('--verbose');
  const overrides: Partial<CliOverrides> = {};
  const positional: Array<string> = [];

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
        overrides.maxPrompts = n;
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
      'Usage: agentic-loop [--verbose] [--maxPrompts=N] <config.json>',
    );
  }
  return { configPath, verbose, overrides };
}

/**
 * CLI entry point for agentic-loop.
 *
 * Usage:
 *   deno run --allow-all src/cli.ts [--verbose] [--maxPrompts=N] <config.json>
 *   ./dist/agentic-loop [--verbose] [--maxPrompts=N] <config.json>
 *
 * The config file should be a JSON object matching AgenticLoopCliConfig
 * with string values for agent/reporter and a tuple for promptGenerator.
 */
async function main(): Promise<void> {
  const { configPath, verbose, overrides } = parseArgs(process.argv.slice(2));
  const config = {
    ...(await loadCliConfig(configPath, verbose)),
    ...overrides,
  };
  const result = await agenticLoop(config);
  console.log(result);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
