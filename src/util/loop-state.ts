import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  LoopState,
  LoopStateSnapshot,
  LoopStateResult,
  PromptClaim,
  PromptOutcome,
} from '../loop-states.js';

interface FailedState {
  readonly id: string;
  readonly reason: string;
}

interface PersistedLoopState {
  readonly version?: number;
  readonly results?: Record<string, PromptOutcome>;
  readonly claims?: Record<string, PromptClaim>;
  readonly totalUsd?: number;
  readonly completed?: Array<string>;
  readonly failed?: Array<FailedState>;
  readonly inProgress?: string | Array<string> | Record<string, Array<string>>;
}

/**
 * Persisted state for a running or interrupted loop. Saved before and
 * after every prompt execution so that any interruption loses at most one
 * item's work.
 */
export class FileLoopState implements LoopState {
  #path: string;
  #results: Map<string, PromptOutcome>;
  #claims: Map<string, PromptClaim>;
  #totalUsd: number;
  #saveChain: Promise<void> = Promise.resolve();

  /**
   * Compatibility constructor for tests and programmatic callers that build
   * an in-memory state from the old completed/failed arrays.
   */
  constructor(
    path: string,
    completed: Array<string> = [],
    failed: Array<FailedState> = [],
    _inProgress?: string,
  ) {
    this.#path = path;
    this.#results = migrateResults(completed, failed);
    this.#claims = new Map();
    this.#totalUsd = 0;
  }

  /**
   * Create a StateManager for the given task. If saved state exists on disk
   * from a previous interrupted run, it is loaded automatically. Otherwise
   * fresh state is created.
   */
  static async create(path: string): Promise<FileLoopState> {
    try {
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw) as PersistedLoopState;
      return FileLoopState.fromPersisted(path, data);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return new FileLoopState(path);
      }
      throw error;
    }
  }

  static fromPersisted(path: string, data: PersistedLoopState): FileLoopState {
    const state = new FileLoopState(path);
    state.#results =
      data.results === undefined
        ? migrateResults(data.completed ?? [], data.failed ?? [])
        : new Map(Object.entries(data.results));
    state.#claims =
      data.claims === undefined
        ? new Map()
        : new Map(Object.entries(data.claims));
    state.#totalUsd = isUsableTotal(data.totalUsd) ? data.totalUsd : 0;
    return state;
  }

  isOutstanding(id: string): boolean {
    return !this.#results.has(id);
  }

  async claim(runId: string, id: string): Promise<boolean> {
    if (this.#results.has(id)) {
      return false;
    }

    const claim = this.#claims.get(id);
    if (claim !== undefined && claim.runId !== runId) {
      return false;
    }

    if (claim === undefined) {
      this.#claims.set(id, {
        runId,
        claimedAt: new Date().toISOString(),
      });
      await this.save();
    }

    return true;
  }

  async complete(
    runId: string,
    id: string,
    result: LoopStateResult,
  ): Promise<void> {
    const claim = this.#claims.get(id);
    if (claim !== undefined && claim.runId !== runId) {
      return;
    }

    this.#addCost(result);

    if (result.status === 'success') {
      this.#results.set(id, {
        status: 'success',
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
      });
    }
    if (result.status === 'error') {
      this.#results.set(id, {
        status: 'error',
        reason: result.reason,
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
      });
    }

    this.#claims.delete(id);
    await this.save();
  }

  async release(runId: string): Promise<void> {
    let changed = false;
    for (const [id, claim] of this.#claims) {
      if (claim.runId === runId) {
        this.#claims.delete(id);
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  async getSnapshot(): Promise<LoopStateSnapshot> {
    return this.#snapshot();
  }

  get completed(): ReadonlyArray<string> {
    return Array.from(this.#results.entries())
      .filter(([, outcome]) => outcome.status === 'success')
      .map(([id]) => id);
  }

  get failed(): ReadonlyArray<FailedState> {
    return Array.from(this.#results.entries())
      .filter(([, outcome]) => outcome.status === 'error')
      .map(([id, outcome]) => ({ id, reason: outcome.reason ?? '' }));
  }

  get totalUsd(): number {
    return this.#totalUsd;
  }

  /**
   * Persist the current state to disk
   */
  async save(): Promise<void> {
    const next = this.#saveChain.then(() => this.#writeSnapshot());
    this.#saveChain = next.catch(() => {});
    await next;
  }

  #addCost(result: LoopStateResult): void {
    const cost = result.cost;
    if (
      cost === undefined ||
      cost.costSource === 'unavailable' ||
      !Number.isFinite(cost.usd) ||
      cost.usd < 0
    ) {
      return;
    }

    this.#totalUsd += cost.usd;
  }

  #snapshot(): LoopStateSnapshot {
    return {
      version: 2,
      results: Object.fromEntries(this.#results),
      claims: Object.fromEntries(this.#claims),
      totalUsd: this.#totalUsd,
    };
  }

  async #writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(
      this.#path,
      `${JSON.stringify(this.#snapshot(), null, 2)}\n`,
    );
  }
}

function migrateResults(
  completed: ReadonlyArray<string>,
  failed: ReadonlyArray<FailedState>,
): Map<string, PromptOutcome> {
  const results = new Map<string, PromptOutcome>();
  for (const id of completed) {
    results.set(id, { status: 'success' });
  }
  for (const item of failed) {
    results.set(item.id, { status: 'error', reason: item.reason });
  }
  return results;
}

function isUsableTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
