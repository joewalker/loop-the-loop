// @module-tag local

import type { Prompt } from 'loop-the-loop/prompt-generators';
import { GitHubPromptGenerator } from 'loop-the-loop/prompt-generators/github';
import { LoopState } from 'loop-the-loop/util/loop-state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearchIssues, MockGitHub } = vi.hoisted(() => {
  const searchIssues = vi.fn();
  const GitHubClass = vi.fn().mockImplementation(function () {
    return {
      searchIssues,
      origin: 'https://api.github.com',
    };
  });
  return { mockSearchIssues: searchIssues, MockGitHub: GitHubClass };
});

vi.mock('loop-the-loop/prompt-generators/github/github', () => ({
  GitHub: MockGitHub,
}));

const mockIssue = (overrides: {
  number: number;
  title?: string;
  html_url?: string;
  state?: string;
  body?: string | null;
  user?: { readonly login: string } | null;
  assignee?: { readonly login: string } | null;
  assignees?: ReadonlyArray<{ readonly login: string }>;
  labels?: ReadonlyArray<{ readonly name: string } | string>;
  milestone?: { readonly title: string } | null;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}) => ({
  title: 'Default issue',
  html_url: 'https://github.com/octocat/Hello-World/issues/1',
  state: 'open',
  body: '',
  user: { login: 'octocat' },
  assignee: null,
  assignees: [],
  labels: [],
  milestone: null,
  comments: 0,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-02T00:00:00Z',
  closed_at: null,
  ...overrides,
});

describe('GitHubPromptGenerator', () => {
  beforeEach(() => {
    mockSearchIssues.mockReset();
    MockGitHub.mockClear();
  });

  it('should yield a prompt for each issue returned by search', async () => {
    mockSearchIssues.mockResolvedValue([
      mockIssue({ number: 123, title: 'Login fails on mobile' }),
      mockIssue({
        number: 456,
        title: 'CSS regression',
        html_url: 'https://github.com/octocat/Hello-World/issues/456',
      }),
    ]);

    const generator = new GitHubPromptGenerator({
      search: {
        repository: 'octocat/Hello-World',
        query: 'is:open label:bug',
      },
      promptTemplate: 'Issue {{id}}: {{title}}',
    });
    const loopState = new LoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toBe('octocat/Hello-World#123');
    expect(prompts[0].prompt).toBe(
      'Issue octocat/Hello-World#123: Login fails on mobile',
    );
    expect(prompts[1].id).toBe('octocat/Hello-World#456');
    expect(prompts[1].prompt).toBe(
      'Issue octocat/Hello-World#456: CSS regression',
    );
  });

  it('should substitute all supported template variables', async () => {
    mockSearchIssues.mockResolvedValue([
      mockIssue({
        number: 789,
        title: 'Test issue',
        state: 'closed',
        body: 'Issue body',
        user: { login: 'reporter' },
        assignee: { login: 'primary' },
        assignees: [{ login: 'primary' }, { login: 'secondary' }],
        labels: [{ name: 'bug' }, 'triage-needed'],
        milestone: { title: 'v1.0' },
        comments: 7,
        closed_at: '2025-01-03T00:00:00Z',
      }),
    ]);

    const generator = new GitHubPromptGenerator({
      search: {
        repository: 'octocat/Hello-World',
        query: 'is:closed label:bug',
      },
      promptTemplate:
        '{{id}} {{number}} {{repository}} {{owner}} {{repo}} {{title}} {{url}} {{state}} {{author}} {{assignee}} {{assignees}} {{labels}} {{milestone}} {{commentCount}} {{createdAt}} {{updatedAt}} {{closedAt}} {{body}}',
    });
    const loopState = new LoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts[0].prompt).toBe(
      'octocat/Hello-World#789 789 octocat/Hello-World octocat Hello-World Test issue https://github.com/octocat/Hello-World/issues/1 closed reporter primary primary, secondary bug, triage-needed v1.0 7 2025-01-01T00:00:00Z 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z Issue body',
    );
  });

  it('should skip issues that are already tracked in the loop state', async () => {
    mockSearchIssues.mockResolvedValue([
      mockIssue({ number: 100, title: 'Already done' }),
      mockIssue({
        number: 200,
        title: 'Still to do',
        html_url: 'https://github.com/octocat/Hello-World/issues/200',
      }),
    ]);

    const generator = new GitHubPromptGenerator({
      search: {
        repository: 'octocat/Hello-World',
        query: 'is:open',
      },
      promptTemplate: 'Issue {{id}}: {{title}}',
    });

    const loopState = new LoopState(
      'ignored.json',
      ['octocat/Hello-World#100'],
      [],
    );
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe('octocat/Hello-World#200');
    expect(prompts[0].prompt).toBe(
      'Issue octocat/Hello-World#200: Still to do',
    );
  });

  it('should pass connection options and search params to GitHub', async () => {
    mockSearchIssues.mockResolvedValue([]);

    const search = {
      repository: 'octocat/Hello-World',
      query: 'is:open',
      sort: 'updated',
    };
    const github = {
      tokenEnv: 'LOOP_GITHUB_TOKEN',
    };
    const generator = new GitHubPromptGenerator({
      github,
      search,
      promptTemplate: 'Issue {{id}}',
    });
    const loopState = new LoopState('ignored.json');

    for await (const _prompt of generator.generate(loopState)) {
      // consume
    }

    expect(MockGitHub).toHaveBeenCalledWith(github);
    expect(mockSearchIssues).toHaveBeenCalledWith(search);
  });

  it('should fall back to empty strings for missing issue fields', async () => {
    mockSearchIssues.mockResolvedValue([
      {
        number: 1,
        title: 'minimal issue',
        html_url: 'https://github.com/octocat/Hello-World/issues/1',
        state: 'open',
      },
    ]);

    const generator = new GitHubPromptGenerator({
      search: { repository: 'octocat/Hello-World', query: 'is:open' },
      promptTemplate:
        '{{author}}|{{assignee}}|{{assignees}}|{{labels}}|{{milestone}}|{{commentCount}}|{{createdAt}}|{{updatedAt}}|{{closedAt}}|{{body}}',
    });
    const loopState = new LoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts[0].prompt).toBe('|||||0||||');
  });

  it('should expose a static create() helper that returns an instance', async () => {
    const generator = await GitHubPromptGenerator.create({
      search: { repository: 'octocat/Hello-World', query: 'is:open' },
      promptTemplate: 'Issue {{id}}',
    });

    expect(generator).toBeInstanceOf(GitHubPromptGenerator);
  });

  it('should reject repositories that are not in owner/repo form', async () => {
    mockSearchIssues.mockResolvedValue([]);

    const generator = new GitHubPromptGenerator({
      search: {
        repository: 'octocat',
        query: 'is:open',
      },
      promptTemplate: 'Issue {{id}}',
    });
    const loopState = new LoopState('ignored.json');

    const consume = async (): Promise<void> => {
      for await (const _prompt of generator.generate(loopState)) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrow(
      'GitHub repository must be in owner/repo form: octocat',
    );
  });
});
