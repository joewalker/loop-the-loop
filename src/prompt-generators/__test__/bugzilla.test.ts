import type { Prompt } from 'loop-the-loop/prompt-generators';
import { BugzillaPromptGenerator } from 'loop-the-loop/prompt-generators/bugzilla';
import { LoopState } from 'loop-the-loop/util/loop-state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('loop-the-loop/prompt-generators/bugzilla/bugzilla', () => ({
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
    mockSearch.mockResolvedValue([
      mockBug({ id: 123, summary: 'Login fails on mobile' }),
      mockBug({ id: 456, summary: 'CSS regression' }),
    ]);

    const generator = new BugzillaPromptGenerator({
      search: { product: 'Firefox' },
      promptTemplate: 'Bug {{id}}: {{summary}}',
    });
    const loopState = new LoopState('ignored.json');
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
    mockSearch.mockResolvedValue([
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
    ]);

    const generator = new BugzillaPromptGenerator({
      search: {},
      promptTemplate:
        '{{id}} {{summary}} {{product}} {{component}} {{severity}} {{status}} {{assignee}} {{whiteboard}} {{url}}',
    });
    const loopState = new LoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts[0].prompt).toBe(
      '789 Test bug Core JavaScript Engine S3 ASSIGNED dev@mozilla.org [test-tag] https://bugzilla.mozilla.org/show_bug.cgi?id=789',
    );
  });

  it('should yield no prompts when search returns an empty list', async () => {
    mockSearch.mockResolvedValue([]);

    const generator = new BugzillaPromptGenerator({
      search: { product: 'Firefox' },
      promptTemplate: 'Bug {{id}}',
    });
    const loopState = new LoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toStrictEqual([]);
  });

  it('should skip bugs that are already tracked in the loop state', async () => {
    mockSearch.mockResolvedValue([
      mockBug({ id: 100, summary: 'Already done' }),
      mockBug({ id: 200, summary: 'Still to do' }),
    ]);

    const generator = new BugzillaPromptGenerator({
      search: {},
      promptTemplate: 'Bug {{id}}: {{summary}}',
    });

    const loopState = new LoopState('ignored.json', ['100'], []);
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe('200');
    expect(prompts[0].prompt).toBe('Bug 200: Still to do');
  });

  it('should pass the search params to Bugzilla.search', async () => {
    mockSearch.mockResolvedValue([]);

    const searchParams = { product: 'Core', bugStatus: ['NEW' as const] };
    const generator = new BugzillaPromptGenerator({
      search: searchParams,
      promptTemplate: 'Bug {{id}}',
    });
    const loopState = new LoopState('ignored.json');

    for await (const _prompt of generator.generate(loopState)) {
      // consume
    }

    expect(mockSearch).toHaveBeenCalledWith(searchParams);
  });
});
