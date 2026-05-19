import {
  Bugzilla,
  type BugzillaConstructorOptions,
  type SearchParams,
} from '@joewalker/bzjs';

import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type { LoopState } from '../util/loop-state.js';

/**
 * Configuration for a Bugzilla-driven loop task. Describes which bugs
 * to search for and what prompt to generate for each one.
 */
export interface BugzillaTask {
  /**
   * Connection options for the Bugzilla instance (origin, apiKey).
   * Defaults to bugzilla.mozilla.org with no API key.
   */
  bugzilla?: BugzillaConstructorOptions;

  /**
   * Search parameters to find bugs.
   */
  search: SearchParams;

  /**
   * How to construct a prompt for each bug. The following placeholders are
   * substituted:
   * - `{{id}}` - the bug id
   * - `{{summary}}` - the bug summary
   * - `{{url}}` - link to the bug on Bugzilla
   * - `{{component}}` - the bug's component
   * - `{{product}}` - the bug's product
   * - `{{severity}}` - the bug's severity
   * - `{{status}}` - the bug's status
   * - `{{assignee}}` - the bug's assignee
   * - `{{whiteboard}}` - the bug's whiteboard field
   */
  promptTemplate: string;
}

/**
 * A PromptGenerator that queries Bugzilla for bugs matching a search and
 * yields a prompt for each one. `basePath` is used to resolve
 * `{{include:...}}` macros in the prompt template and defaults to
 * `process.cwd()`. CLI config loading passes the config file's directory.
 */
export class BugzillaPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'bugzilla';

  static async create(
    task: BugzillaTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new BugzillaPromptGenerator(task, basePath);
  }

  readonly #task: BugzillaTask;
  readonly #basePath: string;

  constructor(task: BugzillaTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const bz = new Bugzilla(this.#task.bugzilla);
    const { bugs } = await bz.search(this.#task.search);

    for (const bug of bugs) {
      const id = String(bug.id);
      if (loopState.isOutstanding(id)) {
        const template = this.#task.promptTemplate;
        const variables = {
          id: String(bug.id),
          summary: bug.summary,
          url: `${bz.origin}/show_bug.cgi?id=${bug.id}`,
          component: bug.component,
          product: bug.product,
          severity: bug.severity,
          status: bug.status,
          assignee: bug.assigned_to,
          whiteboard: bug.whiteboard,
        };
        const prompt = await expandPrompt(template, this.#basePath, variables);

        yield { id, prompt };
      }
    }
  }
}
