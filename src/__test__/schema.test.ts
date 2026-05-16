import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Ajv, type ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';

const SCHEMA_PATH = join(
  import.meta.dirname,
  '../../schema/loop-the-loop.schema.json',
);
const EXAMPLES_DIR = join(import.meta.dirname, '../examples');

const exampleFiles = readdirSync(EXAMPLES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

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
        'bugzilla with change clause',
        {
          name: 'change',
          agent: 'test',
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
        'github issue search',
        {
          name: 'github',
          agent: 'test',
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
          agent: 'test',
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
          agent: 'test',
          promptGenerator: [
            'test',
            {
              prompts: ['First prompt', 'Second prompt'],
            },
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
          agent: 'test',
          promptGenerator: [
            'test',
            {
              prompts: ['First prompt', 42],
            },
          ],
        },
      ],
    ];

    it.each(cases)('%s', (_label, data) => {
      expect(validate(data)).toBe(false);
    });
  });
});
