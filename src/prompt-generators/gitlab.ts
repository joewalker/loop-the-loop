import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type {
  GitLabConstructorOptions,
  GitLabIssue,
  GitLabIssueSearchParams,
} from './gitlab/gitlab-types.js';
import { GitLab } from './gitlab/gitlab.js';

/**
 * Configuration for a GitLab-issues-driven loop task. Describes which issues
 * to search for and what prompt to generate for each one.
 */
export interface GitLabTask {
  /**
   * Connection options for GitLab (origin, token, tokenEnv, userAgent).
   * Defaults to GitLab.com API v4 and token lookup from GITLAB_TOKEN or
   * GL_TOKEN.
   */
  gitlab?: GitLabConstructorOptions;

  /**
   * Search parameters to find GitLab project issues.
   */
  search: GitLabIssueSearchParams;

  /**
   * How to construct a prompt for each issue. The following placeholders are
   * substituted:
   * - `{{id}}` - project#iid
   * - `{{iid}}` - project-local issue ID
   * - `{{project}}` - configured project ID or path
   * - `{{title}}` - the issue title
   * - `{{url}}` - link to the issue on GitLab
   * - `{{state}}` - the issue state
   * - `{{author}}` - issue author username
   * - `{{assignee}}` - primary assignee username
   * - `{{assignees}}` - comma-separated assignee usernames
   * - `{{labels}}` - comma-separated label names
   * - `{{milestone}}` - milestone title
   * - `{{commentCount}}` - issue note count
   * - `{{createdAt}}` - creation timestamp
   * - `{{updatedAt}}` - last update timestamp
   * - `{{closedAt}}` - close timestamp
   * - `{{description}}` - issue description
   */
  promptTemplate: string;
}

/**
 * A PromptGenerator that queries GitLab for issues matching a search and
 * yields a prompt for each one. `basePath` is used to resolve
 * `{{include:...}}` macros in the prompt template and defaults to
 * `process.cwd()`. CLI config loading passes the config file's directory.
 */
export class GitLabPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'gitlab';

  static async create(
    task: GitLabTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new GitLabPromptGenerator(task, basePath);
  }

  readonly #task: GitLabTask;
  readonly #basePath: string;

  constructor(task: GitLabTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const gitlab = new GitLab(this.#task.gitlab);
    const issues = await gitlab.searchIssues(this.#task.search);
    const project = this.#task.search.project;

    for (const issue of issues) {
      const id = `${project}#${issue.iid}`;
      if (loopState.isOutstanding(id)) {
        const template = this.#task.promptTemplate;
        const variables = buildVariables(issue, { id, project });
        const prompt = await expandPrompt(template, this.#basePath, variables);

        yield { id, prompt };
      }
    }
  }
}

/**
 * Build prompt template variables for a GitLab issue. Keep `description` last
 * so any placeholder-looking text inside the issue description is inserted
 * after replacement of other variables has finished.
 */
function buildVariables(
  issue: GitLabIssue,
  context: {
    readonly id: string;
    readonly project: string;
  },
): Record<string, string> {
  return {
    id: context.id,
    iid: String(issue.iid),
    project: context.project,
    title: issue.title,
    url: issue.web_url,
    state: issue.state,
    author: issue.author?.username ?? '',
    assignee: issue.assignee?.username ?? '',
    assignees: issue.assignees?.map(user => user.username).join(', ') ?? '',
    labels: issue.labels?.join(', ') ?? '',
    milestone: issue.milestone?.title ?? '',
    commentCount: String(issue.user_notes_count ?? 0),
    createdAt: issue.created_at ?? '',
    updatedAt: issue.updated_at ?? '',
    closedAt: issue.closed_at ?? '',
    description: issue.description ?? '',
  };
}
