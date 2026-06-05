// @module-tag local

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import { BugzillaPromptGenerator } from 'loop-the-loop/prompt-generators/bugzilla';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearch, MockBugzilla } = vi.hoisted(() => {
  const search = vi.fn();
  const BugzillaClass = vi.fn().mockImplementation(function () {
    return {
      search,
      origin: 'https://bugzilla.mozilla.org',
    };
  });
  return { mockSearch: search, MockBugzilla: BugzillaClass };
});

vi.mock('@joewalker/bzjs', () => ({
  Bugzilla: MockBugzilla,
}));

const mockBug = (overrides: {
  id: number;
  summary?: string;
  product?: string;
  component?: string;
  severity?: string;
  status?: string;
  assigned_to?: string;
  whiteboard?: string;
}) => ({
  summary: 'Default summary',
  product: 'Firefox',
  component: 'General',
  severity: 'S2',
  status: 'NEW',
  assigned_to: 'nobody@mozilla.org',
  whiteboard: '',
  ...overrides,
});

describe('BugzillaPromptGenerator', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    MockBugzilla.mockClear();
  });

  it('should yield a prompt for each bug returned by search', async () => {
    mockSearch.mockResolvedValue({
      bugs: [
        mockBug({ id: 123, summary: 'Login fails on mobile' }),
        mockBug({ id: 456, summary: 'CSS regression' }),
      ],
      checkUrl: 'https://bugzilla.mozilla.org/buglist.cgi?',
    });

    const generator = new BugzillaPromptGenerator({
      search: { product: 'Firefox' },
      promptTemplate: 'Bug {{id}}: {{summary}}',
    });
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toBe('123');
    expect(prompts[0].prompt).toBe('Bug 123: Login fails on mobile');
    expect(prompts[1].id).toBe('456');
    expect(prompts[1].prompt).toBe('Bug 456: CSS regression');
  });

  it('should substitute all supported template variables', async () => {
    mockSearch.mockResolvedValue({
      bugs: [
        mockBug({
          id: 789,
          summary: 'Test bug',
          product: 'Core',
          component: 'JavaScript Engine',
          severity: 'S3',
          status: 'ASSIGNED',
          assigned_to: 'dev@mozilla.org',
          whiteboard: '[test-tag]',
        }),
      ],
      checkUrl: 'https://bugzilla.mozilla.org/buglist.cgi?',
    });

    const generator = new BugzillaPromptGenerator({
      search: {},
      promptTemplate:
        '{{id}} {{summary}} {{product}} {{component}} {{severity}} {{status}} {{assignee}} {{whiteboard}} {{url}}',
    });
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts[0].prompt).toBe(
      '789 Test bug Core JavaScript Engine S3 ASSIGNED dev@mozilla.org [test-tag] https://bugzilla.mozilla.org/show_bug.cgi?id=789',
    );
  });

  it('should yield no prompts when search returns an empty list', async () => {
    mockSearch.mockResolvedValue({
      bugs: [],
      checkUrl: 'https://bugzilla.mozilla.org/buglist.cgi?',
    });

    const generator = new BugzillaPromptGenerator({
      search: { product: 'Firefox' },
      promptTemplate: 'Bug {{id}}',
    });
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toStrictEqual([]);
  });

  it('should skip bugs that are already tracked in the loop state', async () => {
    mockSearch.mockResolvedValue({
      bugs: [
        mockBug({ id: 100, summary: 'Already done' }),
        mockBug({ id: 200, summary: 'Still to do' }),
      ],
      checkUrl: 'https://bugzilla.mozilla.org/buglist.cgi?',
    });

    const generator = new BugzillaPromptGenerator({
      search: {},
      promptTemplate: 'Bug {{id}}: {{summary}}',
    });

    const loopState = FileLoopState.fromPersisted('ignored.json', {
      version: 2,
      results: { '100': { status: 'success' } },
      claims: {},
    });
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe('200');
    expect(prompts[0].prompt).toBe('Bug 200: Still to do');
  });

  it('should pass the search params to Bugzilla.search', async () => {
    mockSearch.mockResolvedValue({
      bugs: [],
      checkUrl: 'https://bugzilla.mozilla.org/buglist.cgi?',
    });

    const searchParams = { product: 'Core', bugStatus: ['NEW' as const] };
    const generator = new BugzillaPromptGenerator({
      search: searchParams,
      promptTemplate: 'Bug {{id}}',
    });
    const loopState = new FileLoopState('ignored.json');

    for await (const _prompt of generator.generate(loopState)) {
      // consume
    }

    expect(mockSearch).toHaveBeenCalledWith(searchParams);
  });

  it('should expose a static create() helper that returns an instance', async () => {
    const generator = await BugzillaPromptGenerator.create({
      search: { product: 'Core' },
      promptTemplate: 'Bug {{id}}',
    });

    expect(generator).toBeInstanceOf(BugzillaPromptGenerator);
  });

  describe('check()', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const drain = async (
      generator: BugzillaPromptGenerator,
    ): Promise<Array<{ name: string; status: string; message?: string }>> => {
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      return results;
    };

    it('fails api key resolution and skips whoami when no key is set', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const generator = new BugzillaPromptGenerator({
        search: { product: 'Core' },
        promptTemplate: 'Bug {{id}}',
      });

      const results = await drain(generator);

      expect(results.map(r => [r.name, r.status])).toEqual([
        ['api key resolvable', 'fail'],
        ['whoami authenticates', 'skip'],
      ]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports ok on a successful whoami response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ id: 1, name: 'ada' }),
        }),
      );
      const generator = new BugzillaPromptGenerator({
        bugzilla: { apiKey: 'secret' },
        search: { product: 'Core' },
        promptTemplate: 'Bug {{id}}',
      });

      const results = await drain(generator);

      expect(results.map(r => [r.name, r.status])).toEqual([
        ['api key resolvable', 'ok'],
        ['whoami authenticates', 'ok'],
      ]);
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('/rest/whoami?api_key=secret');
    });

    it('fails whoami when the response body reports an error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ error: true, message: 'The API key is invalid' }),
        }),
      );
      const generator = new BugzillaPromptGenerator({
        bugzilla: { apiKey: 'bad' },
        search: { product: 'Core' },
        promptTemplate: 'Bug {{id}}',
      });

      const results = await drain(generator);
      const whoami = results.find(r => r.name === 'whoami authenticates');
      expect(whoami?.status).toBe('fail');
      expect(whoami?.message).toBe('The API key is invalid');
    });

    it('fails whoami on a non-ok response without an error message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Server Error',
          json: () => Promise.resolve({}),
        }),
      );
      const generator = new BugzillaPromptGenerator({
        bugzilla: { apiKey: 'k' },
        search: { product: 'Core' },
        promptTemplate: 'Bug {{id}}',
      });

      const results = await drain(generator);
      const whoami = results.find(r => r.name === 'whoami authenticates');
      expect(whoami?.status).toBe('fail');
      expect(whoami?.message).toContain('500');
    });

    it('fails whoami with the cause when fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );
      const generator = new BugzillaPromptGenerator({
        bugzilla: { apiKey: 'k' },
        search: { product: 'Core' },
        promptTemplate: 'Bug {{id}}',
      });

      const results = await drain(generator);
      const whoami = results.find(r => r.name === 'whoami authenticates');
      expect(whoami?.status).toBe('fail');
      expect(whoami?.message).toBe('network down');
    });
  });
});
