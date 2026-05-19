import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, InvokeOptions } from '../agents.js';
import type { Logger } from '../loggers.js';
import type { InvokeResult } from '../types.js';

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
   * period). When omitted no timeout is applied. Callers can still cancel
   * a run via `InvokeOptions.signal`.
   */
  readonly timeoutMs?: number;
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
    const args = buildCommandArgs(outputPath, prompt, options);

    try {
      const timeoutMs = this.#config.timeoutMs;
      const codexResult = await runCodex(args, options?.logger, {
        timeoutMs,
        signal: options?.signal,
      });

      if (codexResult.timedOut) {
        return {
          status: 'glitch',
          reason: `Codex timed out after ${String(timeoutMs)}ms`,
        };
      }
      if (codexResult.aborted) {
        return {
          status: 'glitch',
          reason: 'Codex invocation aborted by caller',
        };
      }

      if (codexResult.code === 0 && codexResult.error === undefined) {
        const output = await safeReadOutput(outputPath);
        if (!output) {
          return {
            status: 'error',
            reason: 'No output received from Codex',
          };
        }

        return { status: 'success', output };
      }

      const output = await safeReadOutput(outputPath);
      const baseError = buildExecErrorText(codexResult);
      const errorText = (output ? `${baseError}\n${output}` : baseError).trim();

      const reason =
        errorText || 'Codex invocation failed with no error output';
      const status = isTokenLimitError(reason) ? 'glitch' : 'error';
      return { status, reason };
    } finally {
      try {
        await rm(outputPath, { force: true });
      } catch {
        // Best effort cleanup for temp file
      }
    }
  }
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
  readonly aborted?: boolean;
}

interface RunCodexOptions {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Return whether Codex output looks like a transient token/quota failure.
 */
function isTokenLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('token') ||
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

  if (CODEX_MODEL) {
    args.push('--model', CODEX_MODEL);
  }

  args.push(prompt);
  return args;
}

/**
 * Spawn Codex and stream JSONL status events into the verbose logger.
 *
 * When `runOptions.timeoutMs` is set, the child is sent SIGTERM if it does
 * not exit in time and then escalated to SIGKILL after a short grace
 * period. When `runOptions.signal` is provided, aborting the signal does
 * the same. In both cases the returned result has `timedOut` or `aborted`
 * set so the caller can classify the outcome.
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
    let aborted = false;
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

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      aborted = true;
      safeKill('SIGTERM');
      escalateToSigkill();
    };

    const signal = runOptions.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

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

    const finish = (result: CodexProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      stdoutLogger?.flush();
      stderrLogger?.flush();
      const annotated: CodexProcessResult = {
        ...result,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      };
      resolve(annotated);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output.appendStdout(chunk);
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

    child.on('close', (code, closeSignal) => {
      finish(output.toResult(code, closeSignal));
    });
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
