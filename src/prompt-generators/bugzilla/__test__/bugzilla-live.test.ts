import type { Prompt } from 'loop-the-loop/prompt-generators';
import { BugzillaPromptGenerator } from 'loop-the-loop/prompt-generators/bugzilla';
import { LoopState } from 'loop-the-loop/util/loop-state';
import { describe, expect, it } from 'vitest';

const DEFAULT_ORIGIN = 'https://bugzilla.mozilla.org';
const DEFAULT_BUG_ID = '2000000';

/**
 * Read a live-test environment override, falling back to the stable public
 * Bugzilla bug used by the default check.
 */
function readEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Read a positive integer live-test environment override.
 */
function readPositiveIntegerEnv(name: string, fallback: string): number {
  const value = readEnv(name, fallback);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Collect all prompts emitted by a prompt generator.
 */
async function collectPrompts(
  generator: BugzillaPromptGenerator,
  loopState: LoopState,
): Promise<Array<Prompt>> {
  const prompts: Array<Prompt> = [];

  for await (const prompt of generator.generate(loopState)) {
    prompts.push(prompt);
  }

  return prompts;
}

describe(
  'Bugzilla live prompt generator',
  { tags: ['extra', 'network', 'bugzilla'] },
  () => {
    it(
      'generates a prompt from a live Bugzilla bug search',
      { timeout: 30_000, retry: { count: 1, delay: 1_000 } },
      async () => {
        const origin = readEnv('LOOP_TEST_BUGZILLA_ORIGIN', DEFAULT_ORIGIN);
        const bugId = readPositiveIntegerEnv(
          'LOOP_TEST_BUGZILLA_ID',
          DEFAULT_BUG_ID,
        );
        const generator = new BugzillaPromptGenerator({
          bugzilla: { origin },
          search: {
            ids: [bugId],
          },
          promptTemplate:
            'Bug {{id}}\nSummary: {{summary}}\nURL: {{url}}\nProduct: {{product}}\nComponent: {{component}}\nSeverity: {{severity}}\nStatus: {{status}}\nAssignee: {{assignee}}\nWhiteboard: {{whiteboard}}',
        });
        const loopState = new LoopState('ignored.json');

        const prompts = await collectPrompts(generator, loopState);

        expect(prompts).toHaveLength(1);

        const [prompt] = prompts;
        expect(prompt.id).toBe(String(bugId));
        expect(prompt.prompt).toContain(`Bug ${bugId}`);
        expect(prompt.prompt).toContain(
          `URL: ${origin}/show_bug.cgi?id=${bugId}`,
        );
        expect(prompt.prompt).toContain('Summary: ');
        expect(prompt.prompt).toContain('Status: ');
      },
    );
  },
);
