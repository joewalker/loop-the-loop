// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag github

import type { CheckResult } from 'loop-the-loop/doctor';
import { GitHubPromptGenerator } from 'loop-the-loop/prompt-generators/github';
import { describe, expect, it } from 'vitest';

/**
 * Collect all results from the generator's check() probe.
 */
async function collectCheck(
  generator: GitHubPromptGenerator,
): Promise<Array<CheckResult>> {
  const results: Array<CheckResult> = [];
  for await (const result of generator.check()) {
    results.push(result);
  }
  return results;
}

describe('GitHub live check() probe', () => {
  it(
    'authenticates against the real GitHub API when a token is set',
    { timeout: 30_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const generator = new GitHubPromptGenerator({
        search: { repository: 'octocat/Hello-World', query: 'is:open' },
        promptTemplate: 'Issue {{id}}',
      });

      const results = await collectCheck(generator);

      expect(results.some(r => r.status === 'fail')).toBe(false);
      expect(
        results.find(r => r.name === 'GET /user authenticates')?.status,
      ).toBe('ok');
    },
  );
});
