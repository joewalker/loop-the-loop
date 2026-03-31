import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const INCLUDE_PATTERN = /\{\{include:([^}]+)\}\}/g;

/**
 * Expand a prompt template by first resolving all `{{include:...}}` macros
 * (via {@link expandIncludes}), then substituting each entry in `variables`
 * as a `{{key}}` placeholder. This is the standard two-step expansion used
 * by all prompt generators.
 *
 * @param template - The raw template string.
 * @param basePath - Directory used to resolve relative `{{include:...}}` paths.
 * @param variables - Map of placeholder names to their replacement values.
 *   A key `"file"` will replace every occurrence of `{{file}}` in the template.
 */
export async function expandPrompt(
  template: string,
  basePath: string,
  variables: Readonly<Record<string, string>>,
): Promise<string> {
  let result = await expandIncludes(template, basePath);

  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  return result;
}

/**
 * Expand all `{{include:path}}` macros in `text`, replacing each with the
 * contents of the referenced file. Relative paths are resolved against
 * `basePath`. Expansion is recursive: included files may themselves contain
 * `{{include:...}}` macros, which are resolved relative to the included
 * file's directory.
 *
 * @param text - The text containing zero or more `{{include:...}}` macros.
 * @param basePath - The directory used to resolve relative paths in `text`.
 * @param visited - Internal set of already-expanded absolute paths, used to
 *   detect circular includes.
 */
export async function expandIncludes(
  text: string,
  basePath: string,
  visited: ReadonlySet<string> = new Set(),
): Promise<string> {
  const matches = [...text.matchAll(INCLUDE_PATTERN)];
  if (matches.length === 0) {
    return text;
  }

  // Resolve all include paths and read file contents up front so we can
  // replace them sequentially without re-scanning the original string.
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const macro = match[0];
    if (replacements.has(macro)) {
      continue; // same macro may appear multiple times; only resolve once
    }

    const rawPath = match[1].trim();
    const resolvedPath = isAbsolute(rawPath)
      ? rawPath
      : resolve(basePath, rawPath);

    if (visited.has(resolvedPath)) {
      throw new Error(
        `Circular include detected: ${resolvedPath} is already being expanded`,
      );
    }

    const content = await readFile(resolvedPath, 'utf-8');
    const nextVisited = new Set(visited).add(resolvedPath);
    const expanded = await expandIncludes(
      content,
      dirname(resolvedPath),
      nextVisited,
    );
    replacements.set(macro, expanded);
  }

  // Replace each macro using a function to avoid special-character
  // interpretation of `$` in the replacement string.
  return text.replaceAll(
    INCLUDE_PATTERN,
    fullMatch => replacements.get(fullMatch) ?? fullMatch,
  );
}
