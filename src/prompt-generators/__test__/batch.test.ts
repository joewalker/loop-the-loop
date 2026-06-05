// @module-tag local

import type { LoopState } from 'loop-the-loop/loop-states';
import { FileLoopState } from 'loop-the-loop/loop-states/file';
import type { Prompt, PromptGenerator } from 'loop-the-loop/prompt-generators';
import {
  BatchPromptGenerator,
  type BatchTask,
} from 'loop-the-loop/prompt-generators/batch';
import { describe, expect, it } from 'vitest';

/**
 * Build a simple PromptGenerator that yields one prompt per ID.
 */
function makeSource(ids: ReadonlyArray<string>): PromptGenerator {
  return {
    async *generate(loopState: LoopState) {
      for (const id of ids) {
        if (loopState.isOutstanding(id)) {
          yield { id, prompt: `prompt for ${id}` };
        }
      }
    },
  };
}

/**
 * Collect all prompts from a generator into an array.
 */
async function collect(
  generator: PromptGenerator,
  loopState: LoopState,
): Promise<Array<Prompt>> {
  const prompts: Array<Prompt> = [];
  for await (const p of generator.generate(loopState)) {
    prompts.push(p);
  }
  return prompts;
}

const BASE_TASK: BatchTask = {
  source: null, // replaced per-test via constructor
  summaryPromptTemplate:
    'Summarize: {{batchIds}} ({{batchSize}} items) from {{reportFile}}',
  reportFile: '/tmp/report.yaml',
};

describe('BatchPromptGenerator', () => {
  it('yields source items then a summary for a partial batch', async () => {
    const source = makeSource(['a', 'b', 'c']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 10 },
      source,
    );
    const loopState = new FileLoopState('');

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(4);
    expect(prompts[0].id).toBe('a');
    expect(prompts[1].id).toBe('b');
    expect(prompts[2].id).toBe('c');
    expect(prompts[3].id).toBe('batch-summary-after-c');
  });

  it('yields a summary after exactly batchSize items', async () => {
    const source = makeSource(['x', 'y']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 2 },
      source,
    );
    const loopState = new FileLoopState('');

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(3);
    expect(prompts[2].id).toBe('batch-summary-after-y');
  });

  it('yields multiple batch summaries for multiple full batches', async () => {
    const source = makeSource(['a', 'b', 'c', 'd', 'e', 'f']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 2 },
      source,
    );
    const loopState = new FileLoopState('');

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(9); // 6 items + 3 summaries
    expect(prompts[2].id).toBe('batch-summary-after-b');
    expect(prompts[5].id).toBe('batch-summary-after-d');
    expect(prompts[8].id).toBe('batch-summary-after-f');
  });

  it('yields nothing for an empty source', async () => {
    const source = makeSource([]);
    const generator = new BatchPromptGenerator(BASE_TASK, source);
    const loopState = new FileLoopState('');

    const prompts = await collect(generator, loopState);

    expect(prompts).toStrictEqual([]);
  });

  it('skips source items that are already completed but keeps stable summary IDs', async () => {
    const source = makeSource(['a', 'b', 'c']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 10 },
      source,
    );
    const loopState = FileLoopState.fromPersisted('', {
      version: 2,
      results: { a: { status: 'success' }, c: { status: 'success' } },
      claims: {},
    });

    const prompts = await collect(generator, loopState);

    // Only 'b' is outstanding so it is the only source item yielded, but
    // the summary ID is still derived from the source's logical last item
    // ('c') so it stays stable across resumes.
    expect(prompts).toHaveLength(2);
    expect(prompts[0].id).toBe('b');
    expect(prompts[1].id).toBe('batch-summary-after-c');
  });

  it('re-emits a trailing summary when every source item is already completed', async () => {
    // Failure mode #1 from issue #47: a previous run completed every source
    // item but was interrupted before the trailing summary completed. On
    // resume the summary must still fire under its original ID.
    const source = makeSource(['a', 'b']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 10 },
      source,
    );
    const loopState = FileLoopState.fromPersisted('', {
      version: 2,
      results: { a: { status: 'success' }, b: { status: 'success' } },
      claims: {},
    });

    const prompts = await collect(generator, loopState);

    expect(prompts.map(p => p.id)).toStrictEqual(['batch-summary-after-b']);
  });

  it('keeps batch boundaries stable across resumes when inner items are completed', async () => {
    // Failure mode #2 from issue #47: with batchSize=2 and source a,b,c, a
    // fresh run yields summaries `after-b` and `after-c`. If 'a' completed
    // in a prior run, the resume must still yield those same summary IDs
    // (not shift to `after-c` only).
    const source = makeSource(['a', 'b', 'c']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 2 },
      source,
    );
    const loopState = FileLoopState.fromPersisted('', {
      version: 2,
      results: { a: { status: 'success' } },
      claims: {},
    });

    const prompts = await collect(generator, loopState);

    expect(prompts.map(p => p.id)).toStrictEqual([
      'b',
      'batch-summary-after-b',
      'c',
      'batch-summary-after-c',
    ]);
  });

  it('summary batchIds include items completed in previous runs', async () => {
    // The summary describes the whole batch, including items that completed
    // in earlier runs, so the agent can read consistent results from the
    // report file.
    const source = makeSource(['a', 'b', 'c']);
    const generator = new BatchPromptGenerator(
      {
        ...BASE_TASK,
        batchSize: 10,
        summaryPromptTemplate: 'ids={{batchIds}} count={{batchSize}}',
      },
      source,
    );
    const loopState = FileLoopState.fromPersisted('', {
      version: 2,
      results: { a: { status: 'success' }, c: { status: 'success' } },
      claims: {},
    });

    const prompts = await collect(generator, loopState);
    const summary = prompts[prompts.length - 1];

    expect(summary.id).toBe('batch-summary-after-c');
    expect(summary.prompt).toBe('ids=a\nb\nc count=3');
  });

  it('skips a summary that is already completed', async () => {
    const source = makeSource(['a', 'b']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 10 },
      source,
    );
    const loopState = FileLoopState.fromPersisted('', {
      version: 2,
      results: { 'batch-summary-after-b': { status: 'success' } },
      claims: {},
    });

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(2); // 'a', 'b' but no summary
    expect(prompts.map(p => p.id)).toStrictEqual(['a', 'b']);
  });

  it('skips an inner batch summary that is already completed', async () => {
    const source = makeSource(['a', 'b', 'c']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 2 },
      source,
    );
    const loopState = FileLoopState.fromPersisted('', {
      version: 2,
      results: {
        'batch-summary-after-b': { status: 'success' },
        'batch-summary-after-c': { status: 'success' },
      },
      claims: {},
    });

    const prompts = await collect(generator, loopState);

    expect(prompts.map(p => p.id)).toStrictEqual(['a', 'b', 'c']);
  });

  it('injects batchSize, batchIds, and reportFile into the summary prompt', async () => {
    const source = makeSource(['bug-1', 'bug-2']);
    const generator = new BatchPromptGenerator(
      {
        ...BASE_TASK,
        batchSize: 10,
        summaryPromptTemplate:
          'count={{batchSize}} ids={{batchIds}} file={{reportFile}}',
        reportFile: '/output/report.yaml',
      },
      source,
    );
    const loopState = new FileLoopState('');

    const prompts = await collect(generator, loopState);
    const summary = prompts[prompts.length - 1];

    expect(summary.prompt).toBe(
      'count=2 ids=bug-1\nbug-2 file=/output/report.yaml',
    );
  });

  it('defaults to batchSize 50', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(i));
    const source = makeSource(ids);
    const generator = new BatchPromptGenerator(BASE_TASK, source);
    const loopState = new FileLoopState('');

    const prompts = await collect(generator, loopState);

    // 50 items + 1 summary
    expect(prompts).toHaveLength(51);
    expect(prompts[50].id).toBe('batch-summary-after-49');
  });

  describe('check()', () => {
    const drain = async (
      generator: BatchPromptGenerator,
    ): Promise<Array<{ name: string; status: string; message?: string }>> => {
      const results = [];
      for await (const result of generator.check()) {
        results.push(result);
      }
      return results;
    };

    it('delegates to the source check and prefixes result names', async () => {
      const source: PromptGenerator = {
        async *generate() {},
        async *check() {
          yield { name: 'token resolvable', status: 'ok' };
          yield {
            name: 'GET /user authenticates',
            status: 'fail',
            message: '401',
          };
        },
      };
      const generator = new BatchPromptGenerator(BASE_TASK, source);

      const results = await drain(generator);

      expect(results).toStrictEqual([
        { name: 'source: token resolvable', status: 'ok' },
        {
          name: 'source: GET /user authenticates',
          status: 'fail',
          message: '401',
        },
      ]);
    });

    it('yields one skip when the source has no check()', async () => {
      const source = makeSource(['a']);
      const generator = new BatchPromptGenerator(BASE_TASK, source);

      const results = await drain(generator);

      expect(results).toStrictEqual([
        {
          name: 'source',
          status: 'skip',
          message: 'source has no diagnostics defined',
        },
      ]);
    });
  });
});
