import { loop } from 'loop-the-loop';

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
still relevant or whether it should be closed. Use the tools available to
gather evidence before producing a verdict; do not rely on the bug summary
alone.

Suggested investigation steps:
- Fetch the bug page at {{url}} with WebFetch to read the full description,
  comments, dependencies, and duplicate links.
- Use WebSearch to look for related bugs, mailing-list threads, or release
  notes that may indicate the underlying issue has been fixed.
- Check developer.mozilla.org via WebFetch to confirm whether the feature or
  API the bug describes is still supported, deprecated, or removed.

Consider the following:
- Has the area of code this bug relates to been significantly refactored or removed?
- Is the described behavior still reproducible in modern Firefox?
- Has a duplicate or related bug already fixed the underlying issue?
- Is the bug about a feature or API that has been deprecated or replaced?

If the available tools are insufficient to answer with confidence, return a
LOW-confidence verdict and explain what evidence was missing rather than
guessing from training-data recall.

Produce a short assessment with the following structure:

VERDICT: one of KEEP_OPEN, CLOSE, or NEEDS_INFO
CONFIDENCE: HIGH, MEDIUM, or LOW
REASON: A one-paragraph explanation of your reasoning, citing the evidence you
gathered (or noting that you could not gather any).`;

await loop({
  name: 'dom-workers-retriage',
  agent: [
    'claude-sdk',
    {
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'WebFetch(domain:bugzilla.mozilla.org)',
        'WebFetch(domain:bugs.chromium.org)',
        'WebFetch(domain:developer.mozilla.org)',
        'WebFetch(domain:hg.mozilla.org)',
        'WebFetch(domain:searchfox.org)',
        'WebSearch',
      ],
    },
  ],
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
  maxPrompts: 50,
});
