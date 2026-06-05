import { join } from 'node:path';

import { FileLoopState } from './loop-states/file.js';
import type { CostInfo, InvokeResult } from './types.js';

export type { CostInfo, LoopRunResult } from './types.js';

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
 * Where a backend should write its state, mirroring `ReporterConfig`.
 * The filesystem backend turns this into
 * `${outputDir}/${jobName}-loop-state.json`.
 */
export interface LoopStateConfig {
  readonly outputDir: string;
  readonly jobName: string;
}

export const DEFAULT_LOOP_STATE = 'file';

/**
 * Construct the default filesystem-backed store. Later steps register an
 * `s3` entry alongside this with no change to callers.
 */
function createFileLoopState(config: LoopStateConfig): Promise<LoopState> {
  const path = join(config.outputDir, `${config.jobName}-loop-state.json`);
  return FileLoopState.create(path);
}

/**
 * To add a new loop-state backend, add its creator function here.
 */
const loopStateConstructors = {
  [DEFAULT_LOOP_STATE]: createFileLoopState,
} satisfies Record<string, (config: LoopStateConfig) => Promise<LoopState>>;

/**
 * Enable TypeScript to know what loop-state backends are available.
 */
type LoopStateName = keyof typeof loopStateConstructors;

/**
 * Allow easy switching between loop-state backends, shaped like
 * `createReporter` so backend selection can be added later without
 * changing callers again.
 */
export function createLoopState(
  type: LoopStateName = DEFAULT_LOOP_STATE,
  config: LoopStateConfig,
): Promise<LoopState> {
  return loopStateConstructors[type](config);
}
