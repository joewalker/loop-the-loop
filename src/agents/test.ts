import type { InvokeResult } from '../types.js';
import type { Agent } from './agents.js';

/**
 * A test implementation of the Agent interface allows us to insert test
 * responses to prompts
 */
export class TestAgent implements Agent {
  static readonly agentName = 'test';
  #results: Array<InvokeResult> = [];

  setNextInvokeResult(...results: Array<InvokeResult>): void {
    this.#results = results;
  }

  async invoke(_prompt: string): Promise<InvokeResult> {
    const result = this.#results.shift();
    if (result != null) {
      return result;
    } else {
      return { status: 'error', reason: '#results is empty' };
    }
  }
}
