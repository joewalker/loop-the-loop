import type { Buffer } from 'node:buffer';
import childProcess from 'node:child_process';

/**
 * Options to commit()
 */
export interface CommitOptions {
  readonly committer?: {
    readonly name: string;
    readonly email: string;
  };
  readonly date?: number;
}

/**
 * An implementation of the Git interface that uses 'child_process'
 * (via process.js) to spawn a separate git binary.
 */
export class Git {
  #repoPath: string;

  constructor(repoPath: string) {
    this.#repoPath = repoPath;
  }

  /**
   * 'git init'
   */
  init(): Promise<string> {
    return exec('git', ['init', this.#repoPath]);
  }

  /**
   * 'git status …'
   */
  async isClean(): Promise<boolean> {
    const results = await exec('git', [
      '-C',
      this.#repoPath,
      'status',
      '--porcelain=v1',
    ]);
    return results.trim().length === 0;
  }

  /**
   * 'git rev-parse --is-inside-work-tree'
   *
   * Returns true only when the repo path is inside a git work tree. A
   * non-zero exit (no repository) is reported as false rather than thrown.
   */
  async isInsideWorkTree(): Promise<boolean> {
    try {
      const out = await exec('git', [
        '-C',
        this.#repoPath,
        'rev-parse',
        '--is-inside-work-tree',
      ]);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 'git config --get <key>'
   *
   * Returns the trimmed config value, or undefined when the key is unset
   * (git exits non-zero) or resolves to an empty string.
   */
  async configValue(key: string): Promise<string | undefined> {
    try {
      const out = await exec('git', [
        '-C',
        this.#repoPath,
        'config',
        '--get',
        key,
      ]);
      const value = out.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 'git add'
   */
  async add(...files: Array<string>): Promise<string> {
    const args = ['-C', this.#repoPath, 'add'];
    if (files.length === 0) {
      args.push('--all');
    } else {
      args.push('--', ...files);
    }
    return exec('git', args);
  }

  /**
   * 'git status, git add, git commit'
   */
  async maybeCommitAll(
    message: string,
    options?: CommitOptions,
  ): Promise<string> {
    if (await this.isClean()) {
      return '';
    }

    await this.add();
    return this.commit(message, options);
  }

  /**
   * 'git commit'
   */
  async commit(message: string, options: CommitOptions = {}): Promise<string> {
    const { committer, date } = options;
    const env = { ...process.env };

    if (message == null || message === '') {
      throw new Error('Missing message');
    }

    // prettier-ignore
    const args = [
      '-C', this.#repoPath,
      'commit', `--message=${message}`
    ];

    // istanbul ignore else
    if (committer != null) {
      args.push(`--author="${committer.name} <${committer.email}>"`);
      env['GIT_COMMITTER_NAME'] = committer.name;
      env['GIT_COMMITTER_EMAIL'] = committer.email;
    }

    if (date != null) {
      args.push(`--date=${new Date(date).toISOString()}`);
    }

    return exec('git', args, { env });
  }

  /**
   * 'git rev-list --reverse --no-merges <range>'
   *
   * Returns the non-merge commit hashes reachable in `range`, oldest-first.
   * An empty range resolves to an empty array.
   */
  async revList(range: string): Promise<Array<string>> {
    const out = await exec('git', [
      '-C',
      this.#repoPath,
      'rev-list',
      '--reverse',
      '--no-merges',
      range,
    ]);
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  /**
   * 'git show --no-patch --format=<format> <hash>'
   *
   * Returns commit metadata rendered with a pretty-format string and no diff.
   * The caller is responsible for parsing the result.
   */
  async showMetadata(hash: string, format: string): Promise<string> {
    return exec('git', [
      '-C',
      this.#repoPath,
      'show',
      '--no-patch',
      `--format=${format}`,
      hash,
    ]);
  }

  /**
   * 'git show --format= <hash>'
   *
   * Returns the single-parent patch for a commit with no metadata header. The
   * output begins with a blank line that the caller may wish to strip.
   */
  async showPatch(hash: string): Promise<string> {
    return exec('git', ['-C', this.#repoPath, 'show', '--format=', hash]);
  }

  /**
   * 'git show --stat --format= <hash>'
   *
   * Returns the diffstat for a commit with no metadata header.
   */
  async showStat(hash: string): Promise<string> {
    return exec('git', [
      '-C',
      this.#repoPath,
      'show',
      '--stat',
      '--format=',
      hash,
    ]);
  }

  /**
   * 'git show --name-status --format= <hash>'
   *
   * Returns the changed files with their status letters and no metadata header.
   */
  async showNameStatus(hash: string): Promise<string> {
    return exec('git', [
      '-C',
      this.#repoPath,
      'show',
      '--name-status',
      '--format=',
      hash,
    ]);
  }
}

/**
 * A wrapper around childProcess to return promises.
 * This is designed for cases where we're only interested in the results when
 * the command is done. i.e. no tracking of in-progress commands
 */
function exec(
  cmd: string,
  args: ReadonlyArray<string>,
  procOptions: childProcess.SpawnOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmdProcess = childProcess.spawn(cmd, args, procOptions);
    const outputs = [] as Array<string>;

    cmdProcess.stdout?.on('data', (data: Buffer): void => {
      outputs.push(String(data));
    });

    cmdProcess.stderr?.on(
      'data',
      /* istanbul ignore next */ (data: Buffer): void => {
        outputs.push(String(data));
      },
    );

    cmdProcess.on('close', (code: number): void => {
      // istanbul ignore else
      if (code === 0) {
        resolve(outputs.join(''));
      } else {
        reject(new Error(outputs.join('')));
      }
    });

    cmdProcess.on(
      'error',
      /* istanbul ignore next */ (err: unknown): void => {
        const message = [
          `git exec error: ${String(err)}`,
          `• Command: ${cmd} ${args.join(' ')}`,
          `• Proc Options: ${JSON.stringify(procOptions)}`,
        ].join('\n');
        reject(new Error(message));
      },
    );
  });
}
