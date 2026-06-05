import type { Git } from './util/git.js';

/**
 * One probe in the git preflight. `ok` is false when the requirement is not
 * met; `message` carries the human-readable reason (used both as the loop's
 * thrown error and the doctor's check message).
 */
export interface GitPreflightItem {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * Shared git preflight used by both the loop runner and `--doctor`.
 *
 * Probes, in order: inside a work tree, clean working tree, committer
 * identity configured. The work-tree probe short-circuits the rest because
 * the later probes are meaningless outside a repository. Keeping this in one
 * place ensures the loop and the doctor agree on what counts as ready.
 */
export async function gitPreflight(
  git: Git,
): Promise<ReadonlyArray<GitPreflightItem>> {
  const items: Array<GitPreflightItem> = [];

  const insideWorkTree = await git.isInsideWorkTree();
  items.push(
    insideWorkTree
      ? { name: 'inside work tree', ok: true }
      : {
          name: 'inside work tree',
          ok: false,
          message:
            'Not inside a git work tree. Run from a repository when allowSourceUpdate is set.',
        },
  );
  if (!insideWorkTree) {
    return items;
  }

  const clean = await git.isClean();
  items.push(
    clean
      ? { name: 'clean working tree', ok: true }
      : {
          name: 'clean working tree',
          ok: false,
          message:
            'Working directory is not clean. Commit or stash changes before starting.',
        },
  );

  const name = await git.configValue('user.name');
  const email = await git.configValue('user.email');
  const hasIdentity = name !== undefined && email !== undefined;
  items.push(
    hasIdentity
      ? {
          name: 'committer identity',
          ok: true,
          message: `${name} <${email}>`,
        }
      : {
          name: 'committer identity',
          ok: false,
          message: 'git user.name / user.email are not configured for commits.',
        },
  );

  return items;
}
