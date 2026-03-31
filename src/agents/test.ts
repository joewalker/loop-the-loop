import type { InvokeResult } from '../types.js';
import type { Agent, InvokeOptions } from '../agents.js';

/**
 * A test implementation of the Agent interface allows us to insert test
 * responses to prompts
 */
export class TestAgent implements Agent {
  static readonly agentName = 'test';

  static async create(): Promise<Agent> {
    return new TestAgent();
  }

  #results: Array<InvokeResult> = [];

  setNextInvokeResult(...results: Array<InvokeResult>): void {
    this.#results = results;
  }

  async invoke(
    _prompt: string,
    _options?: InvokeOptions,
  ): Promise<InvokeResult> {
    const result = this.#results.shift();
    if (result != null) {
      return result;
    } else {
      return { status: 'error', reason: '#results is empty' };
    }
  }
}
