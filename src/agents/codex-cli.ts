import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, InvokeOptions } from '../agents.js';
import type { CheckResult } from '../doctor.js';
import type { Logger } from '../loggers.js';
import type { CostInfo, InvokeResult } from '../types.js';
import {
  estimateCost,
  type ModelPrice,
  type TokenUsage,
} from '../util/pricing.js';

// istanbul ignore file

const CODEX_MODEL = process.env['CODEX_MODEL'];

const MAX_CODEX_CAPTURED_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * How long to wait after sending SIGTERM before escalating to SIGKILL.
 */
const KILL_GRACE_PERIOD_MS = 5_000;

type JsonObject = Record<string, unknown>;

/**
 * Configuration for `CodexCLIAgent`. Currently scoped to timeout behaviour
 * but designed to grow alongside the Codex CLI surface.
 */
export interface CodexCLIAgentConfig {
  /**
   * Maximum time in milliseconds to wait for a single Codex invocation to
   * complete before sending SIGTERM (and SIGKILL after a short grace
   * period). When omitted no timeout is applied.
   */
  readonly timeoutMs?: number;

  /**
   * Codex model to run. Forwarded to `codex exec --model` and used for cost
   * estimation. Falls back to the `CODEX_MODEL` env var when omitted.
   */
  readonly model?: string;

  /**
   * Per-model prices keyed by model id. When the resolved model is priced
   * the agent estimates USD cost; otherwise it records tokens only.
   */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
}

/**
 * An implementation of the Agent interface that uses Codex via the command
 * line
 */
export class CodexCLIAgent implements Agent {
  static readonly agentName = 'codex-cli';

  static async create(config?: CodexCLIAgentConfig): Promise<Agent> {
    return new CodexCLIAgent(config);
  }

  readonly #config: CodexCLIAgentConfig;

  constructor(config: CodexCLIAgentConfig = {}) {
    this.#config = config;
  }

  /**
   * Invoke the Codex CLI for a single file and return the final agent output.
   */
  async invoke(prompt: string, options?: InvokeOptions): Promise<InvokeResult> {
    const outputPath = createOutputPath();
    const resolvedModel = this.#config.model ?? CODEX_MODEL;
    const args = buildCommandArgs(outputPath, prompt, resolvedModel, options);

    try {
      const timeoutMs = this.#config.timeoutMs;
      const codexResult = await runCodex(args, options?.logger, {
        timeoutMs,
      });

      if (codexResult.timedOut) {
        return {
          status: 'glitch',
          reason: `Codex timed out after ${String(timeoutMs)}ms`,
          ...withCodexCost(
            codexResult.tokenUsage,
            this.#config,
            options?.logger,
          ),
        };
      }

      if (codexResult.code === 0 && codexResult.error === undefined) {
        const output = await safeReadOutput(outputPath);
        if (!output) {
          return {
            status: 'error',
            reason: 'No output received from Codex',
            ...withCodexCost(
              codexResult.tokenUsage,
              this.#config,
              options?.logger,
            ),
          };
        }

        return {
          status: 'success',
          output,
          ...withCodexCost(
            codexResult.tokenUsage,
            this.#config,
            options?.logger,
          ),
        };
      }

      const output = await safeReadOutput(outputPath);
      const baseError = buildExecErrorText(codexResult);
      const reason =
        (output ? `${baseError}\n${output}` : baseError).trim() ||
        'Codex invocation failed with no error output';

      // Classify only from process metadata (`baseError`), never from the
      // assistant body. Otherwise prompts that elicit words like "token"
      // would be misclassified as transient glitches and retried up to
      // MAX_CONSECUTIVE_GLITCHES times. See issue #14.
      const status = isTokenLimitError(baseError) ? 'glitch' : 'error';
      return {
        status,
        reason,
        ...withCodexCost(codexResult.tokenUsage, this.#config, options?.logger),
      };
    } finally {
      try {
        await rm(outputPath, { force: true });
      } catch {
        // Best effort cleanup for temp file
      }
    }
  }

  /**
   * Preflight probe used by `--doctor`.
   *
   * Probes, in order: the `codex` binary is resolvable on PATH (spawns
   * `codex --version`), `CODEX_MODEL` is configured (a warning when unset
   * since codex has its own default), and the configured `timeoutMs` is a
   * positive integer when present. Any unexpected probe error is caught and
   * surfaced as a fail rather than propagated.
   */
  async *check(): AsyncIterable<CheckResult> {
    yield await probeCodexVersion();

    const model = process.env['CODEX_MODEL'];
    yield model !== undefined && model.length > 0
      ? { name: 'CODEX_MODEL set', status: 'ok', message: model }
      : {
          name: 'CODEX_MODEL set',
          status: 'warn',
          message: 'CODEX_MODEL not set; codex default will be used',
        };

    const timeoutMs = this.#config.timeoutMs;
    yield timeoutMs === undefined ||
    (Number.isInteger(timeoutMs) && timeoutMs > 0)
      ? { name: 'timeoutMs valid', status: 'ok' }
      : {
          name: 'timeoutMs valid',
          status: 'fail',
          message: 'timeoutMs must be a positive integer when set',
        };
  }
}

/**
 * Spawn `codex --version` and report the resolved binary as a CheckResult.
 *
 * A spawn `error` (typically `ENOENT` when codex is not on PATH) or a
 * non-zero exit produces a `fail`; otherwise the trimmed stdout/stderr is
 * reported as the detected version.
 */
function probeCodexVersion(): Promise<CheckResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: CheckResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('codex', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        name: 'codex on PATH',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', err => {
      finish({
        name: 'codex on PATH',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    });

    child.on('close', code => {
      if (code === 0) {
        const version = stdout.trim() || stderr.trim() || 'codex';
        finish({ name: 'codex on PATH', status: 'ok', message: version });
        return;
      }
      const detail = stderr.trim();
      finish({
        name: 'codex on PATH',
        status: 'fail',
        message:
          detail.length > 0
            ? `codex --version exited with code ${String(code)}: ${detail}`
            : `codex --version exited with code ${String(code)}`,
      });
    });
  });
}

interface CodexProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly capturedStdoutBytes: number;
  readonly capturedStderrBytes: number;
  readonly truncatedStdoutBytes: number;
  readonly truncatedStderrBytes: number;
  readonly maxCapturedOutputBytes: number;
  readonly error?: Error | undefined;
  readonly timedOut?: boolean;
  readonly tokenUsage?: TokenUsage;
}

interface RunCodexOptions {
  readonly timeoutMs?: number | undefined;
}

/**
 * Return whether Codex process metadata looks like a transient token/quota
 * failure. The patterns here are intentionally narrow: the bare word
 * `token` matches far too many unrelated errors (tokenisers, JWTs, OAuth
 * tokens, etc.), so we require a phrase that is specific to model token
 * accounting. See issue #14.
 */
function isTokenLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('tokens remaining') ||
    lower.includes('token limit') ||
    lower.includes('token quota') ||
    lower.includes('context window') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('429')
  );
}

/**
 * Translate task configuration into `codex exec` arguments.
 */
function buildCommandArgs(
  outputPath: string,
  prompt: string,
  model: string | undefined,
  options?: InvokeOptions,
): Array<string> {
  const sandboxMode =
    options?.allowSourceUpdate === true ? 'workspace-write' : 'read-only';
  const args: Array<string> = [
    'exec',
    '--json',
    '--ephemeral',
    '--color',
    'never',
    '--output-last-message',
    outputPath,
    '--sandbox',
    sandboxMode,
  ];

  if (model !== undefined && model.length > 0) {
    args.push('--model', model);
  }

  args.push(prompt);
  return args;
}

/**
 * Spawn Codex and stream JSONL status events into the verbose logger.
 *
 * When `runOptions.timeoutMs` is set, the child is sent SIGTERM if it does
 * not exit in time and then escalated to SIGKILL after a short grace
 * period, and the returned result has `timedOut` set so the caller can
 * classify the outcome.
 */
function runCodex(
  args: ReadonlyArray<string>,
  logger?: Logger | undefined,
  runOptions: RunCodexOptions = {},
): Promise<CodexProcessResult> {
  return new Promise(resolve => {
    const child = spawn('codex', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tokens = new TokenAccumulator();
    // Always parse stdout for token_count events, even when the logger is
    // disabled, so cost is tracked in quiet mode too.
    const tokenBuffer = new LineBuffer(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        return;
      }
      if (isJsonObject(parsed)) {
        tokens.observe(parsed);
      }
    });
    const stdoutLogger = logger?.enabled
      ? new LineBuffer(line => {
          logCodexJsonLine(line, logger);
        })
      : undefined;
    const stderrLogger = logger?.enabled
      ? new LineBuffer(line => {
          if (line.trim().length > 0) {
            logger.system(`[stderr] ${line.trim()}`);
          }
        })
      : undefined;
    const output = new CappedProcessOutput(MAX_CODEX_CAPTURED_OUTPUT_BYTES);
    let settled = false;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle: ReturnType<typeof setTimeout> | undefined;

    const safeKill = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // Best effort: the child may already have exited.
      }
    };

    const escalateToSigkill = (): void => {
      if (killHandle !== undefined) {
        return;
      }
      killHandle = setTimeout(() => {
        safeKill('SIGKILL');
      }, KILL_GRACE_PERIOD_MS);
      killHandle.unref?.();
    };

    const cleanupTimers = (): void => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (killHandle !== undefined) {
        clearTimeout(killHandle);
        killHandle = undefined;
      }
    };

    const finish = (result: CodexProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      tokenBuffer.flush();
      stdoutLogger?.flush();
      stderrLogger?.flush();
      const usage = tokens.snapshot();
      const annotated: CodexProcessResult = {
        ...result,
        ...(timedOut ? { timedOut: true } : {}),
        ...(usage !== undefined ? { tokenUsage: usage } : {}),
      };
      resolve(annotated);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output.appendStdout(chunk);
      tokenBuffer.add(chunk);
      stdoutLogger?.add(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output.appendStderr(chunk);
      stderrLogger?.add(chunk);
    });

    child.on('error', error => {
      finish(output.toResult(null, null, error));
    });

    child.on('exit', (code, exitSignal) => {
      // `close` waits for stdio streams to close. After a timeout, a
      // descendant process can keep those streams open even though the Codex
      // process itself has exited. In that case settle on `exit` so the
      // timeout actually unblocks the caller.
      if (timedOut) {
        finish(output.toResult(code, exitSignal));
      }
    });

    child.on('close', (code, closeSignal) => {
      finish(output.toResult(code, closeSignal));
    });

    if (runOptions.timeoutMs !== undefined && runOptions.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        safeKill('SIGTERM');
        escalateToSigkill();
      }, runOptions.timeoutMs);
      timeoutHandle.unref?.();
    }
  });
}

class CappedProcessOutput {
  #maxCapturedBytes: number;
  #stdout = '';
  #stderr = '';
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #capturedStdoutBytes = 0;
  #capturedStderrBytes = 0;

  constructor(maxCapturedBytes: number) {
    this.#maxCapturedBytes = maxCapturedBytes;
  }

  appendStdout(chunk: string): void {
    this.#stdoutBytes += byteLength(chunk);
    const captured = this.#capture(chunk, this.#capturedStdoutBytes);
    this.#stdout += captured;
    this.#capturedStdoutBytes += byteLength(captured);
  }

  appendStderr(chunk: string): void {
    this.#stderrBytes += byteLength(chunk);
    const captured = this.#capture(chunk, this.#capturedStderrBytes);
    this.#stderr += captured;
    this.#capturedStderrBytes += byteLength(captured);
  }

  toResult(
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error | undefined,
  ): CodexProcessResult {
    const baseResult = {
      code,
      signal,
      stdout: this.#stdout,
      stderr: this.#stderr,
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      capturedStdoutBytes: this.#capturedStdoutBytes,
      capturedStderrBytes: this.#capturedStderrBytes,
      truncatedStdoutBytes: this.#truncatedStdoutBytes,
      truncatedStderrBytes: this.#truncatedStderrBytes,
      maxCapturedOutputBytes: this.#maxCapturedBytes,
    };
    return error === undefined ? baseResult : { ...baseResult, error };
  }

  get #truncatedStdoutBytes(): number {
    return Math.max(0, this.#stdoutBytes - this.#capturedStdoutBytes);
  }

  get #truncatedStderrBytes(): number {
    return Math.max(0, this.#stderrBytes - this.#capturedStderrBytes);
  }

  #capture(chunk: string, capturedBytes: number): string {
    const remainingBytes = this.#maxCapturedBytes - capturedBytes;
    if (remainingBytes <= 0) {
      return '';
    }

    return byteLength(chunk) <= remainingBytes
      ? chunk
      : sliceByUtf8Bytes(chunk, remainingBytes);
  }
}

class LineBuffer {
  #buffer = '';
  #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  add(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/u);
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.#onLine(line);
    }
  }

  flush(): void {
    if (this.#buffer.length > 0) {
      this.#onLine(this.#buffer);
      this.#buffer = '';
    }
  }
}

/**
 * Accumulates token usage from Codex `token_count` JSONL events. Codex
 * reports cumulative totals (not per-turn deltas) so the accumulator keeps
 * the latest snapshot seen. Both the top-level (`event.type`) and the
 * msg-wrapped (`event.msg.type`) shapes Codex has shipped are recognised.
 */
export class TokenAccumulator {
  #latest: TokenUsage | undefined;

  /**
   * Observe a parsed JSONL event, updating the latest snapshot when it is a
   * recognised `token_count` event.
   */
  observe(event: JsonObject): void {
    const usage = tokenCountUsage(event);
    if (usage !== undefined) {
      this.#latest = usage;
    }
  }

  /**
   * Return the latest cumulative token usage seen, or undefined when no
   * `token_count` event has been observed.
   */
  snapshot(): TokenUsage | undefined {
    return this.#latest;
  }
}

/**
 * Return normalised token usage if `event` is a `token_count` event in
 * either shape, otherwise undefined. Totals are read from
 * `info.total_token_usage`, falling back to `info`, then the carrier itself.
 */
function tokenCountUsage(event: JsonObject): TokenUsage | undefined {
  const carrier =
    event['type'] === 'token_count'
      ? event
      : getObject(event['msg'])?.['type'] === 'token_count'
        ? getObject(event['msg'])
        : undefined;
  if (carrier === undefined) {
    return undefined;
  }

  const info = getObject(carrier['info']);
  const totals = getObject(info?.['total_token_usage']) ?? info ?? carrier;

  return {
    inputTokens: numberAt(totals, 'input_tokens'),
    outputTokens: numberAt(totals, 'output_tokens'),
    cacheReadTokens: numberAt(totals, 'cached_input_tokens'),
    reasoningTokens: numberAt(totals, 'reasoning_output_tokens'),
  };
}

/**
 * Read a finite numeric property from a record, defaulting to 0.
 */
function numberAt(obj: JsonObject, key: string): number {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Build a `CostInfo` from accumulated Codex usage: estimated when the
 * resolved model is priced, otherwise `'unavailable'` with tokens only.
 */
export function buildCodexCost(
  usage: TokenUsage | undefined,
  config: CodexCLIAgentConfig,
  logger: Logger | undefined,
): CostInfo | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const model = config.model ?? CODEX_MODEL ?? 'unknown';
  const tokenFields = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    model,
  };
  const estimate =
    config.prices !== undefined
      ? estimateCost(model, usage, config.prices)
      : undefined;
  if (estimate === undefined) {
    logger?.system(
      `No pricing configured for codex-cli model '${model}'; recording tokens only`,
    );
    return { usd: 0, costSource: 'unavailable', ...tokenFields };
  }
  return { usd: estimate.usd, costSource: 'estimated', ...tokenFields };
}

/**
 * Return `{ cost }` when usage produces a `CostInfo`, otherwise an empty
 * object so the field is omitted from the spread.
 */
function withCodexCost(
  usage: TokenUsage | undefined,
  config: CodexCLIAgentConfig,
  logger: Logger | undefined,
): { cost?: CostInfo } {
  const cost = buildCodexCost(usage, config, logger);
  return cost !== undefined ? { cost } : {};
}

/**
 * Parse a Codex JSONL stdout line and emit it through the verbose logger.
 */
function logCodexJsonLine(line: string, logger?: Logger | undefined): void {
  if (!logger?.enabled) {
    return;
  }

  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    logger.system(`[codex] ${trimmed}`);
    return;
  }

  if (!isJsonObject(event)) {
    logger.system(`[codex] ${trimmed}`);
    return;
  }

  logCodexEvent(event, logger);
}

/**
 * Route a parsed Codex event to the closest logger category.
 */
function logCodexEvent(event: JsonObject, logger: Logger): void {
  const eventType = getEventType(event);
  const message = formatCodexEventMessage(event);
  const kind = getEventKind(event).toLowerCase();
  const formatted = `[${eventType}] ${message}`;

  if (kind.includes('tool') || kind.includes('function_call')) {
    logger.tool(formatted);
  } else if (kind.includes('assistant') || kind.includes('agent_message')) {
    logger.agent(formatted);
  } else if (kind.includes('error') || kind.includes('failed')) {
    logger.error(formatted);
  } else if (kind.includes('turn') || kind.includes('session')) {
    logger.state(formatted);
  } else {
    logger.system(formatted);
  }
}

/**
 * Find the most useful event type label from a Codex JSON event.
 */
function getEventType(event: JsonObject): string {
  return (
    firstString([
      event['type'],
      getNestedValue(event, 'item', 'type'),
      getNestedValue(event, 'message', 'type'),
      getNestedValue(event, 'msg', 'type'),
      getNestedValue(event, 'event', 'type'),
    ]) ?? 'event'
  );
}

/**
 * Build a text blob used only for broad event categorisation.
 */
function getEventKind(event: JsonObject): string {
  return [
    event['type'],
    event['subtype'],
    event['role'],
    getNestedValue(event, 'item', 'type'),
    getNestedValue(event, 'item', 'role'),
    getNestedValue(event, 'message', 'type'),
    getNestedValue(event, 'message', 'role'),
    getNestedValue(event, 'msg', 'type'),
    getNestedValue(event, 'msg', 'role'),
    getNestedValue(event, 'event', 'type'),
    getNestedValue(event, 'event', 'role'),
  ]
    .filter(value => typeof value === 'string')
    .join(' ');
}

/**
 * Create the human-readable payload for a Codex event log line.
 */
function formatCodexEventMessage(event: JsonObject): string {
  return (
    formatToolCall(event) ??
    findText(event) ??
    truncate(JSON.stringify(event) ?? String(event))
  );
}

/**
 * Format tool-like Codex events as `name(input)` where possible.
 */
function formatToolCall(event: JsonObject): string | undefined {
  const item = getObject(event['item']);
  const message = getObject(event['message']);
  const msg = getObject(event['msg']);
  const toolName = firstString([
    event['name'],
    event['tool_name'],
    event['toolName'],
    item?.['name'],
    item?.['tool_name'],
    item?.['toolName'],
    message?.['name'],
    message?.['tool_name'],
    message?.['toolName'],
    msg?.['name'],
    msg?.['tool_name'],
    msg?.['toolName'],
  ]);
  if (toolName === undefined) {
    return firstString([
      event['command'],
      item?.['command'],
      message?.['command'],
      msg?.['command'],
    ]);
  }

  const input = firstDefined([
    event['input'],
    event['arguments'],
    event['args'],
    item?.['input'],
    item?.['arguments'],
    item?.['args'],
    message?.['input'],
    message?.['arguments'],
    message?.['args'],
    msg?.['input'],
    msg?.['arguments'],
    msg?.['args'],
  ]);

  if (input === undefined) {
    return toolName;
  }

  return `${toolName}(${formatValue(input)})`;
}

/**
 * Extract assistant/status text from common Codex event shapes.
 */
function findText(event: JsonObject): string | undefined {
  return (
    findTextInObject(event) ??
    findTextInObject(getObject(event['item'])) ??
    findTextInObject(getObject(event['message'])) ??
    findTextInObject(getObject(event['msg'])) ??
    findTextInObject(getObject(event['event']))
  );
}

/**
 * Extract text from a single JSON object, including text content blocks.
 */
function findTextInObject(obj: JsonObject | undefined): string | undefined {
  if (obj === undefined) {
    return undefined;
  }

  const text = firstString([
    obj['message'],
    obj['text'],
    obj['delta'],
    obj['output'],
    obj['summary'],
    obj['content'],
  ]);
  if (text !== undefined) {
    return text;
  }

  const content = obj['content'];
  if (Array.isArray(content)) {
    const textParts = content
      .map(block => getObject(block))
      .map(block => firstString([block?.['text'], block?.['content']]))
      .filter(textPart => textPart !== undefined);
    return textParts.length > 0 ? textParts.join('') : undefined;
  }

  return undefined;
}

/**
 * Return the first non-empty string in a list.
 */
function firstString(values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Return the first value that is not `undefined`.
 */
function firstDefined(values: ReadonlyArray<unknown>): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Read a nested property from a JSON object when the parent is an object.
 */
function getNestedValue(
  obj: JsonObject,
  firstKey: string,
  secondKey: string,
): unknown {
  return getObject(obj[firstKey])?.[secondKey];
}

/**
 * Narrow an unknown value to a JSON object.
 */
function getObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

/**
 * Return whether an unknown value is a non-array JSON object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Format a JSON value for inclusion in a single verbose log line.
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * Keep fallback JSON event logs to a manageable single-line size.
 */
function truncate(text: string): string {
  const maxLength = 1000;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * Count bytes in the same UTF-8 encoding used by child process streams.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Return a string prefix that fits within a UTF-8 byte budget.
 */
function sliceByUtf8Bytes(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low);
}

/**
 * Create a unique temp path to capture Codex final response text.
 */
function createOutputPath(): string {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return join(tmpdir(), `loop-the-loop-${nonce}.txt`);
}

/**
 * Read the captured output file, returning an empty string if unavailable.
 */
async function safeReadOutput(path: string): Promise<string> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim();
  } catch {
    return '';
  }
}

/**
 * Build a single error string from the child process result details.
 */
function buildExecErrorText(result: CodexProcessResult): string {
  const parts: Array<string> = [];
  if (result.error?.message) {
    parts.push(result.error.message);
  }
  if (result.stderr) {
    parts.push(result.stderr);
  }
  if (result.truncatedStdoutBytes > 0 || result.truncatedStderrBytes > 0) {
    parts.push(
      `captured stdout/stderr truncated: stdout kept ${result.capturedStdoutBytes} of ${result.stdoutBytes} bytes, stderr kept ${result.capturedStderrBytes} of ${result.stderrBytes} bytes (limit ${result.maxCapturedOutputBytes} per stream)`,
    );
  }
  if (result.code !== null) {
    parts.push(`exit code: ${String(result.code)}`);
  }
  if (result.signal !== null) {
    parts.push(`signal: ${result.signal}`);
  }
  return parts.join('\n').trim();
}
