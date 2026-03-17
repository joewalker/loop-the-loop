/* eslint-disable no-console */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { agenticLoop } from './agentic-loop.js';
import type { AgenticLoopCliConfig } from './types.js';

/**
 * CLI entry point for agentic-loop.
 *
 * Usage:
 *   deno run --allow-all src/cli.ts <config.json>
 *   ./dist/agentic-loop <config.json>
 *
 * The config file should be a JSON object matching AgenticLoopCliConfig
 * with string values for agent/reporter and a tuple for promptGenerator.
 */
async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error('Usage: agentic-loop <config.json>');
  }

  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, 'utf-8');

  let config: AgenticLoopCliConfig;
  try {
    config = JSON.parse(raw) as AgenticLoopCliConfig;
  } catch {
    throw new Error(`Failed to parse config file: ${resolvedPath}`);
  }

  // Default outputDir to the directory containing the config file
  if (config.outputDir === undefined) {
    config = { ...config, outputDir: dirname(resolvedPath) };
  }

  const result = await agenticLoop(config);
  console.log(result);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
