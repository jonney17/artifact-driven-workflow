import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeProvider } from './engine';

const exec = promisify(execFile);

export interface GitWorktreeOptions {
  /** Repo name → local clone path and base branch (from `team.yaml` `repos`). */
  repos: Record<string, { path: string; branch: string }>;
  /** Where attempt worktrees are created, e.g. `~/.sdlc/worktrees/<team>`. */
  root: string;
  remote?: string;
}

/** Story branch name for a repo (plan §3a): `<KEY>/<repo>`. */
export const storyBranch = (story: string, repo: string) => `${story}/${repo}`;

/**
 * A fresh git worktree per attempt (plan §2). Repo-scoped instances get a worktree on the story branch
 * `<KEY>/<repo>`: the local branch if it exists, otherwise the pushed one (recovery after a restart or a
 * handover), otherwise a new branch from the base. The previous attempt's worktree is removed first,
 * because git checks a branch out in only one worktree. Story-level instances get an empty scratch dir.
 */
export class GitWorktreeProvider implements WorktreeProvider {
  constructor(private readonly o: GitWorktreeOptions) {}

  private dir(instance: string, attempt: number): string {
    return resolve(this.o.root, instance.replace(/:/g, '_'), `a${attempt}`);
  }

  async prepare({ instance, story, repo, attempt }: { instance: string; story: string; repo?: string; attempt: number }): Promise<string> {
    const dir = this.dir(instance, attempt);
    if (!repo) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      return dir;
    }
    const cfg = this.o.repos[repo];
    if (!cfg) throw new Error(`repo ${repo} is not configured in team.yaml`);
    const remote = this.o.remote ?? 'origin';
    const git = (...args: string[]) => exec('git', args, { cwd: cfg.path, windowsHide: true }).then((r) => r.stdout.trim());

    await git('worktree', 'prune');
    for (let a = 1; a <= attempt; a++) {
      const old = this.dir(instance, a);
      await git('worktree', 'remove', '--force', old).catch(() => rm(old, { recursive: true, force: true }));
    }
    await git('fetch', '--quiet', remote).catch(() => undefined); // offline is fine: use what we have
    const branch = storyBranch(story, repo);
    const exists = async (ref: string) => git('rev-parse', '--verify', '--quiet', ref).then(() => true, () => false);

    await mkdir(join(dir, '..'), { recursive: true });
    if (await exists(`refs/heads/${branch}`)) {
      await git('worktree', 'add', '--quiet', dir, branch);
    } else if (await exists(`refs/remotes/${remote}/${branch}`)) {
      await git('worktree', 'add', '--quiet', '-b', branch, dir, `${remote}/${branch}`);
    } else {
      const base = (await exists(`refs/remotes/${remote}/${cfg.branch}`)) ? `${remote}/${cfg.branch}` : cfg.branch;
      await git('worktree', 'add', '--quiet', '-b', branch, dir, base);
    }
    return dir;
  }

  /** Files changed in an attempt's worktree relative to where the story branch started (for the write-scope check). */
  async changedFiles(worktree: string, base: string): Promise<string[]> {
    const run = (...args: string[]) => exec('git', args, { cwd: worktree, windowsHide: true }).then((r) => r.stdout);
    const committed = await run('diff', '--name-only', `${base}...HEAD`);
    const working = await run('status', '--porcelain', '--untracked-files=all');
    const files = new Set(committed.split('\n').filter(Boolean));
    for (const line of working.split('\n').filter(Boolean)) files.add(line.slice(3).replace(/^.* -> /, ''));
    return [...files].sort();
  }
}
