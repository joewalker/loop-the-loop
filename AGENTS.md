# Agentic Loop Development Guide

## Getting Started

Simply run the following commands from a clean checkout:

``` sh
pnpm install
```

At this point we should be able to run tests (`pnpm test`).

Other useful commands:

- Build: `pnpm tsc`.
- Lint code: `pnpm run eslint`
- Run all vitest tests: `pnpm test`
- Run specific test: `pnpm test path/to/file.test.ts`
- Update snapshots: `pnpm test -u`

We don't use `npm` (or `npx`). Use `pnpm` or `pnpx` instead.

## Documentation Style

When writing reports, documents, technical explanations, analyses, or any long-form content:

- Write in clear, flowing prose using complete paragraphs and sentences.
- Use standard paragraph breaks for organization and reserve markdown primarily for `inline code`, code blocks (```...```), and simple headings (##, and ###).
- Avoid using **bold** and *italics* particularly in headings.
- Unless otherwise specified, write reports to new files in the `docs/wip/` folder for future reference.

## Code Style

- TypeScript: strict mode, explicit types at module boundaries
- Arrays: prefer `Array<Type>` over `Type[]`
- Strings: single quotes, template literals for interpolation
- Names: camelCase for variables/functions, PascalCase for types/components
- Errors: proper error handling with typed errors
- Formatting: 2-space indent, trailing commas, semicolons
- Use `readonly` and `ReadonlyArray<…>` unless the data is designed to be mutable
- Prefix unused variables with underscore (_varName)
- Prefer nullish coalescing (??) and optional chaining (?.)
- Prefer using the EcmaScript standard `#` to denote private members rather than the TypeScript specific `private` keyword (except for constructors since standard EcmaScript doesn't allow the `#constructor` construct).
- Top level functions should have at least some basic documentation.
- When using multi-line doc comments (i.e. /** ... */), prefer to use multiple lines rather than squishing everything onto one line.
- Imports:
  - Sorted via oxfmt (configured in `.oxfmtrc.json`)
  - Importing files from another package in this project - use an absolute path and omit the file extension
  - Importing files from the same package - use a relative path (beginning "./" or "../") and end with ".js"
  - Test files should always use absolute paths without file extensions even when importing from the same package
- Use `git log --oneline` when formatting a commit message

## Creating Commits

- Before committing you MUST:
  - Check tests pass `pnpm tsc && pnpm test`
  - Check with eslint and fix any linting errors `pnpm run eslint`
  - Run oxfmt `pnpm run oxfmt`
- ALWAYS allow the user to push commits rather than doing it yourself
