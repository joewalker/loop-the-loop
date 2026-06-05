// @module-tag live
// @module-tag extra
// @module-tag network
// @module-tag bugzilla

import type { CheckResult } from 'loop-the-loop/doctor';
import { BugzillaPromptGenerator } from 'loop-the-loop/prompt-generators/bugzilla';
import { describe, expect, it } from 'vitest';

const DEFAULT_ORIGIN = 'https://bugzilla.mozilla.org';

/**
 * Read a live-test environment override, falling back to the supplied default.
 */
function readEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Collect all results from the generator's check() probe.
 */
async function collectCheck(
  generator: BugzillaPromptGenerator,
): Promise<Array<CheckResult>> {
  const results: Array<CheckResult> = [];
  for await (const result of generator.check()) {
    results.push(result);
  }
  return results;
}

describe('Bugzilla live check() probe', () => {
  it(
    'authenticates whoami against the real Bugzilla API when an api key is set',
    { timeout: 30_000, retry: { count: 1, delay: 1_000 } },
    async () => {
      const origin = readEnv('LOOP_TEST_BUGZILLA_ORIGIN', DEFAULT_ORIGIN);
      const apiKey = process.env['LOOP_TEST_BUGZILLA_API_KEY'];
      if (apiKey === undefined) {
        throw new Error(
          'LOOP_TEST_BUGZILLA_API_KEY must be set for the Bugzilla live check probe',
        );
      }

      const generator = new BugzillaPromptGenerator({
        bugzilla: { origin, apiKey },
        search: { product: 'Core' },
        promptTemplate: 'Bug {{id}}',
      });

      const results = await collectCheck(generator);

      expect(results.some(r => r.status === 'fail')).toBe(false);
      expect(results.find(r => r.name === 'whoami authenticates')?.status).toBe(
        'ok',
      );
    },
  );
});
