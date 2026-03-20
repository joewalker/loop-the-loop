/* eslint-disable no-console */
import { agenticLoop } from './agentic-loop.js';
import { loadCliConfig } from './util/load-cli-config.js';

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

  const config = await loadCliConfig(configPath);
  const result = await agenticLoop(config);
  console.log(result);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
