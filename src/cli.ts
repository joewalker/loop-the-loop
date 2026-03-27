/* eslint-disable no-console */
import process from 'node:process';

import { agenticLoop } from './agentic-loop.js';
import { loadCliConfig, parseArgs } from './util/load-cli-config.js';

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
  const parsedArgs = parseArgs(process.argv.slice(2));
  const config = await loadCliConfig(parsedArgs);
  const result = await agenticLoop(config);
  console.log(result);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
