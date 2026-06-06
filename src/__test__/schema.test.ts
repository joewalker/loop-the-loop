// @module-tag local

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { Ajv, type ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';

const SCHEMA_PATH = join(
  import.meta.dirname,
  '../../schema/loop-the-loop.schema.json',
);
const EXAMPLES_DIR = join(import.meta.dirname, '../examples');

/**
 * Collect every `*.json` example beneath `src/examples`, recursing into
 * subdirectories. The set is ignored when no examples are present so that
 * vitest does not fail with "No test found in suite" before the schema
 * compiles cleanly.
 */
function collectExampleFiles(dir: string): ReadonlyArray<string> {
  const out: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectExampleFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.json') &&
      !entry.name.endsWith('-loop-state.json')
    ) {
      out.push(full);
    }
  }
  return out.sort();
}

const exampleFiles = collectExampleFiles(EXAMPLES_DIR).map(p =>
  relative(EXAMPLES_DIR, p),
);

describe('CLI config schema', () => {
  let validate: ValidateFunction;

  beforeAll(async () => {
    const raw = await readFile(SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(raw) as Record<string, unknown>;
    // `strictRequired: false` allows the data/dataFile mutual-exclusion in
    // `jsonTask` to express itself via `required` inside `oneOf` subschemas
    // that do not redeclare `properties`. Every other strict-mode check stays
    // on. `format: uri` is registered as a no-op so strict mode does not
    // reject the schema for an unknown format; semantic URI validation is
    // left to editors and CLI validators that ship ajv-formats.
    const ajv = new Ajv({
      strict: true,
      strictRequired: false,
      allErrors: true,
    });
    ajv.addFormat('uri', true);
    validate = ajv.compile(schema);
  });

  it('compiles cleanly', () => {
    expect(validate).toBeTypeOf('function');
  });

  describe('example configs', () => {
    it.each(exampleFiles)('%s validates', async name => {
      const raw = await readFile(join(EXAMPLES_DIR, name), 'utf-8');
      const data = JSON.parse(raw) as unknown;
      const ok = validate(data);
      if (!ok) {
        const errors = (validate.errors ?? [])
          .map(e => `  ${e.instancePath} ${e.message}`)
          .join('\n');
        throw new Error(`Schema validation failed for ${name}:\n${errors}`);
      }
      expect(ok).toBe(true);
    });
  });

  describe('positive cases', () => {
    const cases: ReadonlyArray<[string, unknown]> = [
      [
        'minimal per-file',
        {
          name: 'min',
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'src/**/*.ts', promptTemplate: 'Review {{file}}' },
          ],
        },
      ],
      [
        'top-level concurrency',
        {
          name: 'concurrent',
          concurrency: 4,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
      [
        'bugzilla with change clause',
        {
          name: 'change',
          agent: 'claude-sdk',
          promptGenerator: [
            'bugzilla',
            {
              search: {
                change: {
                  field: 'bug_status',
                  from: '2025-01-15',
                  to: '2025-02-15',
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'Review {{id}}',
            },
          ],
        },
      ],
      [
        'batch wrapping a bugzilla source',
        {
          name: 'batch',
          agent: ['claude-sdk', { maxTurns: 20 }],
          promptGenerator: [
            'batch',
            {
              source: [
                'bugzilla',
                {
                  search: { product: 'Core' },
                  promptTemplate: 'Review {{id}}',
                },
              ],
              summaryPromptTemplate: 'Read {{reportFile}}',
              reportFile: 'out/report.yaml',
            },
          ],
        },
      ],
      [
        'openai-sdk bare agent',
        {
          name: 'openai',
          agent: 'openai-sdk',
          promptGenerator: ['test', { prompts: ['noop'] }],
        },
      ],
      [
        'openai-sdk configured agent',
        {
          name: 'openai',
          agent: [
            'openai-sdk',
            {
              model: 'gpt-5.5',
              modelSettings: { temperature: 0 },
              maxTurns: 20,
              systemPrompt: 'Use concise output.',
              outputSchema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
              },
            },
          ],
          promptGenerator: ['test', { prompts: ['noop'] }],
        },
      ],
      [
        'github issue search',
        {
          name: 'github',
          agent: 'claude-sdk',
          promptGenerator: [
            'github',
            {
              search: {
                repository: 'octocat/Hello-World',
                query: 'is:open label:bug',
                sort: 'updated',
                order: 'desc',
                maxResults: 25,
              },
              promptTemplate: 'Review {{id}}: {{title}}',
            },
          ],
        },
      ],
      [
        'gitlab issue search',
        {
          name: 'gitlab',
          agent: 'claude-sdk',
          promptGenerator: [
            'gitlab',
            {
              search: {
                project: 'gitlab-org/gitlab',
                state: 'opened',
                labels: ['bug'],
                orderBy: 'updated_at',
                sort: 'desc',
                maxResults: 25,
              },
              promptTemplate: 'Review {{id}}: {{title}}',
            },
          ],
        },
      ],
      [
        'test prompts',
        {
          name: 'test',
          agent: 'claude-sdk',
          promptGenerator: [
            'test',
            {
              prompts: ['First prompt', 'Second prompt'],
            },
          ],
        },
      ],
      [
        'test agent with cycling responses',
        {
          name: 'test',
          agent: [
            'test',
            {
              responses: [{ status: 'success', output: 'dry run' }],
              repeat: 'cycle',
            },
          ],
          promptGenerator: ['test', { prompts: ['a', 'b'] }],
        },
      ],
      [
        'test agent with mixed response statuses and default repeat',
        {
          name: 'test',
          agent: [
            'test',
            {
              responses: [
                { status: 'success', output: 'ok' },
                { status: 'glitch', reason: 'rate limit' },
                { status: 'error', reason: 'bad prompt' },
              ],
            },
          ],
          promptGenerator: ['test', { prompts: ['only'] }],
        },
      ],
      [
        'openai-sdk with prices and a top-level maxBudgetUsd',
        {
          name: 'cost',
          maxBudgetUsd: 5,
          agent: [
            'openai-sdk',
            {
              prices: {
                'gpt-5-mini': { inputPerMtok: 0.25, outputPerMtok: 2 },
              },
            },
          ],
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
    ];

    it.each(cases)('%s validates', (_label, data) => {
      expect(validate(data)).toBe(true);
    });
  });

  describe('negative cases', () => {
    const cases: ReadonlyArray<[string, unknown]> = [
      [
        'rejects missing name',
        {
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
      [
        'rejects a zero concurrency',
        {
          name: 'concurrent',
          concurrency: 0,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
      [
        'rejects a negative concurrency',
        {
          name: 'concurrent',
          concurrency: -1,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
      [
        'rejects unknown bugStatus value',
        {
          name: 'x',
          agent: 'claude-sdk',
          promptGenerator: [
            'bugzilla',
            { search: { bugStatus: ['BANANA'] }, promptTemplate: 'y' },
          ],
        },
      ],
      [
        'rejects change.from with a non yyyy-MM-dd value',
        {
          name: 'x',
          agent: 'claude-sdk',
          promptGenerator: [
            'bugzilla',
            {
              search: {
                change: {
                  field: 'bug_status',
                  from: '2025-01-15T08:00:00',
                  to: '2025-02-15',
                  value: 'RESOLVED',
                },
              },
              promptTemplate: 'y',
            },
          ],
        },
      ],
      [
        'rejects github search without repository',
        {
          name: 'x',
          agent: 'claude-sdk',
          promptGenerator: [
            'github',
            {
              search: { query: 'is:open' },
              promptTemplate: 'y',
            },
          ],
        },
      ],
      [
        'rejects unknown top-level property',
        {
          name: 'x',
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
          notARealField: true,
        },
      ],
      [
        'rejects malformed test prompts',
        {
          name: 'x',
          agent: 'claude-sdk',
          promptGenerator: [
            'test',
            {
              prompts: ['First prompt', 42],
            },
          ],
        },
      ],
      [
        'rejects bare "test" agent (test-only utility)',
        {
          name: 'x',
          agent: 'test',
          promptGenerator: [
            'test',
            {
              prompts: ['First prompt'],
            },
          ],
        },
      ],
      [
        'rejects test agent without a responses array',
        {
          name: 'x',
          agent: ['test', { repeat: 'cycle' }],
          promptGenerator: ['test', { prompts: ['only'] }],
        },
      ],
      [
        'rejects test agent with an unknown repeat value',
        {
          name: 'x',
          agent: [
            'test',
            {
              responses: [{ status: 'success', output: 'ok' }],
              repeat: 'forever',
            },
          ],
          promptGenerator: ['test', { prompts: ['only'] }],
        },
      ],
      [
        'rejects test agent with a malformed response (success missing output)',
        {
          name: 'x',
          agent: [
            'test',
            {
              responses: [{ status: 'success' }],
            },
          ],
          promptGenerator: ['test', { prompts: ['only'] }],
        },
      ],
      [
        'rejects a price entry missing inputPerMtok',
        {
          name: 'cost',
          agent: ['openai-sdk', { prices: { m: { outputPerMtok: 2 } } }],
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
      [
        'rejects a non-positive maxBudgetUsd',
        {
          name: 'cost',
          maxBudgetUsd: 0,
          agent: 'claude-sdk',
          promptGenerator: [
            'per-file',
            { filePattern: 'x', promptTemplate: 'y' },
          ],
        },
      ],
    ];

    it.each(cases)('%s', (_label, data) => {
      expect(validate(data)).toBe(false);
    });
  });
});
