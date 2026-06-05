import {
  Bugzilla,
  type BugzillaConstructorOptions,
  type SearchParams,
} from '@joewalker/bzjs';

import type { CheckResult } from '../doctor.js';
import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';

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

  /**
   * Preflight probe used by `--doctor`: confirm an API key is configured and
   * that it authenticates against the Bugzilla `GET /rest/whoami` endpoint.
   * The Bugzilla client is constructed the same way as for searches so the
   * resolved origin matches. Skips the whoami probe when no key is set.
   */
  async *check(): AsyncIterable<CheckResult> {
    const bz = new Bugzilla(this.#task.bugzilla);
    const apiKey = this.#task.bugzilla?.apiKey;

    if (apiKey === undefined) {
      yield {
        name: 'api key resolvable',
        status: 'fail',
        message: 'set bugzilla.apiKey to authenticate',
      };
      yield {
        name: 'whoami authenticates',
        status: 'skip',
        message: 'no api key',
      };
      return;
    }

    yield { name: 'api key resolvable', status: 'ok' };

    try {
      const url = `${bz.origin}/rest/whoami?api_key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      const body = (await response.json()) as {
        error?: boolean;
        message?: string;
      };
      if (response.ok && body.error !== true) {
        yield {
          name: 'whoami authenticates',
          status: 'ok',
          message: `HTTP ${response.status}`,
        };
      } else {
        yield {
          name: 'whoami authenticates',
          status: 'fail',
          message:
            body.message ?? `HTTP ${response.status} ${response.statusText}`,
        };
      }
    } catch (err) {
      yield {
        name: 'whoami authenticates',
        status: 'fail',
        message:
          err instanceof Error
            ? err.message
            : /* istanbul ignore next */ String(err),
        cause: err,
      };
    }
  }
}
