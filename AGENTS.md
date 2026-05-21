# Loop the Loop Development Guide

## Getting Started

Simply run the following commands from a clean checkout:

```sh
pnpm install
pnpm tsc
```

At this point we should be able to run tests (`pnpm test`). Do not add `| tail -XX` to the end of test commands - vitest recognises agents and uses a minimal reporter and the pipe may mean a user permissions request.

Other useful commands:

- Lint code: `pnpm lint`
- Run specific test: `pnpm test path/to/file.test.ts`
- Update snapshots: `pnpm test -u`
- Check test coverage: `pnpm test --coverage`
- Format code: `pnpm format`

Don't use `npm` (or `npx`). Use `pnpm` or `pnpx` instead.

## Writing Documentation

When writing reports, documents, technical explanations, analyses, or any long-form content:

- Use standard paragraph breaks for organization and reserve markdown primarily for `inline code`, fenced code blocks (\`\`\`), and simple headings (##, and ###).
- Avoid using **bold** and _italics_ particularly in headings.
- Avoid em dashes, smart quotes, non-breaking spaces, zero-width spaces, and similar non-ASCII punctuation in all output including code comments, documentation, and prose.

## Bug Tracking

Bugs are tracked as issues in this [project's Github repository](https://github.com/joewalker/loop-the-loop/issues). Use the `gh` CLI tool to create, list, and view issues from the terminal. See [`docs/bug-tracking.md`](docs/bug-tracking.md) for the S1 to S4 severity definitions we use when classifying bugs.

## Writing Code

- Run the tests before writing code to check we start clean
- Write tests first. Use Red/Green TDD
- Arrays: prefer `Array<Type>` over `Type[]`
- Use `readonly` and `ReadonlyArray<…>` unless the data is designed to be mutable
- Prefix unused variables with underscore (\_varName)
- Always use curly brackets for `if`, `else`, `for`, etc, even when the body fits on one line.
- Prefer nullish coalescing (??) and optional chaining (?.)
- Prefer using the EcmaScript standard `#` to denote private members rather than the TypeScript specific `private` keyword (except for constructors since standard EcmaScript doesn't allow the `#constructor` construct).
- Top level functions should have at least some basic documentation.
- When using multi-line doc comments (i.e. /\*\* ... \*/), ALWAYS to use multiple lines rather than squishing everything onto one line.
- Use `// #region ...` markers to divide file sections, never ASCII art lines like `// -----------`.
- Imports:
  - Sorted via oxfmt (configured in `.oxfmtrc.json`)
  - Importing files from another package in this project - use an absolute path and omit the file extension
  - Importing files from the same package - use a relative path (beginning "./" or "../") and end with ".js"
  - Test files should always use absolute paths without file extensions even when importing from the same package
- If you want to create temporary files or scripts, ALWAYS write them to `cache/tmp/…`. NEVER use `/tmp/…` or `/private/tmp/…`
- Ask the user for anything that mutates packages: `pnpm install`, `pnpm add`, `pnpm remove`, `pnpm update`, `pnpm patch`. The user manages the dependency list.
- Never bypass pnpm safety prompts with `CI=true`, `--force`, or `confirmModulesPurge=false`. Those exist to prevent silent destruction of `node_modules`.
- Never edit files in a `node_modules` folder without explicit permission from the user.
- If pnpm responds to a command with `[ERR_PNPM_VERIFY_DEPS_BEFORE_RUN] Cannot check whether dependencies are outdated`, ALWAYS tell the user what happened and ask for help.
- The JSON Schema at `schema/loop-the-loop.schema.json` documents the shape of `LoopCliConfig` and the task types accepted by the prompt generators. When you add, remove, or rename any field that is loadable from a CLI JSON config (the top-level `LoopCliConfig`, agent or generator task types, search parameters, and so on), update the schema in the same change so it stays in step with the runtime types.
- Maintain 100% test coverage. If the `/coverage-to-100` skill is available, that can help adding missing tests and ignores.

## Completing Work

- If you have changed any code, before finishing:
  - Check tests pass `pnpm tsc && pnpm test`
  - Check with lint and fix any linting errors `pnpm lint`
  - Run oxfmt `pnpm format`
- Never alter git (this includes altering the index, e.g. `git add`, `git mv`, `git rm`) without the users explicit request
- If the user asks, when creating a commit message, take note of recent commits (use `git log --oneline`) and the instructions about commit tags in [the README](README.md).
- When asked to commit code use the default information in `~/.gitconfig` rather than specifying an author.
- Avoid `Co-Authored-By` trailers to commit messages
