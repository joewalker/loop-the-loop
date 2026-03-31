import { styleText } from 'node:util';

/**
 * The interface every logger must implement.
 *
 * A logger receives categorised diagnostic messages from the loop
 * and its agents. Each method corresponds to a semantic category of event.
 */
export interface Logger {
  /** Whether this logger will actually emit output. */
  readonly enabled: boolean;

  /** Agent assistant text. */
  agent(message: string): void;
  /** Tool use and tool progress. */
  tool(message: string): void;
  /** Success outcomes. */
  success(message: string): void;
  /** Errors and glitches. */
  error(message: string): void;
  /** System and SDK messages. */
  system(message: string): void;
  /** Loop state transitions. */
  state(message: string): void;
  /** Low-priority info like pauses. */
  info(message: string): void;
}

type Color = 'cyan' | 'yellow' | 'green' | 'red' | 'magenta' | 'blue' | 'gray';

/**
 * A colored logger that writes diagnostic messages to stderr.
 *
 * Each category of message gets a distinct color:
 * - cyan: agent messages (assistant text)
 * - yellow: tool use and tool progress
 * - green: success outcomes
 * - red: errors and glitches
 * - magenta: system / SDK messages
 * - blue: loop state transitions
 * - gray: low-priority info (pauses, skips)
 */
export class VerboseLogger implements Logger {
  #enabled: boolean;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Agent assistant text (cyan) */
  agent(message: string): void {
    this.#log('cyan', 'agent', message);
  }

  /** Tool use and tool progress (yellow) */
  tool(message: string): void {
    this.#log('yellow', 'tool', message);
  }

  /** Success outcomes (green) */
  success(message: string): void {
    this.#log('green', 'success', message);
  }

  /** Errors and glitches (red) */
  error(message: string): void {
    this.#log('red', 'error', message);
  }

  /** System and SDK messages (magenta) */
  system(message: string): void {
    this.#log('magenta', 'system', message);
  }

  /** Loop state transitions (blue) */
  state(message: string): void {
    this.#log('blue', 'state', message);
  }

  /** Low-priority info like pauses (gray) */
  info(message: string): void {
    this.#log('gray', 'info', message);
  }

  #log(color: Color, label: string, message: string): void {
    if (!this.#enabled) {
      return;
    }
    console.error(styleText(color, `[${label}] ${message}`));
  }
}

/**
 * A logger spec can be a concrete `Logger` instance, the string `'verbose'`
 * (which creates an enabled `VerboseLogger`), or `undefined` (quiet).
 */
export type LoggerSpec = Logger | 'verbose' | undefined;

/**
 * Resolve a `LoggerSpec` into a concrete `Logger` instance.
 */
export function createLogger(loggerSpec: LoggerSpec): Logger {
  if (loggerSpec === 'verbose') {
    return new VerboseLogger(true);
  }
  return loggerSpec ?? new VerboseLogger(false);
}
