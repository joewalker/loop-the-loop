import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import type { LoopState } from '../util/loop-state.js';
import type {
  BugzillaConstructorOptions,
  SearchParams,
} from './bugzilla/bugzilla-types.js';
import { Bugzilla } from './bugzilla/bugzilla.js';

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

  /**
   * Directory used to resolve `{{include:...}}` paths in `promptTemplate`.
   * Defaults to `process.cwd()` when not specified. Callers that load this
   * task from a config file should pass `path.dirname(configFilePath)` so
   * that includes are resolved relative to the config file rather than the
   * process working directory.
   */
  basePath?: string;
}

/**
 * A PromptGenerator that queries Bugzilla for bugs matching a search and
 * yields a prompt for each one.
 */
export class BugzillaPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'bugzilla';

  static async create(task: BugzillaTask): Promise<PromptGenerator> {
    return new BugzillaPromptGenerator(task);
  }

  readonly #task: BugzillaTask;

  constructor(task: BugzillaTask) {
    this.#task = task;
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const bz = new Bugzilla(this.#task.bugzilla);
    const bugs = await bz.search(this.#task.search);

    for (const bug of bugs) {
      const id = String(bug.id);
      if (loopState.isOutstanding(id)) {
        const template = this.#task.promptTemplate;
        const basePath = this.#task.basePath ?? process.cwd();
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
        const prompt = await expandPrompt(template, basePath, variables);

        yield { id, prompt };
      }
    }
  }
}
