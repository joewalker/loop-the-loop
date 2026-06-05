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
