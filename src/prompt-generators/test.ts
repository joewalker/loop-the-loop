import type { CheckResult } from '../doctor.js';
import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { assertKnownProperties, isRecord } from './util/config.js';

/**
 * Configuration for a prompt generator that yields a fixed list of prompts.
 */
export interface TestTask {
  /**
   * Prompts to yield, in order. Prompt IDs are stable stringified array
   * indices so loop state can skip completed prompts on resume.
   */
  readonly prompts: ReadonlyArray<string>;
}

/**
 * Normalize test task config values loaded from JSON.
 */
export function normalizeTestTaskConfig(config: unknown): TestTask {
  assertTestTaskConfig(config);
  return config;
}

/**
 * A PromptGenerator that yields a static list of configured prompts.
 */
export class TestPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'test';

  static async create(task: TestTask): Promise<PromptGenerator> {
    return new TestPromptGenerator(task);
  }

  readonly #task: TestTask;

  constructor(task: TestTask) {
    this.#task = task;
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    for (let index = 0; index < this.#task.prompts.length; index++) {
      const id = String(index);

      if (loopState.isOutstanding(id)) {
        yield {
          id,
          prompt: this.#task.prompts[index],
        };
      }
    }
  }

  /**
   * Preflight probe used by `--doctor`: the test generator has no external
   * dependencies, so it trivially reports ok.
   */
  async *check(): AsyncIterable<CheckResult> {
    yield { name: 'test generator', status: 'ok' };
  }
}

/**
 * Assert that an unknown value has the runtime shape required for a test task
 * config.
 */
function assertTestTaskConfig(value: unknown): asserts value is TestTask {
  if (!isRecord(value)) {
    throw new Error('test task config must be an object');
  }

  assertKnownProperties(value, ['prompts'], 'test');

  const prompts = value['prompts'];
  if (
    !Array.isArray(prompts) ||
    prompts.some(prompt => typeof prompt !== 'string')
  ) {
    throw new Error('test.prompts must be an array of strings');
  }
}
