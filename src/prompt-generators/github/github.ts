import type {
  GitHubConstructorOptions,
  GitHubIssue,
  GitHubIssueSearchParams,
  GitHubSearchReply,
} from './github-types.js';

const DEFAULT_ORIGIN = 'https://api.github.com';
const DEFAULT_API_VERSION = '2022-11-28';
const DEFAULT_USER_AGENT = 'loop-the-loop';
const DEFAULT_PER_PAGE = 100;

/**
 * GitHub has a hard limit on the number of results returned by a search
 * https://docs.github.com/en/rest/search/search?apiVersion=2026-03-10#about-search
 * "… the GitHub REST API provides up to 1,000 results for each search."
 */
const GITHUB_SEARCH_RESULT_LIMIT = 1_000;

type QueryParam = readonly [key: string, value: string];

/**
 * Build the full GitHub issue search query from the user query and required
 * repository scope.
 */
export function buildIssueSearchQuery(
  params: Pick<GitHubIssueSearchParams, 'query' | 'repository'>,
): string {
  return `${params.query} repo:${params.repository} is:issue`;
}

/**
 * Construct a single GitHub query parameter tuple.
 */
function createQueryParam(key: string, value: string): QueryParam {
  return [key, value];
}

/**
 * Validate and normalize the number of results to request per page.
 */
function normalizePerPage(
  perPage: number | undefined,
  maxResults: number,
): number {
  const requested = perPage ?? DEFAULT_PER_PAGE;

  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    throw new Error('GitHub search perPage must be an integer from 1 to 100');
  }

  if (maxResults > 0) {
    return Math.min(requested, maxResults);
  }

  return requested;
}

/**
 * Validate and normalize the requested maximum result count.
 */
function normalizeMaxResults(maxResults: number | undefined): number {
  if (maxResults !== undefined) {
    if (!Number.isInteger(maxResults) || maxResults < 0) {
      throw new Error(
        'GitHub search maxResults must be a non-negative integer',
      );
    }
    return Math.min(maxResults, GITHUB_SEARCH_RESULT_LIMIT);
  }

  return GITHUB_SEARCH_RESULT_LIMIT;
}

/**
 * Resolve the optional GitHub bearer token from explicit options or env.
 */
function resolveToken(options: GitHubConstructorOptions): string | undefined {
  if (options.token !== undefined) {
    return options.token;
  }

  if (options.tokenEnv !== undefined) {
    return process.env[options.tokenEnv];
  }

  return process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
}

/**
 * Small GitHub REST client for issue search.
 */
export class GitHub {
  readonly origin: string;
  readonly #apiVersion: string;
  readonly #token: string | undefined;
  readonly #userAgent: string;

  constructor(options: GitHubConstructorOptions = {}) {
    const {
      origin = DEFAULT_ORIGIN,
      apiVersion = DEFAULT_API_VERSION,
      userAgent = DEFAULT_USER_AGENT,
    } = options;

    this.origin = origin;
    this.#apiVersion = apiVersion;
    this.#token = resolveToken(options);
    this.#userAgent = userAgent;
  }

  /**
   * Search GitHub issues using native GitHub issue search syntax.
   */
  async searchIssues(
    params: GitHubIssueSearchParams,
  ): Promise<ReadonlyArray<GitHubIssue>> {
    if (params.dryRun || params.maxResults === 0) {
      return [];
    }

    const maxResults = normalizeMaxResults(params.maxResults);
    const perPage = normalizePerPage(params.perPage, maxResults);
    const issues: Array<GitHubIssue> = [];

    for (let page = 1; issues.length < maxResults; page++) {
      const queryParams: Array<QueryParam> = [
        createQueryParam('q', buildIssueSearchQuery(params)),
      ];

      if (params.sort !== undefined) {
        queryParams.push(createQueryParam('sort', params.sort));
      }
      if (params.order !== undefined) {
        queryParams.push(createQueryParam('order', params.order));
      }
      queryParams.push(createQueryParam('per_page', String(perPage)));
      queryParams.push(createQueryParam('page', String(page)));

      const reply = await this.#query<GitHubSearchReply>(
        '/search/issues',
        queryParams,
        params.logQuery,
      );

      for (const issue of reply.items) {
        if (issues.length >= maxResults) {
          break;
        }
        issues.push(issue);
      }

      if (
        reply.items.length < perPage ||
        issues.length >= reply.total_count ||
        issues.length >= maxResults
      ) {
        break;
      }
    }

    return issues;
  }

  /**
   * Query GitHub and parse a JSON response.
   */
  async #query<T = unknown>(
    baseUrl: string,
    queryParams: ReadonlyArray<QueryParam>,
    logQuery = false,
  ): Promise<T> {
    const outputParams = queryParams.map(([key, value]) => {
      return `${key}=${encodeURIComponent(value)}`;
    });
    const url = `${this.origin}${baseUrl}?${outputParams.join('&')}`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': this.#userAgent,
      'X-GitHub-Api-Version': this.#apiVersion,
    };
    if (this.#token !== undefined) {
      headers['Authorization'] = `Bearer ${this.#token}`;
    }

    if (logQuery) {
      // eslint-disable-next-line no-console
      console.log(url);
    }

    const response = await fetch(url, { headers });
    const text = await response.text();

    if (!response.ok) {
      let message = `GitHub API error ${response.status}`;
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
      return JSON.parse(text) as T;
    } catch (ex) {
      console.error(text);
      throw ex;
    }
  }
}
