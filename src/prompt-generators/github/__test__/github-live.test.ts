// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag github

import type { Prompt } from 'loop-the-loop/prompt-generators';
import { GitHubPromptGenerator } from 'loop-the-loop/prompt-generators/github';
import { LoopState } from 'loop-the-loop/util/loop-state';
import { describe, expect, it } from 'vitest';

const DEFAULT_REPOSITORY = 'octocat/Hello-World';
const DEFAULT_QUERY = 'created:>=2000-01-01';

/**
 * Read a live-test environment override, falling back to the stable public
 * GitHub repository used by the default check.
 */
function readEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Collect all prompts emitted by a prompt generator.
 */
async function collectPrompts(
  generator: GitHubPromptGenerator,
  loopState: LoopState,
): Promise<Array<Prompt>> {
  const prompts: Array<Prompt> = [];

  for await (const prompt of generator.generate(loopState)) {
    prompts.push(prompt);
  }

  return prompts;
}

describe('GitHub live prompt generator', () => {
  it(
    'generates a prompt from a live GitHub issue search',
    { timeout: 30_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const repository = readEnv(
        'LOOP_TEST_GITHUB_REPOSITORY',
        DEFAULT_REPOSITORY,
      );
      const query = readEnv('LOOP_TEST_GITHUB_QUERY', DEFAULT_QUERY);
      const generator = new GitHubPromptGenerator({
        search: {
          repository,
          query,
          sort: 'updated',
          order: 'desc',
          perPage: 1,
          maxResults: 1,
        },
        promptTemplate:
          'Issue {{id}}\nTitle: {{title}}\nURL: {{url}}\nState: {{state}}\nAuthor: {{author}}\nLabels: {{labels}}\nComment count: {{commentCount}}\n\n{{body}}',
      });
      const loopState = new LoopState('ignored.json');

      const prompts = await collectPrompts(generator, loopState);

      expect(prompts).toHaveLength(1);

      const [prompt] = prompts;
      expect(prompt.id.startsWith(`${repository}#`)).toBe(true);
      expect(Number(prompt.id.slice(repository.length + 1))).toBeGreaterThan(0);
      expect(prompt.prompt).toContain(`Issue ${prompt.id}`);
      expect(prompt.prompt).toContain(
        `URL: https://github.com/${repository}/issues/`,
      );
      expect(prompt.prompt).toContain('Title: ');
      expect(prompt.prompt).toContain('State: ');
    },
  );
});
