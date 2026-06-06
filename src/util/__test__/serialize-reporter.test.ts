// @module-tag local

import type { Prompt } from 'loop-the-loop/prompt-generators';
import type { Reporter } from 'loop-the-loop/reporters';
import type { InvokeResult } from 'loop-the-loop/types';
import { serializeReporter } from 'loop-the-loop/util/serialize-reporter';
import { describe, expect, it, vi } from 'vitest';

const PROMPT = (id: string): Prompt => ({ id, prompt: 'p' });
const OK: InvokeResult = { status: 'success', output: '' };

describe('serializeReporter', () => {
  it('runs appends one at a time in call order even if earlier ones are slower', async () => {
    const order: Array<string> = [];
    const inner: Reporter = {
      append: async prompt => {
        await new Promise<void>(resolve => {
          setTimeout(resolve, prompt.id === 'a' ? 20 : 5);
        });
        order.push(prompt.id);
      },
    };
    const reporter = serializeReporter(inner);
    await Promise.all([
      reporter.append(PROMPT('a'), OK),
      reporter.append(PROMPT('b'), OK),
    ]);
    expect(order).toEqual(['a', 'b']);
  });

  it('swallows a rejection on the chain so a later append still runs', async () => {
    const append = vi
      .fn<Reporter['append']>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const reporter = serializeReporter({ append });

    const first = reporter.append(PROMPT('a'), OK);
    const second = reporter.append(PROMPT('b'), OK);

    await expect(first).rejects.toThrow('disk full');
    await expect(second).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(2);
  });
});
