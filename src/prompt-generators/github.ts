import type { CheckResult } from '../doctor.js';
import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type {
  GitHubConstructorOptions,
  GitHubIssue,
  GitHubIssueSearchParams,
} from './github/github-types.js';
import { GitHub } from './github/github.js';

/**
 * Configuration for a GitHub-issues-driven loop task. Describes which issues
 * to search for and what prompt to generate for each one.
 */
export interface GitHubTask {
  /**
   * Connection options for GitHub (origin, token, tokenEnv, apiVersion).
   * Defaults to GitHub.com and token lookup from GITHUB_TOKEN or GH_TOKEN.
   */
  github?: GitHubConstructorOptions;

  /**
   * Search parameters to find GitHub issues.
   */
  search: GitHubIssueSearchParams;

  /**
   * How to construct a prompt for each issue. The following placeholders are
   * substituted:
   * - `{{id}}` - owner/repo#number
   * - `{{number}}` - the issue number
   * - `{{repository}}` - owner/repo
   * - `{{owner}}` - repository owner
   * - `{{repo}}` - repository name
   * - `{{title}}` - the issue title
   * - `{{url}}` - link to the issue on GitHub
   * - `{{state}}` - the issue state
   * - `{{author}}` - issue author login
   * - `{{assignee}}` - primary assignee login
   * - `{{assignees}}` - comma-separated assignee logins
   * - `{{labels}}` - comma-separated label names
   * - `{{milestone}}` - milestone title
   * - `{{commentCount}}` - issue comment count
   * - `{{createdAt}}` - creation timestamp
   * - `{{updatedAt}}` - last update timestamp
   * - `{{closedAt}}` - close timestamp
   * - `{{body}}` - issue body
   */
  promptTemplate: string;
}

/**
 * A PromptGenerator that queries GitHub for issues matching a search and
 * yields a prompt for each one. `basePath` is used to resolve
 * `{{include:...}}` macros in the prompt template and defaults to
 * `process.cwd()`. CLI config loading passes the config file's directory.
 */
export class GitHubPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'github';

  static async create(
    task: GitHubTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new GitHubPromptGenerator(task, basePath);
  }

  readonly #task: GitHubTask;
  readonly #basePath: string;

  constructor(task: GitHubTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const github = new GitHub(this.#task.github);
    const issues = await github.searchIssues(this.#task.search);
    const repository = this.#task.search.repository;
    const [owner, repo] = splitRepository(repository);

    for (const issue of issues) {
      const id = `${repository}#${issue.number}`;
      if (loopState.isOutstanding(id)) {
        const template = this.#task.promptTemplate;
        const variables = buildVariables(issue, {
          id,
          repository,
          owner,
          repo,
        });
        const prompt = await expandPrompt(template, this.#basePath, variables);

        yield { id, prompt };
      }
    }
  }

  /**
   * Preflight probe used by `--doctor`: delegate to the GitHub client's auth
   * probe, which validates token resolution and `GET /user` access using the
   * same connection options the generator uses for searches.
   */
  async *check(): AsyncIterable<CheckResult> {
    yield* new GitHub(this.#task.github).checkAuth();
  }
}

/**
 * Split an owner/repo repository name into its parts.
 */
function splitRepository(
  repository: string,
): readonly [owner: string, repo: string] {
  const [owner, repo] = repository.split('/');

  if (!owner || !repo || repository.split('/').length !== 2) {
    throw new Error(
      `GitHub repository must be in owner/repo form: ${repository}`,
    );
  }

  return [owner, repo];
}

/**
 * Build prompt template variables for a GitHub issue. Keep `body` last so any
 * placeholder-looking text inside the issue body is inserted after replacement
 * of other variables has finished.
 */
function buildVariables(
  issue: GitHubIssue,
  context: {
    readonly id: string;
    readonly repository: string;
    readonly owner: string;
    readonly repo: string;
  },
): Record<string, string> {
  return {
    id: context.id,
    number: String(issue.number),
    repository: context.repository,
    owner: context.owner,
    repo: context.repo,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    author: issue.user?.login ?? '',
    assignee: issue.assignee?.login ?? '',
    assignees: issue.assignees?.map(user => user.login).join(', ') ?? '',
    labels: labelNames(issue).join(', '),
    milestone: issue.milestone?.title ?? '',
    commentCount: String(issue.comments ?? 0),
    createdAt: issue.created_at ?? '',
    updatedAt: issue.updated_at ?? '',
    closedAt: issue.closed_at ?? '',
    body: issue.body ?? '',
  };
}

/**
 * Extract label names from a GitHub issue response.
 */
function labelNames(issue: GitHubIssue): ReadonlyArray<string> {
  return (
    issue.labels?.map(label => {
      return typeof label === 'string' ? label : label.name;
    }) ?? []
  );
}
