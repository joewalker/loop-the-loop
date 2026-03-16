import { agenticLoop } from 'agentic-loop';

/**
 * Two years ago from today, used to filter for old bugs.
 */
const twoYearsAgo = new Date();
twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

const promptTemplate = `You are re-triaging an old bug in Mozilla's Bugzilla.

Bug {{id}}: {{summary}}
Component: {{component}}
Product: {{product}}
Severity: {{severity}}
Status: {{status}}
Assignee: {{assignee}}
URL: {{url}}

This bug has been open for over two years. Your job is to assess whether it is
still relevant or whether it should be closed.

Consider the following:
- Has the area of code this bug relates to been significantly refactored or removed?
- Is the described behavior still reproducible in modern Firefox?
- Has a duplicate or related bug already fixed the underlying issue?
- Is the bug about a feature or API that has been deprecated or replaced?

Produce a short assessment with the following structure:

VERDICT: one of KEEP_OPEN, CLOSE, or NEEDS_INFO
CONFIDENCE: HIGH, MEDIUM, or LOW
REASON: A one-paragraph explanation of your reasoning.`;

agenticLoop({
  name: 'dom-workers-retriage',
  agent: 'claude-sdk',
  promptGenerator: [
    'bugzilla',
    {
      search: {
        product: 'Core',
        components: ['DOM: Workers'],
        bugStatus: ['NEW', 'ASSIGNED', 'REOPENED', 'UNCONFIRMED'],
        advanced: [
          {
            field: 'creation_ts',
            matchType: 'lessthan',
            value: twoYearsAgo.toISOString().slice(0, 10),
          },
        ],
      },
      promptTemplate,
    },
  ],
  maxTurns: 50,
}).catch(console.error);
