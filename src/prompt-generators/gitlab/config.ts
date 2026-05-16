import type { GitLabTask } from '../gitlab.js';
import {
  assertKnownProperties,
  assertOptionalBoolean,
  assertOptionalString,
  assertOptionalStringArray,
  assertRequiredString,
  isRecord,
  normalizeBasePath,
  type PromptGeneratorConfigContext,
} from '../util/config.js';

/**
 * Normalize GitLab task config values loaded from JSON.
 */
export function normalizeGitLabTaskConfig(
  config: unknown,
  context: PromptGeneratorConfigContext,
): GitLabTask {
  assertGitLabTaskConfig(config);

  return {
    ...config,
    basePath: normalizeBasePath(config.basePath, context.configDir),
  };
}

/**
 * Assert that an unknown value has the runtime shape required for a GitLab
 * task config.
 */
function assertGitLabTaskConfig(value: unknown): asserts value is GitLabTask {
  if (!isRecord(value)) {
    throw new Error('gitlab task config must be an object');
  }

  if (
    !('promptTemplate' in value) ||
    typeof value['promptTemplate'] !== 'string'
  ) {
    throw new Error('gitlab.promptTemplate must be a string');
  }

  if ('basePath' in value && typeof value['basePath'] !== 'string') {
    throw new Error('gitlab.basePath must be a string');
  }

  const search = value['search'];
  if (!isRecord(search)) {
    throw new Error('gitlab.search must be an object');
  }

  assertGitLabSearchParams(search);
}

/**
 * Assert that GitLab search params loaded from config use the expected
 * runtime field shapes.
 */
function assertGitLabSearchParams(search: Record<string, unknown>): void {
  assertKnownProperties(
    search,
    // Keep this list in sync with GitLabIssueSearchParams in
    // gitlab-types.ts and the gitlabSearchParams schema definition.
    [
      'assigneeUsername',
      'authorUsername',
      'confidential',
      'createdAfter',
      'createdBefore',
      'dryRun',
      'issueType',
      'labels',
      'logQuery',
      'maxResults',
      'milestone',
      'orderBy',
      'perPage',
      'project',
      'scope',
      'search',
      'sort',
      'state',
      'updatedAfter',
      'updatedBefore',
    ],
    'gitlab.search',
  );

  assertRequiredString(search, 'project', 'gitlab.search.project');
  assertOptionalString(search, 'state', 'gitlab.search.state');
  assertOptionalStringArray(search, 'labels', 'gitlab.search.labels');
  assertOptionalString(search, 'search', 'gitlab.search.search');
  assertOptionalString(search, 'milestone', 'gitlab.search.milestone');
  assertOptionalString(
    search,
    'authorUsername',
    'gitlab.search.authorUsername',
  );
  assertOptionalString(
    search,
    'assigneeUsername',
    'gitlab.search.assigneeUsername',
  );
  assertOptionalString(search, 'scope', 'gitlab.search.scope');
  assertOptionalString(search, 'orderBy', 'gitlab.search.orderBy');
  assertOptionalString(search, 'sort', 'gitlab.search.sort');
  assertOptionalString(search, 'createdAfter', 'gitlab.search.createdAfter');
  assertOptionalString(search, 'createdBefore', 'gitlab.search.createdBefore');
  assertOptionalString(search, 'updatedAfter', 'gitlab.search.updatedAfter');
  assertOptionalString(search, 'updatedBefore', 'gitlab.search.updatedBefore');
  assertOptionalString(search, 'issueType', 'gitlab.search.issueType');
  assertOptionalBoolean(search, 'confidential', 'gitlab.search.confidential');
  assertOptionalInteger(search, 'perPage', 'gitlab.search.perPage');
  assertOptionalInteger(search, 'maxResults', 'gitlab.search.maxResults');
  assertOptionalBoolean(search, 'dryRun', 'gitlab.search.dryRun');
  assertOptionalBoolean(search, 'logQuery', 'gitlab.search.logQuery');
}

/**
 * Assert that an optional object property is an integer.
 */
function assertOptionalInteger(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (key in value && !Number.isInteger(value[key])) {
    throw new Error(`${field} must be an integer`);
  }
}
