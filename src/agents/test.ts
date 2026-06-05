import type { Agent, InvokeOptions } from '../agents.js';
import type { CheckResult } from '../doctor.js';
import type { InvokeResult } from '../types.js';

/**
 * How TestAgent behaves once the configured `responses` list is exhausted.
 *
 * - `none` (default): subsequent invocations return an error result. This is
 *   the strict matching mode used by unit tests that want to assert each
 *   prompt is paired with a specific canned response.
 * - `cycle`: invocations wrap back to the first response and keep going.
 *   Suitable for `--dry-run` and any other use case where a single canned
 *   response should answer every prompt the generator produces.
 */
export type TestAgentRepeat = 'none' | 'cycle';

/**
 * JSON-configurable form for a `TestAgent`, used both by hand-written CLI
 * configs that want to short-circuit the real agent and by the `--dry-run`
 * flag, which synthesises a config of this shape internally.
 */
export interface TestAgentConfig {
  readonly responses: ReadonlyArray<InvokeResult>;
  readonly repeat?: TestAgentRepeat;
}

/**
 * A test implementation of the Agent interface that returns a fixed list of
 * canned responses. Useful in two settings:
 *
 * 1. Unit tests that want to control exactly what each `invoke()` returns
 *    (constructed directly and primed via `setNextInvokeResult`).
 * 2. CLI configurations that want to exercise the loop without calling a real
 *    agent, including the built-in `--dry-run` flag (constructed via
 *    `TestAgent.create({ responses, repeat })`).
 */
export class TestAgent implements Agent {
  static readonly agentName = 'test';

  /**
   * Construct a `TestAgent` for use as a registered CLI agent. The config is
   * required: without a `responses` list the agent would error on the first
   * prompt, which is the trap that motivated keeping the bare `"test"` agent
   * name out of CLI configs (see joewalker/loop-the-loop#19).
   */
  static async create(config: TestAgentConfig): Promise<TestAgent> {
    if (config == null || !Array.isArray(config.responses)) {
      throw new Error(
        "Agent 'test' requires a config { responses: [...], repeat?: 'none' | 'cycle' }",
      );
    }
    return new TestAgent(config);
  }

  #results: Array<InvokeResult>;
  #repeat: TestAgentRepeat;
  #cycleIndex = 0;

  constructor(config?: TestAgentConfig) {
    this.#results = config?.responses ? [...config.responses] : [];
    this.#repeat = config?.repeat ?? 'none';
  }

  setNextInvokeResult(...results: Array<InvokeResult>): void {
    this.#results = results;
    this.#repeat = 'none';
    this.#cycleIndex = 0;
  }

  async invoke(
    _prompt: string,
    _options?: InvokeOptions,
  ): Promise<InvokeResult> {
    if (this.#results.length === 0) {
      return { status: 'error', reason: '#results is empty' };
    }
    if (this.#repeat === 'cycle') {
      const result = this.#results[this.#cycleIndex % this.#results.length];
      this.#cycleIndex += 1;
      return result;
    }
    const result = this.#results.shift();
    /* istanbul ignore if -- guarded above by the empty-list check, so this
       branch is unreachable today. Keep it for type-narrowing and as a
       safety net if the early return is ever refactored. */
    if (result == null) {
      return { status: 'error', reason: '#results is empty' };
    }
    return result;
  }

  /**
   * Preflight probe used by `--doctor`. Reports whether the agent has any
   * canned responses to serve; an empty `responses` list means every
   * invocation would error.
   */
  async *check(): AsyncIterable<CheckResult> {
    yield this.#results.length > 0
      ? { name: 'responses configured', status: 'ok' }
      : {
          name: 'responses configured',
          status: 'fail',
          message: 'responses must be non-empty',
        };
  }
}
