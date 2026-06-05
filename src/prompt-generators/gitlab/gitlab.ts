import type { CheckResult } from '../../doctor.js';
import type {
  GitLabConstructorOptions,
  GitLabIssue,
  GitLabIssueSearchParams,
} from './gitlab-types.js';

const DEFAULT_ORIGIN = 'https://gitlab.com/api/v4';
const DEFAULT_USER_AGENT = 'loop-the-loop';
const DEFAULT_PER_PAGE = 100;

type QueryParam = readonly [key: string, value: string];

/**
 * Normalize a GitLab project ID or namespaced path for use in API endpoint
 * paths. Numeric IDs are already path-safe; namespaced paths need slash
 * encoding.
 */
export function normalizeProjectId(project: string): string {
  return /^\d+$/.test(project) ? project : encodeURIComponent(project);
}

/**
 * Construct a single GitLab query parameter tuple.
 */
function createQueryParam(key: string, value: string): QueryParam {
  return [key, value];
}

/**
 * Validate and normalize the number of results to request per page.
 */
function normalizePerPage(
  perPage: number | undefined,
  maxResults: number | undefined,
): number {
  const requested = perPage ?? DEFAULT_PER_PAGE;

  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    throw new Error('GitLab search perPage must be an integer from 1 to 100');
  }

  if (maxResults !== undefined && maxResults > 0) {
    return Math.min(requested, maxResults);
  }

  return requested;
}

/**
 * Validate and normalize the requested maximum result count.
 */
function normalizeMaxResults(
  maxResults: number | undefined,
): number | undefined {
  if (maxResults !== undefined) {
    if (!Number.isInteger(maxResults) || maxResults < 0) {
      throw new Error(
        'GitLab search maxResults must be a non-negative integer',
      );
    }
  }

  return maxResults;
}

/**
 * Resolve the optional GitLab token from explicit options or env.
 */
function resolveToken(options: GitLabConstructorOptions): string | undefined {
  if (options.token !== undefined) {
    return options.token;
  }

  if (options.tokenEnv !== undefined) {
    return process.env[options.tokenEnv];
  }

  return process.env['GITLAB_TOKEN'] ?? process.env['GL_TOKEN'];
}

/**
 * Append a query parameter when the value is present.
 */
function pushOptionalParam(
  queryParams: Array<QueryParam>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    queryParams.push(createQueryParam(key, value));
  }
}

/**
 * Build the query parameters accepted by the GitLab project issues endpoint.
 */
function buildIssueQueryParams(
  params: GitLabIssueSearchParams,
  perPage: number,
  page: number,
): Array<QueryParam> {
  const queryParams: Array<QueryParam> = [];

  pushOptionalParam(queryParams, 'state', params.state);
  if (params.labels !== undefined) {
    queryParams.push(createQueryParam('labels', params.labels.join(',')));
  }
  pushOptionalParam(queryParams, 'search', params.search);
  pushOptionalParam(queryParams, 'milestone', params.milestone);
  pushOptionalParam(queryParams, 'author_username', params.authorUsername);
  pushOptionalParam(queryParams, 'assignee_username', params.assigneeUsername);
  pushOptionalParam(queryParams, 'scope', params.scope);
  pushOptionalParam(queryParams, 'order_by', params.orderBy);
  pushOptionalParam(queryParams, 'sort', params.sort);
  pushOptionalParam(queryParams, 'created_after', params.createdAfter);
  pushOptionalParam(queryParams, 'created_before', params.createdBefore);
  pushOptionalParam(queryParams, 'updated_after', params.updatedAfter);
  pushOptionalParam(queryParams, 'updated_before', params.updatedBefore);
  pushOptionalParam(queryParams, 'issue_type', params.issueType);
  if (params.confidential !== undefined) {
    queryParams.push(
      createQueryParam('confidential', String(params.confidential)),
    );
  }
  queryParams.push(createQueryParam('per_page', String(perPage)));
  queryParams.push(createQueryParam('page', String(page)));

  return queryParams;
}

/**
 * Small GitLab REST client for project issue search.
 */
export class GitLab {
  readonly origin: string;
  readonly #token: string | undefined;
  readonly #userAgent: string;

  constructor(options: GitLabConstructorOptions = {}) {
    const { origin = DEFAULT_ORIGIN, userAgent = DEFAULT_USER_AGENT } = options;

    this.origin = origin;
    this.#token = resolveToken(options);
    this.#userAgent = userAgent;
  }

  /**
   * Preflight probe used by `--doctor`: confirm a token resolves and that it
   * authenticates against `GET /user`. Uses the same Accept / PRIVATE-TOKEN
   * headers as live queries. Skips the authentication probe when no token is
   * configured.
   */
  async *checkAuth(): AsyncIterable<CheckResult> {
    if (this.#token === undefined) {
      yield {
        name: 'token resolvable',
        status: 'fail',
        message: 'set GITLAB_TOKEN or GL_TOKEN, or configure token/tokenEnv',
      };
      yield {
        name: 'GET /user authenticates',
        status: 'skip',
        message: 'no token',
      };
      return;
    }

    yield { name: 'token resolvable', status: 'ok' };

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.#userAgent,
      'PRIVATE-TOKEN': this.#token,
    };

    try {
      const response = await fetch(`${this.origin}/user`, { headers });
      yield response.ok
        ? {
            name: 'GET /user authenticates',
            status: 'ok',
            message: `HTTP ${response.status}`,
          }
        : {
            name: 'GET /user authenticates',
            status: 'fail',
            message: `HTTP ${response.status} ${response.statusText}`,
          };
    } catch (err) {
      yield {
        name: 'GET /user authenticates',
        status: 'fail',
        message:
          err instanceof Error
            ? err.message
            : /* istanbul ignore next */ String(err),
        cause: err,
      };
    }
  }

  /**
   * Search GitLab project issues using project issue endpoint filters.
   */
  async searchIssues(
    params: GitLabIssueSearchParams,
  ): Promise<ReadonlyArray<GitLabIssue>> {
    if (params.dryRun || params.maxResults === 0) {
      return [];
    }

    const maxResults = normalizeMaxResults(params.maxResults);
    const perPage = normalizePerPage(params.perPage, maxResults);
    const issues: Array<GitLabIssue> = [];
    const project = normalizeProjectId(params.project);

    for (
      let page = 1;
      maxResults === undefined || issues.length < maxResults;
      page++
    ) {
      const queryParams = buildIssueQueryParams(params, perPage, page);
      const { body, nextPage } = await this.#query<ReadonlyArray<GitLabIssue>>(
        `/projects/${project}/issues`,
        queryParams,
        params.logQuery,
      );

      for (const issue of body) {
        if (maxResults !== undefined && issues.length >= maxResults) {
          break;
        }
        issues.push(issue);
      }

      if (
        body.length < perPage ||
        (maxResults !== undefined && issues.length >= maxResults) ||
        nextPage === ''
      ) {
        break;
      }
    }

    return issues;
  }

  /**
   * Query GitLab and parse a JSON response.
   */
  async #query<T = unknown>(
    baseUrl: string,
    queryParams: ReadonlyArray<QueryParam>,
    logQuery = false,
  ): Promise<{ readonly body: T; readonly nextPage: string }> {
    const outputParams = queryParams.map(([key, value]) => {
      return `${key}=${encodeURIComponent(value)}`;
    });
    const url = `${this.origin}${baseUrl}?${outputParams.join('&')}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.#userAgent,
    };
    if (this.#token !== undefined) {
      headers['PRIVATE-TOKEN'] = this.#token;
    }

    if (logQuery) {
      // eslint-disable-next-line no-console
      console.log(url);
    }

    const response = await fetch(url, { headers });
    const text = await response.text();

    if (!response.ok) {
      let message = `GitLab API error ${response.status}`;
      try {
        const body = JSON.parse(text) as { message?: string };
        if (body.message) {
          message += `: ${body.message}`;
        }
      } catch {
        if (text.length > 0) {
          message += `: ${text}`;
        }
      }
      throw new Error(message);
    }

    try {
      return {
        body: JSON.parse(text) as T,
        nextPage: response.headers.get('x-next-page') ?? '',
      };
    } catch (ex) {
      console.error(text);
      throw ex;
    }
  }
}
