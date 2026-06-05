// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag gitlab

import type { LoopState } from 'loop-the-loop/loop-states';
import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt } from 'loop-the-loop/prompt-generators';
import { GitLabPromptGenerator } from 'loop-the-loop/prompt-generators/gitlab';
import { describe, expect, it } from 'vitest';

const DEFAULT_PROJECT = 'gitlab-org/gitlab';

/**
 * Read a live-test environment override, falling back to a stable public
 * GitLab project used by the default check.
 */
function readEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Read an optional live-test environment override.
 */
function readOptionalEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Collect all prompts emitted by a prompt generator.
 */
async function collectPrompts(
  generator: GitLabPromptGenerator,
  loopState: LoopState,
): Promise<Array<Prompt>> {
  const prompts: Array<Prompt> = [];

  for await (const prompt of generator.generate(loopState)) {
    prompts.push(prompt);
  }

  return prompts;
}

describe('GitLab live prompt generator', () => {
  it(
    'generates a prompt from a live GitLab issue search',
    { timeout: 30_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const project = readEnv('LOOP_TEST_GITLAB_PROJECT', DEFAULT_PROJECT);
      const origin = readOptionalEnv('LOOP_TEST_GITLAB_ORIGIN');
      const searchText = readOptionalEnv('LOOP_TEST_GITLAB_SEARCH');
      const generator = new GitLabPromptGenerator({
        ...(origin === undefined ? {} : { gitlab: { origin } }),
        search: {
          project,
          state: 'opened',
          ...(searchText === undefined ? {} : { search: searchText }),
          orderBy: 'updated_at',
          sort: 'desc',
          perPage: 1,
          maxResults: 1,
        },
        promptTemplate:
          'Issue {{id}}\nTitle: {{title}}\nURL: {{url}}\nState: {{state}}\nAuthor: {{author}}\nLabels: {{labels}}\nComment count: {{commentCount}}\n\n{{description}}',
      });
      const loopState = new FileLoopState('ignored.json');

      const prompts = await collectPrompts(generator, loopState);

      expect(prompts).toHaveLength(1);

      const [prompt] = prompts;
      expect(prompt.id.startsWith(`${project}#`)).toBe(true);
      expect(Number(prompt.id.slice(project.length + 1))).toBeGreaterThan(0);
      expect(prompt.prompt).toContain(`Issue ${prompt.id}`);
      expect(prompt.prompt).toContain('Title: ');
      expect(prompt.prompt).toContain('URL: ');
      expect(prompt.prompt).toContain('State: ');
    },
  );
});
