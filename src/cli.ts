#!/usr/bin/env node
/* eslint-disable no-console */
import process from 'node:process';

import { loop } from './loop.js';
import { loadCliConfig, parseArgs } from './util/load-cli-config.js';

/**
 * CLI entry point for loop-the-loop.
 *
 * Usage:
 *   npx loop-the-loop [--verbose] [--dry-run] [--max-prompts N] <config.json>
 *   loop-the-loop [--verbose] [--dry-run] [--max-prompts N] <config.json>   (after global install)
 *   node dist/cli.js [--verbose] [--dry-run] [--max-prompts N] <config.json> (from a local checkout)
 *
 * The config file should be a JSON object matching LoopCliConfig
 * with string values for agent/reporter and a tuple for promptGenerator.
 */
async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const config = await loadCliConfig(parsedArgs);
  const result = await loop(config);
  console.log(result);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
