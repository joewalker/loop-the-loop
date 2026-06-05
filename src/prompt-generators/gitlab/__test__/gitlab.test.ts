// @module-tag local

import {
  GitLab,
  normalizeProjectId,
} from 'loop-the-loop/prompt-generators/gitlab/gitlab';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Parse the query string from a URL into an array of [key, value] tuples.
 */
function parseQuery(url: string): Array<[string, string]> {
  const query = new URL(url).searchParams;
  return [...query.entries()];
}

/** Return a mock fetch that resolves with the given JSON body. */
function mockFetch(body: unknown, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(headers),
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
      headers: new Headers(),
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

describe('GitLab', () => {
  beforeEach(() => {
    mockFetch([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('constructor', () => {
    it('should default origin to gitlab.com API v4', () => {
      const gitlab = new GitLab();
      expect(gitlab.origin).toBe('https://gitlab.com/api/v4');
    });

    it('should accept a custom origin', () => {
      const gitlab = new GitLab({
        origin: 'https://gitlab.example.com/api/v4',
      });
      expect(gitlab.origin).toBe('https://gitlab.example.com/api/v4');
    });
  });

  describe('normalizeProjectId', () => {
    it('should URL-encode namespaced project paths', () => {
      expect(normalizeProjectId('gitlab-org/gitlab')).toBe(
        'gitlab-org%2Fgitlab',
      );
    });

    it('should leave numeric project IDs as plain strings', () => {
      expect(normalizeProjectId('12345')).toBe('12345');
    });
  });

  describe('searchIssues', () => {
    it('should fetch the project issues URL with query params', async () => {
      const gitlab = new GitLab({ origin: 'https://api.test' });
      await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        state: 'opened',
        labels: ['bug', 'triage-needed'],
        search: 'crash',
        orderBy: 'updated_at',
        sort: 'desc',
        perPage: 25,
      });

      expect(
        fetchedUrl().startsWith(
          'https://api.test/projects/gitlab-org%2Fgitlab/issues?',
        ),
      ).toBe(true);
      expect(parseQuery(fetchedUrl())).toEqual([
        ['state', 'opened'],
        ['labels', 'bug,triage-needed'],
        ['search', 'crash'],
        ['order_by', 'updated_at'],
        ['sort', 'desc'],
        ['per_page', '25'],
        ['page', '1'],
      ]);
    });

    it('should page until maxResults is reached', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'x-next-page': '2' }),
            text: () =>
              Promise.resolve(
                JSON.stringify([
                  { iid: 1, title: 'one', web_url: 'https://gitlab.test/1' },
                  { iid: 2, title: 'two', web_url: 'https://gitlab.test/2' },
                ]),
              ),
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'x-next-page': '' }),
            text: () =>
              Promise.resolve(
                JSON.stringify([
                  {
                    iid: 3,
                    title: 'three',
                    web_url: 'https://gitlab.test/3',
                  },
                ]),
              ),
          }),
      );

      const gitlab = new GitLab({ origin: 'https://api.test' });
      const issues = await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        state: 'opened',
        perPage: 2,
        maxResults: 3,
      });

      expect(issues.map(issue => issue.iid)).toEqual([1, 2, 3]);
      expect(parseQuery(fetchedUrl(1))).toContainEqual(['page', '2']);
    });

    it('should stop when GitLab returns fewer issues than requested', async () => {
      mockFetch([{ iid: 1, title: 'one', web_url: 'https://gitlab.test/1' }]);

      const gitlab = new GitLab({ origin: 'https://api.test' });
      const issues = await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        state: 'opened',
        perPage: 100,
      });

      expect(issues.map(issue => issue.iid)).toEqual([1]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should return empty array on dryRun without calling fetch', async () => {
      const gitlab = new GitLab({ origin: 'https://api.test' });
      const result = await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        dryRun: true,
      });

      expect(result).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should include GitLab headers and explicit private token', async () => {
      mockFetch([]);

      const gitlab = new GitLab({
        origin: 'https://api.test',
        token: 'secret-token',
        userAgent: 'test-agent',
      });
      await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
      });

      expect(fetchedHeaders()).toEqual({
        Accept: 'application/json',
        'PRIVATE-TOKEN': 'secret-token',
        'User-Agent': 'test-agent',
      });
    });

    it('should read token from GITLAB_TOKEN by default', async () => {
      vi.stubEnv('GITLAB_TOKEN', 'env-token');

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
      });

      expect(fetchedHeaders()['PRIVATE-TOKEN']).toBe('env-token');
    });

    it('should throw on API errors with the GitLab message', async () => {
      mockFetchError(400, {
        message: 'state is invalid',
      });

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({
          project: 'gitlab-org/gitlab',
          state: 'opened',
        }),
      ).rejects.toThrow('GitLab API error 400: state is invalid');
    });

    it('should throw on API errors without a message field', async () => {
      mockFetchError(500, { error: 'oops' });

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({ project: 'gitlab-org/gitlab' }),
      ).rejects.toThrow(/^GitLab API error 500$/u);
    });

    it('should append non-JSON text bodies to API error messages', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          headers: new Headers(),
          text: () => Promise.resolve('Bad Gateway'),
        }),
      );

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({ project: 'gitlab-org/gitlab' }),
      ).rejects.toThrow('GitLab API error 502: Bad Gateway');
    });

    it('should not append an empty body to API error messages', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: () => Promise.resolve(''),
        }),
      );

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({ project: 'gitlab-org/gitlab' }),
      ).rejects.toThrow(/^GitLab API error 503$/u);
    });

    it('should throw when a success response is not valid JSON', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve('not json'),
        }),
      );

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({ project: 'gitlab-org/gitlab' }),
      ).rejects.toThrow();
      expect(console.error).toHaveBeenCalledWith('not json');
    });

    it('should throw when perPage is not an integer from 1 to 100', async () => {
      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({
          project: 'gitlab-org/gitlab',
          perPage: 1.5,
        }),
      ).rejects.toThrow(
        'GitLab search perPage must be an integer from 1 to 100',
      );
      await expect(
        gitlab.searchIssues({
          project: 'gitlab-org/gitlab',
          perPage: 200,
        }),
      ).rejects.toThrow(
        'GitLab search perPage must be an integer from 1 to 100',
      );
    });

    it('should throw when maxResults is negative', async () => {
      const gitlab = new GitLab({ origin: 'https://api.test' });
      await expect(
        gitlab.searchIssues({
          project: 'gitlab-org/gitlab',
          maxResults: -1,
        }),
      ).rejects.toThrow(
        'GitLab search maxResults must be a non-negative integer',
      );
    });

    it('should read token from a custom tokenEnv option', async () => {
      vi.stubEnv('CUSTOM_GL_TOKEN', 'custom-env-token');

      const gitlab = new GitLab({
        origin: 'https://api.test',
        tokenEnv: 'CUSTOM_GL_TOKEN',
      });
      await gitlab.searchIssues({ project: 'gitlab-org/gitlab' });

      expect(fetchedHeaders()['PRIVATE-TOKEN']).toBe('custom-env-token');
    });

    it('should include confidential query param when set', async () => {
      const gitlab = new GitLab({ origin: 'https://api.test' });
      await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        confidential: true,
      });

      expect(parseQuery(fetchedUrl())).toContainEqual(['confidential', 'true']);
    });

    it('should stop within a page when items overflow maxResults', async () => {
      mockFetch([
        { iid: 1, title: 'one', web_url: 'https://gitlab.test/1' },
        { iid: 2, title: 'two', web_url: 'https://gitlab.test/2' },
        { iid: 3, title: 'three', web_url: 'https://gitlab.test/3' },
      ]);

      const gitlab = new GitLab({ origin: 'https://api.test' });
      const issues = await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        maxResults: 2,
        perPage: 10,
      });

      expect(issues.map(issue => issue.iid)).toEqual([1, 2]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should log the query URL when logQuery is enabled', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const gitlab = new GitLab({ origin: 'https://api.test' });
      await gitlab.searchIssues({
        project: 'gitlab-org/gitlab',
        logQuery: true,
      });

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(
        /^https:\/\/api\.test\/projects\/gitlab-org%2Fgitlab\/issues\?/u,
      );
    });
  });

  describe('checkAuth', () => {
    it('fails token resolution and skips whoami when no token is set', async () => {
      vi.stubEnv('GITLAB_TOKEN', undefined);
      vi.stubEnv('GL_TOKEN', undefined);
      const gitlab = new GitLab();
      const results = await drain(gitlab.checkAuth());

      expect(results.map(r => [r.name, r.status])).toEqual([
        ['token resolvable', 'fail'],
        ['GET /user authenticates', 'skip'],
      ]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports ok for token and GET /user on HTTP 200', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' }),
      );
      const gitlab = new GitLab({
        token: 'secret',
        origin: 'https://api.test',
      });
      const results = await drain(gitlab.checkAuth());

      expect(results.map(r => [r.name, r.status])).toEqual([
        ['token resolvable', 'ok'],
        ['GET /user authenticates', 'ok'],
      ]);
      expect(fetchedUrl()).toBe('https://api.test/user');
      const headers = fetchedHeaders();
      expect(headers['PRIVATE-TOKEN']).toBe('secret');
      expect(headers['Accept']).toBe('application/json');
    });

    it('fails GET /user on a non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        }),
      );
      const gitlab = new GitLab({ token: 'bad' });
      const results = await drain(gitlab.checkAuth());

      const auth = results.find(r => r.name === 'GET /user authenticates');
      expect(auth?.status).toBe('fail');
      expect(auth?.message).toContain('401');
    });

    it('fails GET /user with the cause when fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );
      const gitlab = new GitLab({ token: 'tok' });
      const results = await drain(gitlab.checkAuth());

      const auth = results.find(r => r.name === 'GET /user authenticates');
      expect(auth?.status).toBe('fail');
      expect(auth?.message).toBe('network down');
      expect(auth?.cause).toBeInstanceOf(Error);
    });
  });
});

/**
 * Collect all results from an async iterable into an array.
 */
async function drain<T>(iterable: AsyncIterable<T>): Promise<Array<T>> {
  const items: Array<T> = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
