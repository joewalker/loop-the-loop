// @module-tag local

import { resolve } from 'node:path';

import { resolveStepHandoff } from 'loop-the-loop/prompt-generators/util/handoff';
import { describe, expect, it } from 'vitest';

describe('resolveStepHandoff', () => {
  const outputDir = '/out';

  it('resolves a report handoff to a jsonl file under outputDir', () => {
    expect(resolveStepHandoff('{{steps.review.report}}', outputDir)).toBe(
      resolve(outputDir, 'review-report.jsonl'),
    );
  });

  it('resolves a state handoff to a loop-state file under outputDir', () => {
    expect(resolveStepHandoff('{{steps.fix.state}}', outputDir)).toBe(
      resolve(outputDir, 'fix-loop-state.json'),
    );
  });

  it('leaves a plain path unchanged', () => {
    expect(resolveStepHandoff('data/report.jsonl', outputDir)).toBe(
      'data/report.jsonl',
    );
  });

  it('supports step names with dashes and underscores', () => {
    expect(resolveStepHandoff('{{steps.fix_bug-2.report}}', outputDir)).toBe(
      resolve(outputDir, 'fix_bug-2-report.jsonl'),
    );
  });
});
