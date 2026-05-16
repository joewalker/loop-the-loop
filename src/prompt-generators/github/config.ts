import type { GitHubTask } from '../github.js';
import {
  isRecord,
  normalizeBasePath,
  type PromptGeneratorConfigContext,
} from '../util/config.js';

/**
 * Normalize GitHub task config values loaded from JSON.
 */
export function normalizeGitHubTaskConfig(
  config: unknown,
  context: PromptGeneratorConfigContext,
): GitHubTask {
  assertGitHubTaskConfig(config);

  return {
    ...config,
    basePath: normalizeBasePath(config.basePath, context.configDir),
  };
}

/**
 * Assert that an unknown value has the runtime shape required for a GitHub
 * task config.
 */
function assertGitHubTaskConfig(value: unknown): asserts value is GitHubTask {
  if (!isRecord(value)) {
    throw new Error('github task config must be an object');
  }

  if (
    !('promptTemplate' in value) ||
    typeof value['promptTemplate'] !== 'string'
  ) {
    throw new Error('github.promptTemplate must be a string');
  }

  if ('basePath' in value && typeof value['basePath'] !== 'string') {
    throw new Error('github.basePath must be a string');
  }

  const search = value['search'];
  if (!isRecord(search)) {
    throw new Error('github.search must be an object');
  }

  if (!('repository' in search) || typeof search['repository'] !== 'string') {
    throw new Error('github.search.repository must be a string');
  }

  if (!('query' in search) || typeof search['query'] !== 'string') {
    throw new Error('github.search.query must be a string');
  }
}
