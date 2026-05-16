@AGENTS.md

## Code Intelligence

Prefer LSP over Grep/Glob/Read for code navigation:

- `workspaceSymbol` to find where a symbol is defined - use this instead of grepping for `function foo` or `class Foo`.
- `goToDefinition` / `goToImplementation` to jump to source - use this instead of grepping for the definition.
- `findReferences` to see all usages across the codebase - use this instead of grepping for call sites. Required before renaming or changing a function signature.
- `documentSymbol` to list all symbols in a file - use this instead of reading the file to find a function.
- `hover` for type info without reading the file.
- `incomingCalls` / `outgoingCalls` for call hierarchy.

Reach for text search only when LSP genuinely cannot help: comments, string literals, config values, error messages, file-name patterns. In those cases prefer `rg` over `grep` and `rg --files -g <glob>` over `find` - both are faster and respect `.gitignore`.

After writing or editing code, check LSP diagnostics before moving on. Fix any type errors or missing imports immediately.
