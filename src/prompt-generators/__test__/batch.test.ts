import type { Prompt, PromptGenerator } from 'loop-the-loop/prompt-generators';
import {
  BatchPromptGenerator,
  type BatchTask,
} from 'loop-the-loop/prompt-generators/batch';
import { LoopState } from 'loop-the-loop/util/loop-state';
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
    const loopState = new LoopState('');

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
    const loopState = new LoopState('');

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
    const loopState = new LoopState('');

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(9); // 6 items + 3 summaries
    expect(prompts[2].id).toBe('batch-summary-after-b');
    expect(prompts[5].id).toBe('batch-summary-after-d');
    expect(prompts[8].id).toBe('batch-summary-after-f');
  });

  it('yields nothing for an empty source', async () => {
    const source = makeSource([]);
    const generator = new BatchPromptGenerator(BASE_TASK, source);
    const loopState = new LoopState('');

    const prompts = await collect(generator, loopState);

    expect(prompts).toStrictEqual([]);
  });

  it('skips source items that are already completed', async () => {
    const source = makeSource(['a', 'b', 'c']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 10 },
      source,
    );
    const loopState = new LoopState('', ['a', 'c'], []);

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(2); // only 'b' + summary
    expect(prompts[0].id).toBe('b');
    expect(prompts[1].id).toBe('batch-summary-after-b');
  });

  it('skips a summary that is already completed', async () => {
    const source = makeSource(['a', 'b']);
    const generator = new BatchPromptGenerator(
      { ...BASE_TASK, batchSize: 10 },
      source,
    );
    const loopState = new LoopState('', ['batch-summary-after-b'], []);

    const prompts = await collect(generator, loopState);

    expect(prompts).toHaveLength(2); // 'a', 'b' but no summary
    expect(prompts.map(p => p.id)).toStrictEqual(['a', 'b']);
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
    const loopState = new LoopState('');

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
    const loopState = new LoopState('');

    const prompts = await collect(generator, loopState);

    // 50 items + 1 summary
    expect(prompts).toHaveLength(51);
    expect(prompts[50].id).toBe('batch-summary-after-49');
  });
});
