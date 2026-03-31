import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReporter, reporterTypes } from 'loop-the-loop/reporters';
import { JsonlReporter } from 'loop-the-loop/reporters/jsonl';
import { YamlReporter } from 'loop-the-loop/reporters/yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('reporterTypes', () => {
  it('should include yaml and jsonl', () => {
    expect(reporterTypes).toContain(YamlReporter.reporterName);
    expect(reporterTypes).toContain(JsonlReporter.reporterName);
  });
});

describe('createReporter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reporters-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create a YamlReporter when type is "yaml-report"', async () => {
    const reporter = await createReporter('yaml-report', {
      outputDir: tempDir,
      jobName: 'test',
    });
    expect(reporter).toBeInstanceOf(YamlReporter);
  });

  it('should create a JsonlReporter when type is "jsonl-report"', async () => {
    const reporter = await createReporter('jsonl-report', {
      outputDir: tempDir,
      jobName: 'test',
    });
    expect(reporter).toBeInstanceOf(JsonlReporter);
  });

  it('should create a YamlReporter when type is "default"', async () => {
    const reporter = await createReporter('default', {
      outputDir: tempDir,
      jobName: 'test',
    });
    expect(reporter).toBeInstanceOf(YamlReporter);
  });
});
