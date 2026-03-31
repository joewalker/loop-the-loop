import { execFile as execFileCallback } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { InvokeResult } from '../types.js';
import type { Agent, InvokeOptions } from '../agents.js';

// istanbul ignore file

const execFile = promisify(execFileCallback);
const CODEX_MODEL = process.env['CODEX_MODEL'];

const sandboxMode = 'read-only'; //'workspace-write'

/**
 * An implementation of the Agent interface that uses Codex via the command
 * line
 */
export class CodexCLIAgent implements Agent {
  static readonly agentName = 'codex-cli';

  static async create(): Promise<Agent> {
    return new CodexCLIAgent();
  }

  #hasWarned = false;

  /**
   * Invoke the Codex CLI for a single file and return the final agent output.
   */
  async invoke(prompt: string, options?: InvokeOptions): Promise<InvokeResult> {
    if (!this.#hasWarned) {
      this.#hasWarned = CodexCLIAgent.#warnUnsupportedOptions(options);
    }

    const outputPath = createOutputPath();
    const fullPrompt =
      options?.systemPrompt !== undefined
        ? `${options.systemPrompt}\n\n${prompt}`
        : prompt;
    const args = buildCommandArgs(outputPath, fullPrompt);

    try {
      await execFile('codex', args, {
        maxBuffer: 10 * 1024 * 1024,
      });

      const output = await safeReadOutput(outputPath);
      if (!output) {
        return {
          status: 'error',
          reason: 'No output received from Codex',
        };
      }

      return { status: 'success', output };
    } catch (error) {
      const execError = error as ExecError;
      const output = await safeReadOutput(outputPath);
      const baseError = buildExecErrorText(execError);
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

  /**
   * Log a warning if unsupported options are present. Returns `true` when a
   * warning was emitted so the caller can avoid repeating it.
   */
  static #warnUnsupportedOptions(options?: InvokeOptions): boolean {
    const unsupported: Array<string> = [
      ...(options?.allowedTools != null ? ['allowedTools'] : []),
      ...(options?.disallowedTools != null ? ['disallowedTools'] : []),
      ...(options?.outputSchema != null ? ['outputSchema'] : []),
    ];
    if (unsupported.length > 0) {
      console.warn(
        `[codex-cli] Ignoring unsupported options: ${unsupported.join(', ')}`,
      );
      return true;
    }
    return false;
  }
}

interface ExecError extends Error {
  code?: number | string | null;
  stderr?: string;
  stdout?: string;
}

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
function buildCommandArgs(outputPath: string, prompt: string): Array<string> {
  const args: Array<string> = [
    'exec',
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
function buildExecErrorText(error: ExecError): string {
  const parts: Array<string> = [];
  if (error.message) {
    parts.push(error.message);
  }
  if (error.stdout) {
    parts.push(error.stdout);
  }
  if (error.stderr) {
    parts.push(error.stderr);
  }
  if (typeof error.code !== 'undefined') {
    parts.push(`exit code: ${String(error.code)}`);
  }
  return parts.join('\n').trim();
}
