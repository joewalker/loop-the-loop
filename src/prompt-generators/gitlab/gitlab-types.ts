export interface GitLabConstructorOptions {
  /**
   * GitLab REST API origin. Defaults to GitLab.com API v4. For GitLab
   * Self-Managed, use the API origin, for example
   * `https://gitlab.example.com/api/v4`.
   */
  readonly origin?: string;

  /**
   * GitLab access token. Prefer `tokenEnv` for CLI JSON configs so secrets do
   * not need to be written directly into config files.
   */
  readonly token?: string;

  /**
   * Environment variable name from which to read the GitLab access token.
   * When omitted, GITLAB_TOKEN and then GL_TOKEN are checked.
   */
  readonly tokenEnv?: string;

  /**
   * User-Agent header value for GitLab API requests.
   */
  readonly userAgent?: string;
}

/**
 * Query options for GitLab project issue search.
 */
export interface GitLabIssueSearchParams {
  /**
   * Project to search, as a numeric project ID or namespaced project path.
   */
  readonly project: string;

  /**
   * Return all issues or just opened or closed issues.
   */
  readonly state?: 'opened' | 'closed' | 'all';

  /**
   * Labels that all returned issues must have.
   */
  readonly labels?: ReadonlyArray<string>;

  /**
   * Search project issues against their title and description.
   */
  readonly search?: string;

  /**
   * Milestone title. GitLab also accepts `None` and `Any`.
   */
  readonly milestone?: string;

  /**
   * Return issues created by this username.
   */
  readonly authorUsername?: string;

  /**
   * Return issues assigned to this username.
   */
  readonly assigneeUsername?: string;

  /**
   * Return issues for the given scope.
   */
  readonly scope?: 'created_by_me' | 'assigned_to_me' | 'all';

  /**
   * Sort field accepted by GitLab project issue search.
   */
  readonly orderBy?: string;

  /**
   * Sort order.
   */
  readonly sort?: 'asc' | 'desc';

  /**
   * Return issues created on or after the given ISO 8601 timestamp.
   */
  readonly createdAfter?: string;

  /**
   * Return issues created on or before the given ISO 8601 timestamp.
   */
  readonly createdBefore?: string;

  /**
   * Return issues updated on or after the given ISO 8601 timestamp.
   */
  readonly updatedAfter?: string;

  /**
   * Return issues updated on or before the given ISO 8601 timestamp.
   */
  readonly updatedBefore?: string;

  /**
   * Filter to a GitLab issue type, for example `issue`, `incident`, `task`,
   * or `test_case`.
   */
  readonly issueType?: string;

  /**
   * Filter confidential or public issues.
   */
  readonly confidential?: boolean;

  /**
   * Number of results to request per API page. GitLab accepts 1 to 100.
   */
  readonly perPage?: number;

  /**
   * Maximum number of issues to return across all pages. When omitted, returns
   * all pages until GitLab stops returning a next page.
   */
  readonly maxResults?: number;

  /**
   * Don't actually query GitLab, instead return an empty set.
   */
  readonly dryRun?: boolean;

  /**
   * Write the queries to stdout just before they're sent.
   */
  readonly logQuery?: boolean;
}

/**
 * The subset of GitLab issue fields used by prompt generation. Additional API
 * response fields are accepted so templates can evolve without broad type
 * churn.
 */
export interface GitLabIssue {
  readonly iid: number;
  readonly title: string;
  readonly web_url: string;
  readonly state: string;
  readonly description?: string | null;
  readonly author?: GitLabUser | null;
  readonly assignee?: GitLabUser | null;
  readonly assignees?: ReadonlyArray<GitLabUser>;
  readonly labels?: ReadonlyArray<string>;
  readonly milestone?: GitLabMilestone | null;
  readonly user_notes_count?: number;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly closed_at?: string | null;
  readonly [key: string]: unknown;
}

export interface GitLabUser {
  readonly username: string;
  readonly [key: string]: unknown;
}

export interface GitLabMilestone {
  readonly title: string;
  readonly [key: string]: unknown;
}
