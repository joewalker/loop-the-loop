// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag gitlab

import type { CheckResult } from 'loop-the-loop/doctor';
import { GitLabPromptGenerator } from 'loop-the-loop/prompt-generators/gitlab';
import { describe, expect, it } from 'vitest';

/**
 * Collect all results from the generator's check() probe.
 */
async function collectCheck(
  generator: GitLabPromptGenerator,
): Promise<Array<CheckResult>> {
  const results: Array<CheckResult> = [];
  for await (const result of generator.check()) {
    results.push(result);
  }
  return results;
}

describe('GitLab live check() probe', () => {
  it(
    'authenticates against the real GitLab API when a token is set',
    { timeout: 30_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const generator = new GitLabPromptGenerator({
        search: { project: 'gitlab-org/gitlab' },
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
