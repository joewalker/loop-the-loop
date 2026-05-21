#!/usr/bin/env node
/* eslint-disable no-console */
import process from 'node:process';

import pkg from '../package.json' with { type: 'json' };
import { loop } from './loop.js';
import { loadCliConfig, parseArgs, USAGE } from './util/load-cli-config.js';

/**
 * CLI entry point for loop-the-loop.
 *
 * Usage:
 *   npx loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] <config.json>
 *   loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] <config.json>   (after global install)
 *   node dist/cli.js [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] <config.json> (from a local checkout)
 *
 * The config file should be a JSON object matching LoopCliConfig
 * with string values for agent/reporter and a tuple for promptGenerator.
 */
async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (parsedArgs.help === true) {
    console.log(USAGE);
    return;
  }
  if (parsedArgs.version === true) {
    console.log(pkg.version);
    return;
  }
  const config = await loadCliConfig(parsedArgs);
  const result = await loop(config);
  console.log(result);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
