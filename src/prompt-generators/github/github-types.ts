export interface GitHubConstructorOptions {
  /**
   * GitHub REST API origin. Defaults to GitHub.com. For GitHub Enterprise,
   * use the API origin, for example `https://github.example.com/api/v3`.
   */
  readonly origin?: string;

  /**
   * GitHub bearer token. Prefer `tokenEnv` for CLI JSON configs so secrets do
   * not need to be written directly into config files.
   */
  readonly token?: string;

  /**
   * Environment variable name from which to read the GitHub bearer token.
   * When omitted, GITHUB_TOKEN and then GH_TOKEN are checked.
   */
  readonly tokenEnv?: string;

  /**
   * REST API version header value. Defaults to the current stable GitHub REST
   * API version.
   */
  readonly apiVersion?: string;

  /**
   * User-Agent header value for GitHub API requests.
   */
  readonly userAgent?: string;
}

/**
 * Query options for GitHub issue search.
 */
export interface GitHubIssueSearchParams {
  /**
   * Repository to search, in `owner/repo` form.
   */
  readonly repository: string;

  /**
   * GitHub issue search syntax. The client adds `repo:<repository>` and
   * `is:issue` so the query is scoped to issues in the configured repository.
   */
  readonly query: string;

  /**
   * Sort field accepted by GitHub issue search.
   */
  readonly sort?: string;

  /**
   * Sort order.
   */
  readonly order?: 'asc' | 'desc';

  /**
   * Number of results to request per API page. GitHub accepts 1 to 100.
   */
  readonly perPage?: number;

  /**
   * Maximum number of issues to return across all pages. When omitted, returns
   * up to GitHub's 1,000-result search limit. Larger values are capped at
   * 1,000.
   */
  readonly maxResults?: number;

  /**
   * Don't actually query GitHub, instead return an empty set.
   */
  readonly dryRun?: boolean;

  /**
   * Write the queries to stdout just before they're sent.
   */
  readonly logQuery?: boolean;
}

export interface GitHubSearchReply {
  readonly total_count: number;
  readonly incomplete_results?: boolean;
  readonly items: ReadonlyArray<GitHubIssue>;
}

/**
 * The subset of GitHub issue fields used by prompt generation. Additional API
 * response fields are accepted so templates can evolve without broad type
 * churn.
 */
export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly state: string;
  readonly body?: string | null;
  readonly user?: GitHubUser | null;
  readonly assignee?: GitHubUser | null;
  readonly assignees?: ReadonlyArray<GitHubUser>;
  readonly labels?: ReadonlyArray<GitHubLabel | string>;
  readonly milestone?: GitHubMilestone | null;
  readonly comments?: number;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly closed_at?: string | null;
  readonly repository?: GitHubRepository;
  readonly [key: string]: unknown;
}

export interface GitHubUser {
  readonly login: string;
  readonly [key: string]: unknown;
}

export interface GitHubLabel {
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface GitHubMilestone {
  readonly title: string;
  readonly [key: string]: unknown;
}

export interface GitHubRepository {
  readonly full_name: string;
  readonly name?: string;
  readonly owner?: GitHubUser;
  readonly [key: string]: unknown;
}
