import type { CostInfo, InvokeResult } from './types.js';
import { FileLoopState } from './util/loop-state.js';

export type { CostInfo } from './types.js';

export type LoopStateResult = InvokeResult;

export interface PromptOutcome {
  readonly status: 'success' | 'error';
  readonly reason?: string;
  readonly cost?: CostInfo;
}

export interface PromptClaim {
  readonly runId: string;
  readonly claimedAt: string;
  readonly expiresAt?: string;
}

export interface LoopStateSnapshot {
  readonly version: 2;
  readonly results: Readonly<Record<string, PromptOutcome>>;
  readonly claims: Readonly<Record<string, PromptClaim>>;
  readonly totalUsd: number;
}

/**
 * Shared state contract used by prompt generators and the loop runner.
 */
export interface LoopState {
  isOutstanding(id: string): boolean;
  claim(runId: string, id: string): Promise<boolean>;
  complete(runId: string, id: string, result: LoopStateResult): Promise<void>;
  release(runId: string): Promise<void>;
  getSnapshot(): Promise<LoopStateSnapshot>;
}

/**
 * Create the default filesystem-backed loop state store.
 */
export async function createLoopState(path: string): Promise<LoopState> {
  return FileLoopState.create(path);
}
