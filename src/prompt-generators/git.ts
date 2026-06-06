import { resolve } from 'node:path';

import type { CheckResult } from '../doctor.js';
import type { LoopState } from '../loop-states.js';
import type { Prompt, PromptGenerator } from '../prompt-generators.js';
import { expandPrompt } from '../util/expand-prompt.js';
import { Git } from '../util/git.js';

/**
 * Configuration for a git-commit-range-driven loop task. Describes which range
 * of commits to walk and what prompt to generate for each commit.
 */
export interface GitTask {
  /**
   * Commit range passed to git, for example "main..HEAD" or
   * "abc123..def456".
   */
  range: string;

  /**
   * Path to the git repository. Relative paths resolve against `basePath`
   * (the config file directory under CLI loading), which is also the default.
   */
  repoPath?: string;

  /**
   * How to construct a prompt for each commit. The following placeholders are
   * substituted:
   * - `{{hash}}` / `{{shortHash}}` - full / abbreviated commit hash
   * - `{{parents}}` / `{{shortParents}}` - parent hashes
   * - `{{refs}}` - ref-name decoration
   * - `{{subject}}` - commit subject line
   * - `{{body}}` - commit message body
   * - `{{rawBody}}` - raw subject and body
   * - `{{authorName}}` / `{{authorEmail}}` - commit author
   * - `{{committerName}}` / `{{committerEmail}}` - commit committer
   * - `{{authorDate}}` / `{{authorDateRelative}}` - author date (ISO / relative)
   * - `{{committerDate}}` - committer date (ISO)
   * - `{{signatureStatus}}` / `{{signer}}` - signature verification
   * - `{{diff}}` - the single-parent patch
   * - `{{stat}}` - the diffstat
   * - `{{files}}` - changed files with status letters
   * - `{{index}}` / `{{commitCount}}` - 1-based position / total in the range
   *
   * `{{diff}}`, `{{stat}}` and `{{files}}` are computed only when the template
   * string references them. A placeholder that appears solely inside an
   * `{{include:...}}` file is not detected.
   */
  promptTemplate: string;
}

// NUL is used to separate the metadata fields because git commit content can
// never contain a NUL byte, so it cannot collide with field values the way a
// printable or even a control character such as the unit separator could. The
// format string asks git to emit the byte via the `%x00` escape (a literal NUL
// cannot be passed in an argv argument); the output is split on the real byte.
const FIELD_SEP = '\x00';
const FIELD_SEP_FORMAT = '%x00';

/**
 * Ordered metadata fields and their git pretty-format specifiers. `body` and
 * `rawBody` are kept last because they may span multiple lines; only the very
 * last field carries git's trailing newline.
 */
const METADATA_FIELDS = [
  ['hash', '%H'],
  ['shortHash', '%h'],
  ['parents', '%P'],
  ['shortParents', '%p'],
  ['refs', '%D'],
  ['subject', '%s'],
  ['authorName', '%an'],
  ['authorEmail', '%ae'],
  ['committerName', '%cn'],
  ['committerEmail', '%ce'],
  ['authorDate', '%aI'],
  ['authorDateRelative', '%ar'],
  ['committerDate', '%cI'],
  ['signatureStatus', '%G?'],
  ['signer', '%GS'],
  ['body', '%b'],
  ['rawBody', '%B'],
] as const;

const METADATA_FORMAT = METADATA_FIELDS.map(([, fmt]) => fmt).join(
  FIELD_SEP_FORMAT,
);

/**
 * A PromptGenerator that walks a commit range and yields one prompt per
 * non-merge commit, oldest-first. The commit hash is used as the prompt id so
 * already-processed commits are skipped on resume. `basePath` resolves
 * `{{include:...}}` macros and a relative `repoPath`, defaulting to
 * `process.cwd()`. CLI config loading passes the config file's directory.
 */
export class GitPromptGenerator implements PromptGenerator {
  static readonly promptGeneratorName = 'git';

  static async create(
    task: GitTask,
    basePath?: string,
  ): Promise<PromptGenerator> {
    return new GitPromptGenerator(task, basePath);
  }

  readonly #task: GitTask;
  readonly #basePath: string;

  constructor(task: GitTask, basePath?: string) {
    this.#task = task;
    this.#basePath = basePath ?? process.cwd();
  }

  async *generate(loopState: LoopState): AsyncIterable<Prompt> {
    const git = new Git(this.#resolveRepoPath());
    const template = this.#task.promptTemplate;

    const hashes = await git.revList(this.#task.range);
    const commitCount = hashes.length;

    for (const [i, hash] of hashes.entries()) {
      if (!loopState.isOutstanding(hash)) {
        continue;
      }

      const meta = parseMetadata(await git.showMetadata(hash, METADATA_FORMAT));

      let diff = '';
      let stat = '';
      let files = '';
      if (template.includes('{{diff}}')) {
        diff = stripLeadingNewlines(await git.showPatch(hash));
      }
      if (template.includes('{{stat}}')) {
        stat = stripLeadingNewlines(await git.showStat(hash));
      }
      if (template.includes('{{files}}')) {
        files = stripLeadingNewlines(await git.showNameStatus(hash));
      }

      const variables = buildVariables(meta, {
        index: String(i + 1),
        commitCount: String(commitCount),
        diff,
        stat,
        files,
      });
      const prompt = await expandPrompt(template, this.#basePath, variables);

      yield { id: hash, prompt };
    }
  }

  /**
   * Preflight probe used by `--doctor`: confirm the repo path is a git work
   * tree and that the configured range resolves.
   */
  async *check(): AsyncIterable<CheckResult> {
    const repoPath = this.#resolveRepoPath();
    const git = new Git(repoPath);

    if (!(await git.isInsideWorkTree())) {
      yield {
        name: 'git repo',
        status: 'fail',
        message: `${repoPath} is not a git work tree`,
      };
      return;
    }

    try {
      const hashes = await git.revList(this.#task.range);
      yield {
        name: 'range resolves',
        status: hashes.length > 0 ? 'ok' : 'warn',
        message: `${hashes.length} ${hashes.length === 1 ? 'commit' : 'commits'}`,
      };
    } catch (err) {
      yield {
        name: 'range resolves',
        status: 'fail',
        message:
          err instanceof Error
            ? err.message
            : /* istanbul ignore next */ String(err),
        cause: err,
      };
    }
  }

  /**
   * Resolve the configured repo path against `basePath`, defaulting to the
   * base path itself when `repoPath` is omitted.
   */
  #resolveRepoPath(): string {
    return resolve(this.#basePath, this.#task.repoPath ?? '.');
  }
}

/**
 * Parse delimiter-separated `git show` metadata output into a record keyed by
 * the field names in `METADATA_FIELDS`.
 */
function parseMetadata(out: string): Record<string, string> {
  const parts = out.replace(/\n$/, '').split(FIELD_SEP);
  const result: Record<string, string> = {};
  METADATA_FIELDS.forEach(([name], i) => {
    const value = parts[i];
    // istanbul ignore next
    result[name] = value !== undefined ? value : '';
  });
  return result;
}

/**
 * Build the prompt template variables for a commit. Multi-line content fields
 * (subject, stat, files, diff, body, rawBody) are inserted last so that any
 * placeholder-looking text inside them is not re-substituted.
 */
function buildVariables(
  meta: Record<string, string>,
  extra: {
    readonly index: string;
    readonly commitCount: string;
    readonly diff: string;
    readonly stat: string;
    readonly files: string;
  },
): Record<string, string> {
  return {
    hash: meta['hash'],
    shortHash: meta['shortHash'],
    parents: meta['parents'],
    shortParents: meta['shortParents'],
    refs: meta['refs'],
    authorName: meta['authorName'],
    authorEmail: meta['authorEmail'],
    committerName: meta['committerName'],
    committerEmail: meta['committerEmail'],
    authorDate: meta['authorDate'],
    authorDateRelative: meta['authorDateRelative'],
    committerDate: meta['committerDate'],
    signatureStatus: meta['signatureStatus'],
    signer: meta['signer'],
    index: extra.index,
    commitCount: extra.commitCount,
    subject: meta['subject'],
    stat: extra.stat,
    files: extra.files,
    diff: extra.diff,
    body: meta['body'],
    rawBody: meta['rawBody'],
  };
}

/**
 * Strip the leading blank line(s) that `git show --format=` emits before the
 * patch/stat/name-status body.
 */
function stripLeadingNewlines(text: string): string {
  return text.replace(/^\n+/, '');
}
