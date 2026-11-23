import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tempDir } from './fixtures';

const exec = promisify(execFile);

export const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, windowsHide: true }).then((r) => r.stdout.trim());

/** A bare "remote" repo with n configured clones; the first clone seeds and pushes `main`. */
export async function bareWithClones(n: number, seed?: (dir: string) => Promise<unknown>) {
  const base = await tempDir('sdlc-git-');
  const bare = join(base, 'remote.git');
  await exec('git', ['init', '--bare', '--quiet', '-b', 'main', bare]);
  const clones: string[] = [];
  for (let i = 0; i < n; i++) {
    const dir = join(base, `clone-${i}`);
    await exec('git', ['clone', '--quiet', bare, dir]);
    await git(dir, 'config', 'user.email', `c${i}@test`);
    await git(dir, 'config', 'user.name', `c${i}`);
    await git(dir, 'config', 'core.autocrlf', 'false');
    if (i === 0) {
      await seed?.(dir);
      await git(dir, 'add', '-A');
      await git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'init');
      await git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
    } else {
      await git(dir, 'pull', '--quiet', 'origin', 'main');
    }
    clones.push(dir);
  }
  return { base, bare, clones };
}
