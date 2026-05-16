import {
  buildIssueSearchQuery,
  GitHub,
} from 'loop-the-loop/prompt-generators/github/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Parse the query string from a URL into an array of [key, value] tuples.
 */
function parseQuery(url: string): Array<[string, string]> {
  const query = new URL(url).searchParams;
  return [...query.entries()];
}

/** Return a mock fetch that resolves with the given JSON body. */
function mockFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

/** Return a mock fetch that resolves with an HTTP error status. */
function mockFetchError(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

/** Extract the URL string passed to the mocked fetch. */
function fetchedUrl(index = 0): string {
  const call = vi.mocked(fetch).mock.calls[index];
  return call[0] as string;
}

/** Extract the headers passed to the mocked fetch. */
function fetchedHeaders(): Record<string, string> {
  const call = vi.mocked(fetch).mock.calls[0];
  return (call[1] as { headers: Record<string, string> }).headers;
}

describe('GitHub', () => {
  beforeEach(() => {
    mockFetch({ total_count: 0, items: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('constructor', () => {
    it('should default origin to api.github.com', () => {
      const github = new GitHub();
      expect(github.origin).toBe('https://api.github.com');
    });

    it('should accept a custom origin', () => {
      const github = new GitHub({
        origin: 'https://github.example.com/api/v3',
      });
      expect(github.origin).toBe('https://github.example.com/api/v3');
    });
  });

  describe('buildIssueSearchQuery', () => {
    it('should scope the user query to the repository and issues', () => {
      expect(
        buildIssueSearchQuery({
          repository: 'octocat/Hello-World',
          query: 'is:open label:bug',
        }),
      ).toBe('is:open label:bug repo:octocat/Hello-World is:issue');
    });
  });

  describe('searchIssues', () => {
    it('should fetch the issue search URL with query params', async () => {
      const github = new GitHub({ origin: 'https://api.test' });
      await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open label:bug',
        sort: 'updated',
        order: 'desc',
        perPage: 25,
      });

      expect(fetchedUrl().startsWith('https://api.test/search/issues?')).toBe(
        true,
      );
      expect(parseQuery(fetchedUrl())).toEqual([
        ['q', 'is:open label:bug repo:octocat/Hello-World is:issue'],
        ['sort', 'updated'],
        ['order', 'desc'],
        ['per_page', '25'],
        ['page', '1'],
      ]);
    });

    it('should page until maxResults is reached', async () => {
      const page1 = {
        total_count: 3,
        items: [
          { number: 1, title: 'one', html_url: 'https://github.test/1' },
          { number: 2, title: 'two', html_url: 'https://github.test/2' },
        ],
      };
      const page2 = {
        total_count: 3,
        items: [
          { number: 3, title: 'three', html_url: 'https://github.test/3' },
        ],
      };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify(page1)),
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify(page2)),
          }),
      );

      const github = new GitHub({ origin: 'https://api.test' });
      const issues = await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open',
        perPage: 2,
        maxResults: 3,
      });

      expect(issues.map(issue => issue.number)).toEqual([1, 2, 3]);
      expect(parseQuery(fetchedUrl(1))).toContainEqual(['page', '2']);
    });

    it('should stop at the GitHub search result limit when maxResults is omitted', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          const page = vi.mocked(fetch).mock.calls.length;
          const start = (page - 1) * 100;
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  total_count: 1_500,
                  items: Array.from({ length: 100 }, (_value, index) => ({
                    number: start + index + 1,
                    title: `issue ${start + index + 1}`,
                    html_url: `https://github.test/${start + index + 1}`,
                  })),
                }),
              ),
          });
        }),
      );

      const github = new GitHub({ origin: 'https://api.test' });
      const issues = await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open',
      });

      expect(issues).toHaveLength(1_000);
      expect(fetch).toHaveBeenCalledTimes(10);
      expect(parseQuery(fetchedUrl(9))).toContainEqual(['page', '10']);
    });

    it('should cap maxResults at the GitHub search result limit', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          const page = vi.mocked(fetch).mock.calls.length;
          const start = (page - 1) * 100;
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  total_count: 1_500,
                  items: Array.from({ length: 100 }, (_value, index) => ({
                    number: start + index + 1,
                    title: `issue ${start + index + 1}`,
                    html_url: `https://github.test/${start + index + 1}`,
                  })),
                }),
              ),
          });
        }),
      );

      const github = new GitHub({ origin: 'https://api.test' });
      const issues = await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open',
        maxResults: 1_500,
      });

      expect(issues).toHaveLength(1_000);
      expect(fetch).toHaveBeenCalledTimes(10);
    });

    it('should return empty array on dryRun without calling fetch', async () => {
      const github = new GitHub({ origin: 'https://api.test' });
      const result = await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open',
        dryRun: true,
      });

      expect(result).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should include GitHub headers and explicit bearer token', async () => {
      mockFetch({ total_count: 0, items: [] });

      const github = new GitHub({
        origin: 'https://api.test',
        token: 'secret-token',
        userAgent: 'test-agent',
      });
      await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open',
      });

      expect(fetchedHeaders()).toEqual({
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer secret-token',
        'User-Agent': 'test-agent',
        'X-GitHub-Api-Version': '2022-11-28',
      });
    });

    it('should read token from GITHUB_TOKEN by default', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'env-token');

      const github = new GitHub({ origin: 'https://api.test' });
      await github.searchIssues({
        repository: 'octocat/Hello-World',
        query: 'is:open',
      });

      expect(fetchedHeaders()['Authorization']).toBe('Bearer env-token');
    });

    it('should throw on API errors with the GitHub message', async () => {
      mockFetchError(422, {
        message: 'Validation Failed',
      });

      const github = new GitHub({ origin: 'https://api.test' });
      await expect(
        github.searchIssues({
          repository: 'octocat/Hello-World',
          query: 'invalid',
        }),
      ).rejects.toThrow('GitHub API error 422: Validation Failed');
    });
  });
});
