import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  LoopState,
  LoopStateSnapshot,
  LoopStateResult,
  PromptClaim,
  PromptOutcome,
} from '../loop-states.js';

/**
 * The only persisted shape we accept. A file that is not `version: 2`
 * fails clearly on load rather than being silently migrated.
 */
interface PersistedLoopState {
  readonly version: number;
  readonly results?: Record<string, PromptOutcome>;
  readonly claims?: Record<string, PromptClaim>;
  readonly totalUsd?: number;
}

/**
 * Persisted state for a running or interrupted loop. Saved before and
 * after every prompt execution so that any interruption loses at most one
 * item's work. Writes go through a temp file and an atomic rename so an
 * interrupted write never leaves a half-written file.
 */
export class FileLoopState implements LoopState {
  #path: string;
  #results: Map<string, PromptOutcome>;
  #claims: Map<string, PromptClaim>;
  #totalUsd: number;
  #saveChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#results = new Map();
    this.#claims = new Map();
    this.#totalUsd = 0;
  }

  /**
   * Create a state store for the given path. If a saved v2 state file
   * exists it is loaded; if none exists a fresh store is returned; a file
   * that exists but is not v2 throws.
   */
  static async create(path: string): Promise<FileLoopState> {
    try {
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw) as unknown;
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

  static fromPersisted(path: string, data: unknown): FileLoopState {
    if (!isV2(data)) {
      throw new Error(
        `Unsupported loop-state file at ${path}: expected a { version: 2, … } document. ` +
          `Pre-v2 state files are not supported; delete it to start a fresh run.`,
      );
    }

    const state = new FileLoopState(path);
    state.#results = new Map(Object.entries(data.results ?? {}));
    state.#claims = new Map(Object.entries(data.claims ?? {}));
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

  get totalUsd(): number {
    return this.#totalUsd;
  }

  /**
   * Persist the current state to disk. Concurrent calls are serialized
   * through an internal chain so in-process updates are not lost.
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

  /**
   * Write the snapshot to a sibling temp file then rename it into place.
   * `rename` is atomic on a single filesystem, so a crash mid-write
   * leaves either the old file or the new file, never a partial one.
   */
  async #writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmpPath = `${this.#path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.#snapshot(), null, 2)}\n`);
    await rename(tmpPath, this.#path);
  }
}

/**
 * Narrow unknown parsed JSON to the supported v2 envelope. Only the
 * version is checked here; field shapes are trusted per the forward
 * contract (no legacy migration).
 */
function isV2(data: unknown): data is PersistedLoopState {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { version?: unknown }).version === 2
  );
}

function isUsableTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
