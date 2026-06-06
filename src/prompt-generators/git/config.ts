import type { GitTask } from '../git.js';
import {
  assertKnownProperties,
  assertOptionalString,
  assertRequiredString,
  isRecord,
} from '../util/config.js';

/**
 * Normalize git task config values loaded from JSON.
 */
export function normalizeGitTaskConfig(config: unknown): GitTask {
  assertGitTaskConfig(config);
  return config;
}

/**
 * Assert that an unknown value has the runtime shape required for a git task
 * config.
 */
function assertGitTaskConfig(value: unknown): asserts value is GitTask {
  if (!isRecord(value)) {
    throw new Error('git task config must be an object');
  }

  assertKnownProperties(value, ['range', 'repoPath', 'promptTemplate'], 'git');
  assertRequiredString(value, 'range', 'git.range');
  assertRequiredString(value, 'promptTemplate', 'git.promptTemplate');
  assertOptionalString(value, 'repoPath', 'git.repoPath');
}
