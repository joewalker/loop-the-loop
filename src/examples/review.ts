import { loadEnvFile } from 'node:process';

import { loop } from 'loop-the-loop';

loadEnvFile();

await loop({
  name: 'review',
  agent: 'codex-cli', // or 'claude-sdk'
  promptGenerator: [
    'per-file',
    {
      filePattern: 'src/**/*.ts',
      excludePatterns: ['**/__test__/**'],
      promptTemplate: [
        'Review {{file}} for bugs, security issues, and maintainability problems.',
        'Take care to understand the full context of the codebase before reporting.',
        'Report findings as a short list. Do not modify the file.',
      ].join('\n\n'),
    },
  ],
  maxPrompts: 5,
}).catch(console.error);
