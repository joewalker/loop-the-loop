// @module-tag local

import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import { GitLabPromptGenerator } from 'loop-the-loop/prompt-generators/gitlab';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearchIssues, mockCheckAuth, MockGitLab } = vi.hoisted(() => {
  const searchIssues = vi.fn();
  const checkAuth = vi.fn();
  const GitLabClass = vi.fn().mockImplementation(function () {
    return {
      searchIssues,
      checkAuth,
      origin: 'https://gitlab.com/api/v4',
    };
  });
  return {
    mockSearchIssues: searchIssues,
    mockCheckAuth: checkAuth,
    MockGitLab: GitLabClass,
  };
});

vi.mock('loop-the-loop/prompt-generators/gitlab/gitlab', () => ({
  GitLab: MockGitLab,
}));

const mockIssue = (overrides: {
  iid: number;
  title?: string;
  web_url?: string;
  state?: string;
  description?: string | null;
  author?: { readonly username: string } | null;
  assignee?: { readonly username: string } | null;
  assignees?: ReadonlyArray<{ readonly username: string }>;
  labels?: ReadonlyArray<string>;
  milestone?: { readonly title: string } | null;
  user_notes_count?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}) => ({
  title: 'Default issue',
  web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/1',
  state: 'opened',
  description: '',
  author: { username: 'root' },
  assignee: null,
  assignees: [],
  labels: [],
  milestone: null,
  user_notes_count: 0,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-02T00:00:00Z',
  closed_at: null,
  ...overrides,
});

describe('GitLabPromptGenerator', () => {
  beforeEach(() => {
    mockSearchIssues.mockReset();
    MockGitLab.mockClear();
  });

  it('should yield a prompt for each issue returned by search', async () => {
    mockSearchIssues.mockResolvedValue([
      mockIssue({ iid: 123, title: 'Login fails on mobile' }),
      mockIssue({
        iid: 456,
        title: 'CSS regression',
        web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/456',
      }),
    ]);

    const generator = new GitLabPromptGenerator({
      search: {
        project: 'gitlab-org/gitlab',
        state: 'opened',
        labels: ['bug'],
      },
      promptTemplate: 'Issue {{id}}: {{title}}',
    });
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toBe('gitlab-org/gitlab#123');
    expect(prompts[0].prompt).toBe(
      'Issue gitlab-org/gitlab#123: Login fails on mobile',
    );
    expect(prompts[1].id).toBe('gitlab-org/gitlab#456');
    expect(prompts[1].prompt).toBe(
      'Issue gitlab-org/gitlab#456: CSS regression',
    );
  });

  it('should substitute all supported template variables', async () => {
    mockSearchIssues.mockResolvedValue([
      mockIssue({
        iid: 789,
        title: 'Test issue',
        state: 'closed',
        description: 'Issue description',
        author: { username: 'reporter' },
        assignee: { username: 'primary' },
        assignees: [{ username: 'primary' }, { username: 'secondary' }],
        labels: ['bug', 'triage-needed'],
        milestone: { title: 'v1.0' },
        user_notes_count: 7,
        closed_at: '2025-01-03T00:00:00Z',
      }),
    ]);

    const generator = new GitLabPromptGenerator({
      search: {
        project: 'gitlab-org/gitlab',
        state: 'closed',
        labels: ['bug'],
      },
      promptTemplate:
        '{{id}} {{iid}} {{project}} {{title}} {{url}} {{state}} {{author}} {{assignee}} {{assignees}} {{labels}} {{milestone}} {{commentCount}} {{createdAt}} {{updatedAt}} {{closedAt}} {{description}}',
    });
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts[0].prompt).toBe(
      'gitlab-org/gitlab#789 789 gitlab-org/gitlab Test issue https://gitlab.com/gitlab-org/gitlab/-/issues/1 closed reporter primary primary, secondary bug, triage-needed v1.0 7 2025-01-01T00:00:00Z 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z Issue description',
    );
  });

  it('should skip issues that are already tracked in the loop state', async () => {
    mockSearchIssues.mockResolvedValue([
      mockIssue({ iid: 100, title: 'Already done' }),
      mockIssue({
        iid: 200,
        title: 'Still to do',
        web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/200',
      }),
    ]);

    const generator = new GitLabPromptGenerator({
      search: {
        project: 'gitlab-org/gitlab',
        state: 'opened',
      },
      promptTemplate: 'Issue {{id}}: {{title}}',
    });

    const loopState = FileLoopState.fromPersisted('ignored.json', {
      version: 2,
      results: { 'gitlab-org/gitlab#100': { status: 'success' } },
      claims: {},
    });
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe('gitlab-org/gitlab#200');
    expect(prompts[0].prompt).toBe('Issue gitlab-org/gitlab#200: Still to do');
  });

  it('should fall back to empty strings for missing issue fields', async () => {
    mockSearchIssues.mockResolvedValue([
      {
        iid: 1,
        title: 'minimal issue',
        web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/1',
        state: 'opened',
      },
    ]);

    const generator = new GitLabPromptGenerator({
      search: { project: 'gitlab-org/gitlab' },
      promptTemplate:
        '{{author}}|{{assignee}}|{{assignees}}|{{labels}}|{{milestone}}|{{commentCount}}|{{createdAt}}|{{updatedAt}}|{{closedAt}}|{{description}}',
    });
    const loopState = new FileLoopState('ignored.json');
    const prompts: Array<Prompt> = [];

    for await (const prompt of generator.generate(loopState)) {
      prompts.push(prompt);
    }

    expect(prompts[0].prompt).toBe('|||||0||||');
  });

  it('should expose a static create() helper that returns an instance', async () => {
    const generator = await GitLabPromptGenerator.create({
      search: { project: 'gitlab-org/gitlab' },
      promptTemplate: 'Issue {{id}}',
    });

    expect(generator).toBeInstanceOf(GitLabPromptGenerator);
  });

  it('should pass connection options and search params to GitLab', async () => {
    mockSearchIssues.mockResolvedValue([]);

    const search = {
      project: 'gitlab-org/gitlab',
      state: 'opened' as const,
      orderBy: 'updated_at',
    };
    const gitlab = {
      tokenEnv: 'LOOP_GITLAB_TOKEN',
    };
    const generator = new GitLabPromptGenerator({
      gitlab,
      search,
      promptTemplate: 'Issue {{id}}',
    });
    const loopState = new FileLoopState('ignored.json');

    for await (const _prompt of generator.generate(loopState)) {
      // consume
    }

    expect(MockGitLab).toHaveBeenCalledWith(gitlab);
    expect(mockSearchIssues).toHaveBeenCalledWith(search);
  });

  it('check() delegates to the GitLab client checkAuth probe', async () => {
    mockCheckAuth.mockImplementation(async function* () {
      yield { name: 'token resolvable', status: 'ok' };
      yield {
        name: 'GET /user authenticates',
        status: 'ok',
        message: 'HTTP 200',
      };
    });

    const generator = new GitLabPromptGenerator({
      gitlab: { token: 'tok' },
      search: { project: 'gitlab-org/gitlab' },
      promptTemplate: 'Issue {{id}}',
    });

    const results = [];
    for await (const result of generator.check()) {
      results.push(result);
    }

    expect(mockCheckAuth).toHaveBeenCalledTimes(1);
    expect(results.map(r => [r.name, r.status])).toEqual([
      ['token resolvable', 'ok'],
      ['GET /user authenticates', 'ok'],
    ]);
  });
});
