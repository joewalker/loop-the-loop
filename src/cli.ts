#!/usr/bin/env node
import process from 'node:process';
/* eslint-disable no-console */
import { pathToFileURL } from 'node:url';

import pkg from '../package.json' with { type: 'json' };
import { doctor } from './doctor.js';
import { createLogger } from './loggers.js';
import { loop } from './loop.js';
import { isPipelineSpec } from './pipeline-spec.js';
import { runPipeline } from './pipeline.js';
import type { LoopRunResult } from './types.js';
import { loadCliConfig, parseArgs, USAGE } from './util/load-cli-config.js';

/**
 * CLI entry point for loop-the-loop.
 *
 * Usage:
 *   npx loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] [--max-budget-usd N] [--concurrency N] <config.json>
 *   loop-the-loop [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] [--max-budget-usd N] [--concurrency N] <config.json>   (after global install)
 *   node dist/cli.js [--help] [--version] [--verbose] [--dry-run] [--max-prompts N] [--max-budget-usd N] [--concurrency N] <config.json> (from a local checkout)
 *
 * The config file should be a JSON object matching LoopCliConfig
 * with string values for agent/reporter and a tuple for promptGenerator.
 */
export async function main(): Promise<void> {
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
  const pipeline = isPipelineSpec(config.promptGenerator);
  if (parsedArgs.doctor === true) {
    if (pipeline) {
      console.error('--doctor does not yet support pipelines');
      process.exitCode = 1;
      return;
    }
    const ok = await doctor(config, createLogger(config.logger));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const result = pipeline ? await runPipeline(config) : await loop(config);
  console.log(renderRunResult(result));
}

/**
 * Render a structured loop result as a single human-readable line for
 * the CLI. The loop's own `message` carries the detail; this only adds
 * the familiar "Done" framing for completed and stopped runs.
 */
function renderRunResult(result: LoopRunResult): string {
  if (result.status === 'completed') {
    return 'Done';
  }
  if (result.status === 'stopped') {
    /* istanbul ignore next -- loop()/runPipeline always set `message` on a
       stopped result, so the reason fallback is defensive. */
    return `Done (${result.message ?? result.reason})`;
  }
  /* istanbul ignore next -- a failed result always carries a `message`, so the
     'Failed' fallback is defensive. */
  return result.message ?? 'Failed';
}

/* istanbul ignore next -- the entry-point guard only fires when cli.js is run
   directly as a script, never when imported by a test. */
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
