import { toResponseFieldName } from 'agentic-loop/prompt-generators/bugzilla/bug-fields';
import {
  BugField,
  BugStatus,
  Bugzilla,
  CF,
  CFQAWhiteboard,
  CFStatus,
  Classification,
  MatchType,
  Platform,
  Priority,
  Product,
  Type,
} from 'agentic-loop/prompt-generators/bugzilla/bugzilla';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Parse the query string from a URL into an array of [key, value] tuples.
 * Using tuples (not an object) because Bugzilla query params can repeat keys.
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
function fetchedUrl(): string {
  const call = vi.mocked(fetch).mock.calls[0];
  return call[0] as string;
}

/** Extract the headers passed to the mocked fetch. */
function fetchedHeaders(): Record<string, string> {
  const call = vi.mocked(fetch).mock.calls[0];
  return (call[1] as { headers: Record<string, string> }).headers;
}

describe('Bugzilla', () => {
  beforeEach(() => {
    mockFetch({ bugs: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should default origin to bugzilla.mozilla.org', () => {
      const bz = new Bugzilla();
      expect(bz.origin).toBe('https://bugzilla.mozilla.org');
    });

    it('should accept a custom origin', () => {
      const bz = new Bugzilla({ origin: 'https://bz.example.com' });
      expect(bz.origin).toBe('https://bz.example.com');
    });
  });

  describe('getBug', () => {
    it('should fetch the correct URL', async () => {
      const bug = { id: 123, summary: 'test' };
      mockFetch({ bugs: [bug] });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      const result = await bz.getBug(123);

      expect(fetchedUrl()).toBe('https://bz.test/rest/bug/123?');
      expect(result).toEqual(bug);
    });

    it('should include bugFields as include_fields with response names', async () => {
      mockFetch({ bugs: [{ id: 1 }] });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.getBug(1, { bugFields: ['bug_status', 'assigned_to'] });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['include_fields', 'status,assigned_to']);
    });

    it('should throw when no bugs are returned', async () => {
      mockFetch({ bugs: [] });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await expect(bz.getBug(999)).rejects.toThrow('Found 0 bugs matching 999');
    });

    it('should throw when multiple bugs are returned', async () => {
      mockFetch({ bugs: [{ id: 1 }, { id: 2 }] });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await expect(bz.getBug(1)).rejects.toThrow('Found 2 bugs matching 1');
    });
  });

  describe('comments', () => {
    it('should fetch the correct URL', async () => {
      const reply = { bugs: { '42': { comments: [] } } };
      mockFetch(reply);

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      const result = await bz.comments(42);

      expect(fetchedUrl()).toBe('https://bz.test/rest/bug/42/comment?');
      expect(result).toEqual(reply);
    });
  });

  describe('attachments', () => {
    it('should fetch the correct URL', async () => {
      const reply = { attachments: {}, bugs: {} };
      mockFetch(reply);

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      const result = await bz.attachments(42);

      expect(fetchedUrl()).toBe('https://bz.test/rest/bug/42/attachment?');
      expect(result).toEqual(reply);
    });
  });

  describe('search', () => {
    it('should include product param', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({ product: 'Core' });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['product', 'Core']);
    });

    it('should repeat component params', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({ components: ['DOM', 'Layout', 'CSS'] });

      const params = parseQuery(fetchedUrl());
      expect(params.filter(([k]) => k === 'component')).toEqual([
        ['component', 'DOM'],
        ['component', 'Layout'],
        ['component', 'CSS'],
      ]);
    });

    it('should repeat bug_status params', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({
        bugStatus: [BugStatus.new, BugStatus.assigned],
      });

      const params = parseQuery(fetchedUrl());
      expect(params.filter(([k]) => k === 'bug_status')).toEqual([
        ['bug_status', 'NEW'],
        ['bug_status', 'ASSIGNED'],
      ]);
    });

    it('should format keywords with anywords type', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({ keywords: ['sec-high', 'sec-critical'] });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['keywords', 'sec-high, sec-critical']);
      expect(params).toContainEqual(['keywords_type', 'anywords']);
    });

    it('should format assignedTo as email params', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({ assignedTo: 'dev@mozilla.com' });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['email1', 'dev@mozilla.com']);
      expect(params).toContainEqual(['emailassigned_to1', '1']);
      expect(params).toContainEqual(['emailtype1', 'exact']);
    });

    it('should format change params with dates as yyyy-MM-dd', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({
        change: {
          field: 'bug_status',
          from: new Date('2025-01-15T00:00:00Z'),
          to: new Date('2025-02-15T00:00:00Z'),
          value: 'RESOLVED',
        },
      });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['chfield', 'bug_status']);
      expect(params).toContainEqual(['chfieldfrom', '2025-01-15']);
      expect(params).toContainEqual(['chfieldto', '2025-02-15']);
      expect(params).toContainEqual(['chfieldvalue', 'RESOLVED']);
    });

    it('should format advanced search params with 1-based indices', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({
        advanced: [
          {
            field: 'cf_status_firefox120',
            matchType: MatchType.equals,
            value: 'affected',
          },
          { field: 'priority', matchType: MatchType.anyexact, value: 'P1' },
        ],
      });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['f1', 'cf_status_firefox120']);
      expect(params).toContainEqual(['o1', 'equals']);
      expect(params).toContainEqual(['v1', 'affected']);
      expect(params).toContainEqual(['f2', 'priority']);
      expect(params).toContainEqual(['o2', 'anyexact']);
      expect(params).toContainEqual(['v2', 'P1']);
      expect(params).toContainEqual(['query_format', 'advanced']);
    });

    it('should repeat bug_severity params', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({ bugSeverity: ['S1', 'S2'] });

      const params = parseQuery(fetchedUrl());
      expect(params.filter(([k]) => k === 'bug_severity')).toEqual([
        ['bug_severity', 'S1'],
        ['bug_severity', 'S2'],
      ]);
    });

    it('should include bugFields as include_fields with response names', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({ bugFields: ['bug_status', 'component'] });

      const params = parseQuery(fetchedUrl());
      expect(params).toContainEqual(['include_fields', 'status,component']);
    });

    it('should return empty array on dryRun without calling fetch', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      const result = await bz.search({ dryRun: true });

      expect(result).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should omit params that are not set', async () => {
      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.search({});

      const params = parseQuery(fetchedUrl());
      expect(params).toEqual([]);
    });
  });

  describe('getTeams', () => {
    it('should fetch the correct URL', async () => {
      mockFetch(['team-a', 'team-b']);

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      const result = await bz.getTeams();

      expect(fetchedUrl()).toBe('https://bz.test/rest/config/component_teams?');
      expect(result).toEqual(['team-a', 'team-b']);
    });
  });

  describe('getComponentsForTeam', () => {
    it('should encode the team name in the URL', async () => {
      mockFetch({ 'DOM: Core': {} });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.getComponentsForTeam('Layout & CSS');

      expect(fetchedUrl()).toBe(
        'https://bz.test/rest/config/component_teams/Layout%20%26%20CSS?',
      );
    });
  });

  describe('API key', () => {
    it('should send the API key header when configured', async () => {
      mockFetch({ bugs: [{ id: 1 }] });

      const bz = new Bugzilla({
        origin: 'https://bz.test',
        apiKey: 'secret-key',
      });
      await bz.getBug(1);

      expect(fetchedHeaders()).toEqual({
        'X-BUGZILLA-API-KEY': 'secret-key',
      });
    });

    it('should not send the API key header when not configured', async () => {
      mockFetch({ bugs: [{ id: 1 }] });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await bz.getBug(1);

      expect(fetchedHeaders()).toEqual({});
    });
  });

  describe('HTTP error handling', () => {
    it('should throw on 404 with Bugzilla error message', async () => {
      mockFetchError(404, {
        error: true,
        message: 'Bug #999999 does not exist.',
      });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await expect(bz.getBug(999999)).rejects.toThrow(
        'Bugzilla API error 404: Bug #999999 does not exist.',
      );
    });

    it('should throw on 401 for unauthorized requests', async () => {
      mockFetchError(401, {
        error: true,
        message: 'You must log in before using this part of Bugzilla.',
      });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await expect(bz.search({})).rejects.toThrow('Bugzilla API error 401');
    });

    it('should include status code when body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          text: () => Promise.resolve('Bad Gateway'),
        }),
      );

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await expect(bz.comments(1)).rejects.toThrow(
        'Bugzilla API error 502: Bad Gateway',
      );
    });

    it('should throw on error for attachments endpoint', async () => {
      mockFetchError(403, {
        error: true,
        message: 'You are not authorized to access bug #42.',
      });

      const bz = new Bugzilla({ origin: 'https://bz.test' });
      await expect(bz.attachments(42)).rejects.toThrow(
        'Bugzilla API error 403: You are not authorized to access bug #42.',
      );
    });
  });
});

describe('toResponseFieldName', () => {
  it('should translate search names to REST response names', () => {
    expect(toResponseFieldName('bug_status')).toBe('status');
    expect(toResponseFieldName('status_whiteboard')).toBe('whiteboard');
    expect(toResponseFieldName('short_desc')).toBe('summary');
    expect(toResponseFieldName('bug_severity')).toBe('severity');
    expect(toResponseFieldName('rep_platform')).toBe('platform');
    expect(toResponseFieldName('blocked')).toBe('blocks');
    expect(toResponseFieldName('dependson')).toBe('depends_on');
    expect(toResponseFieldName('bug_file_loc')).toBe('url');
  });

  it('should pass through names that are the same in both contexts', () => {
    expect(toResponseFieldName('component')).toBe('component');
    expect(toResponseFieldName('assigned_to')).toBe('assigned_to');
    expect(toResponseFieldName('product')).toBe('product');
    expect(toResponseFieldName('cf_crash_signature')).toBe(
      'cf_crash_signature',
    );
  });
});

describe('literal exports', () => {
  it('should export BugField with known search field names', () => {
    expect(BugField.status).toBe('bug_status');
    expect(BugField.component).toBe('component');
    expect(BugField.assignee).toBe('assigned_to');
  });

  it('should export BugStatus with all statuses', () => {
    expect(Object.values(BugStatus)).toEqual(
      expect.arrayContaining([
        'UNCONFIRMED',
        'NEW',
        'ASSIGNED',
        'REOPENED',
        'RESOLVED',
        'VERIFIED',
        'CLOSED',
      ]),
    );
  });

  it('should export frozen enum objects', () => {
    expect(Object.isFrozen(BugStatus)).toBe(true);
    expect(Object.isFrozen(MatchType)).toBe(true);
    expect(Object.isFrozen(CF)).toBe(true);
    expect(Object.isFrozen(CFQAWhiteboard)).toBe(true);
    expect(Object.isFrozen(CFStatus)).toBe(true);
    expect(Object.isFrozen(Priority)).toBe(true);
    expect(Object.isFrozen(Classification)).toBe(true);
    expect(Object.isFrozen(Platform)).toBe(true);
    expect(Object.isFrozen(Product)).toBe(true);
    expect(Object.isFrozen(Type)).toBe(true);
  });
});
