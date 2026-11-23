import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type PushOutcome = 'ok' | 'conflict';

/**
 * The workspace repo clone (`<team>-sdlc-workspace`). Every engine commits only its own paths, so a
 * rejected push is retried after a rebase; a rebase conflict means another engine wrote the same file,
 * which is how a lease race is lost (plan §2: `git push` as compare-and-swap).
 */
export class GitWorkspace {
  constructor(
    readonly dir: string,
    readonly remote = 'origin',
    readonly branch = 'main',
    private readonly maxPushRetries = 3,
  ) {}

  async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, { cwd: this.dir, windowsHide: true });
    return stdout.trim();
  }

  async pull(): Promise<void> {
    await this.git('pull', '--rebase', '--quiet', this.remote, this.branch);
  }

  /** Commits the given paths (adds, edits and deletions) and pushes. Returns 'conflict' if another engine changed the same files. */
  async commitAndPush(message: string, paths: string[]): Promise<PushOutcome> {
    // a path that is neither on disk nor tracked (e.g. a story with no retro yet) is skipped
    for (const p of paths) await this.git('add', '--all', '--', p).catch(() => undefined);
    const staged = await this.git('diff', '--cached', '--name-only');
    if (staged) await this.git('commit', '--quiet', '-m', message);
    for (let i = 0; i <= this.maxPushRetries; i++) {
      try {
        await this.git('push', '--quiet', this.remote, `HEAD:${this.branch}`);
        return 'ok';
      } catch {
        try {
          await this.git('pull', '--rebase', '--quiet', this.remote, this.branch);
        } catch {
          await this.git('rebase', '--abort').catch(() => undefined);
          await this.git('reset', '--hard', '--quiet', `${this.remote}/${this.branch}`);
          return 'conflict';
        }
      }
    }
    await this.git('reset', '--hard', '--quiet', `${this.remote}/${this.branch}`);
    return 'conflict';
  }
}
