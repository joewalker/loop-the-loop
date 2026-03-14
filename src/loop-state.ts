import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { InvokeResult } from './types.js';

interface FailedState {
  readonly id: string;
  readonly reason: string;
}

interface PersistedLoopState {
  readonly completed?: Array<string>;
  readonly failed?: Array<FailedState>;
  readonly inProgress?: string;
}

/**
 * Persisted state for a running or interrupted agentic loop. Saved before and
 * after every prompt execution so that any interruption loses at most one
 * item's work.
 */
export class LoopState {
  #path: string;

  /**
   * ids that have been successfully processed
   */
  #completed: Array<string>;

  /**
   * IDs that failed (with error info) so we can skip them next time.
   */
  #failed: Array<FailedState>;

  /**
   * The ID currently being processed (if any)
   */
  #inProgress?: string | undefined;

  constructor(
    path: string,
    completed: Array<string> = [],
    failed: Array<FailedState> = [],
    inProgress?: string,
  ) {
    this.#path = path;
    this.#completed = completed;
    this.#failed = failed;
    this.#inProgress = inProgress;
  }

  /**
   * Create a StateManager for the given task. If saved state exists on disk
   * from a previous interrupted run, it is loaded automatically. Otherwise
   * fresh state is created.
   */
  static async create(path: string): Promise<LoopState> {
    try {
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw) as PersistedLoopState;
      return new LoopState(
        path,
        data.completed ?? [],
        data.failed ?? [],
        data.inProgress,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return new LoopState(path);
      }
      throw error;
    }
  }

  isOutstanding(id: string): boolean {
    return (
      !this.#completed.includes(id) && !this.#failed.some(f => f.id === id)
    );
  }

  async begin(id: string): Promise<void> {
    this.#inProgress = id;
    await this.save();
  }

  async end(id: string, result: InvokeResult): Promise<void> {
    if (result.status === 'success') {
      this.#completed.push(id);
    }
    if (result.status === 'error') {
      this.#failed.push({ id, reason: result.reason });
    }

    this.#inProgress = undefined;
    await this.save();
  }

  /**
   * Persist the current state to disk
   */
  async save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(
      this.#path,
      `${JSON.stringify(
        {
          completed: this.#completed,
          failed: this.#failed,
          inProgress: this.#inProgress,
        },
        null,
        2,
      )}\n`,
    );
  }
}
