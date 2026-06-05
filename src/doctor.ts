import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { createAgent } from './agents.js';
import { gitPreflight } from './git-preflight.js';
import type { Logger } from './loggers.js';
import { FileLoopState } from './loop-states/file.js';
import { createPromptGenerator } from './prompt-generators.js';
import {
  createReporter,
  DEFAULT_REPORTER,
  type ReporterSpec,
} from './reporters.js';
import type { LoopCliConfig } from './types.js';
import { Git } from './util/git.js';

/**
 * One line of a `--doctor` report. Structured so a future `--json` mode can
 * serialize results without breaking the text contract.
 */
export interface CheckResult {
  /** Short check name, e.g. "ANTHROPIC_API_KEY set". */
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  /** Human detail or error text. */
  readonly message?: string;
  /** Underlying error, surfaced via the logger when --verbose. */
  readonly cause?: unknown;
}

/**
 * A check result tagged with the component it came from, used for formatting.
 */
interface TaggedResult {
  readonly kind: string;
  readonly name: string;
  readonly result: CheckResult;
}

const STATUS_WIDTH = 6;

/**
 * Default output sink. Injected in tests so they can collect lines without
 * spying on the console.
 */
function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Format a tagged result as a single self-contained line:
 *   [<status>] <component-kind> (<component-name>): <check-name>[ - <message>]
 */
function formatLine(tagged: TaggedResult): string {
  const tag = `[${tagged.result.status}]`.padEnd(STATUS_WIDTH);
  const head = `${tag} ${tagged.kind} (${tagged.name}): ${tagged.result.name}`;
  return tagged.result.message === undefined
    ? head
    : `${head} - ${tagged.result.message}`;
}

/**
 * Best-effort message extraction for thrown values.
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Verbose detail for a cause: an Error's stack (or message when absent),
 * otherwise the stringified value.
 */
function causeDetail(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }
  return String(cause);
}

/**
 * Human-readable name for a spec: a bare name string, the head of a tuple
 * spec, "default" for an absent spec, or "custom" for an inline instance.
 */
function describeSpec(spec: unknown, fallback: string): string {
  if (typeof spec === 'string') {
    return spec;
  }
  if (Array.isArray(spec)) {
    return String(spec[0]);
  }
  if (spec === undefined) {
    return fallback;
  }
  return 'custom';
}

/**
 * Run a single component's check(): one skip when absent, a synthetic fail
 * when the generator throws mid-iteration, otherwise each yielded result.
 */
async function* runCheck(
  kind: string,
  name: string,
  component: { check?(): AsyncIterable<CheckResult> },
): AsyncIterable<TaggedResult> {
  if (component.check === undefined) {
    yield {
      kind,
      name,
      result: {
        name: 'diagnostics',
        status: 'skip',
        message: 'no diagnostics defined',
      },
    };
    return;
  }
  try {
    for await (const result of component.check()) {
      yield { kind, name, result };
    }
  } catch (err) {
    yield {
      kind,
      name,
      result: {
        name: 'check',
        status: 'fail',
        message: errMessage(err),
        cause: err,
      },
    };
  }
}

/**
 * Construct a component then run its check. A construction failure becomes a
 * single fail for that component and does not abort the rest of the run.
 */
async function* buildAndCheck(
  kind: string,
  name: string,
  build: () => Promise<{ check?(): AsyncIterable<CheckResult> }>,
): AsyncIterable<TaggedResult> {
  let component: { check?(): AsyncIterable<CheckResult> };
  try {
    component = await build();
  } catch (err) {
    yield {
      kind,
      name,
      result: {
        name: 'construct',
        status: 'fail',
        message: errMessage(err),
        cause: err,
      },
    };
    return;
  }
  yield* runCheck(kind, name, component);
}

/**
 * Output directory writable probe (independent of any reporter).
 */
async function checkOutputDir(outputDir: string): Promise<CheckResult> {
  try {
    await access(outputDir, constants.W_OK);
    return {
      name: 'output directory writable',
      status: 'ok',
      message: outputDir,
    };
  } catch (err) {
    return {
      name: 'output directory writable',
      status: 'fail',
      message: errMessage(err),
      cause: err,
    };
  }
}

/**
 * Resumable state probe: skip when absent, ok when a valid v2 file loads,
 * fail when the Step 01 loader rejects a malformed or non-v2 file.
 */
async function checkResumableState(
  outputDir: string,
  jobName: string,
): Promise<CheckResult> {
  const path = join(outputDir, `${jobName}-loop-state.json`);
  try {
    await access(path, constants.F_OK);
  } catch {
    return {
      name: 'resumable state',
      status: 'skip',
      message: 'no state file to resume',
    };
  }
  try {
    await FileLoopState.create(path);
    return { name: 'resumable state', status: 'ok', message: path };
  } catch (err) {
    return {
      name: 'resumable state',
      status: 'fail',
      message: errMessage(err),
      cause: err,
    };
  }
}

/**
 * Cross-cutting environment checks: output dir, resumable state, and (only
 * when allowSourceUpdate is set) the shared git preflight.
 */
async function* environmentChecks(
  config: LoopCliConfig,
): AsyncIterable<TaggedResult> {
  const kind = 'environment';
  const name = config.name;
  const outputDir = config.outputDir ?? process.cwd();

  yield { kind, name, result: await checkOutputDir(outputDir) };
  yield {
    kind,
    name,
    result: await checkResumableState(outputDir, config.name),
  };

  if (config.allowSourceUpdate === true) {
    const items = await gitPreflight(new Git(process.cwd()));
    for (const item of items) {
      const status = item.ok ? 'ok' : 'fail';
      yield {
        kind,
        name,
        result:
          item.message === undefined
            ? { name: item.name, status }
            : { name: item.name, status, message: item.message },
      };
    }
  }
}

/**
 * Run all preflight checks for the resolved config, streaming each result as
 * a formatted line. Returns false iff any check failed (the CLI maps this to
 * exit code 1). Never invokes the main loop.
 */
export async function doctor(
  config: LoopCliConfig,
  logger: Logger,
  write: (line: string) => void = defaultWrite,
): Promise<boolean> {
  const outputDir = config.outputDir ?? process.cwd();
  const reporterSpec: ReporterSpec | undefined = config.reporter;

  const sources: Array<AsyncIterable<TaggedResult>> = [
    buildAndCheck('agent', describeSpec(config.agent, 'default'), () =>
      createAgent(config.agent),
    ),
    buildAndCheck(
      'prompt-generator',
      describeSpec(config.promptGenerator, 'default'),
      () => createPromptGenerator(config.promptGenerator),
    ),
    buildAndCheck(
      'reporter',
      describeSpec(reporterSpec, DEFAULT_REPORTER),
      () => {
        if (reporterSpec !== undefined && typeof reporterSpec !== 'string') {
          return Promise.resolve(reporterSpec);
        }
        return createReporter(reporterSpec, {
          outputDir,
          jobName: config.name,
        });
      },
    ),
    environmentChecks(config),
  ];

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  let anyFail = false;

  for (const source of sources) {
    for await (const tagged of source) {
      write(formatLine(tagged));
      counts[tagged.result.status] += 1;
      if (tagged.result.status === 'fail') {
        anyFail = true;
      }
      if (tagged.result.cause !== undefined && logger.enabled) {
        logger.error(causeDetail(tagged.result.cause));
      }
    }
  }

  write(
    `Summary: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip`,
  );
  return !anyFail;
}
