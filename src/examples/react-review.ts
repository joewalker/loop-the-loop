import { agenticLoop } from 'agentic-loop';

const promptTemplate = `Review the file {{file}} for React best practices.

- Use the vercel-react-best-practices skill to help with what advice to give

Output each issue in its own paragraph beginning with a severity rating, followed by a ':', then a description of the problem
The severity ratings are:

- P1: A bug that will lose or corrupt data or enable unauthorized access
- P2: Bugs that are annoying; e.g. cause rendering issues or crash react
- P3: Visual bugs, performance issues
- P4: Long term maintenance issues, etc

If you find no issues, say so briefly.`;

async function _main(): Promise<void> {
  await agenticLoop({
    name: 'react-review',
    agent: 'codex-cli', // or 'claude-sdk'
    promptGenerator: [
      'per-file',
      {
        filePattern: 'web/backdrop/src/**/*.tsx',
        excludePatterns: ['**/__test__/**'],
        promptTemplate,
      },
    ],
    maxTurns: 5,
  });
}
