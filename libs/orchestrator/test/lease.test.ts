import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { GitWorkspace } from '../src/git';
import { LeaseManager } from '../src/lease';
import { tempDir } from './fixtures';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, windowsHide: true });

/** A bare "GitLab" workspace repo and n clones, one per engine. */
async function workspaceRepo(n: number): Promise<string[]> {
  const base = await tempDir('sdlc-git-');
  const bare = join(base, 'workspace.git');
  await exec('git', ['init', '--bare', '--quiet', '-b', 'main', bare]);
  const clones: string[] = [];
  for (let i = 0; i < n; i++) {
    const dir = join(base, `engine-${i}`);
    await exec('git', ['clone', '--quiet', bare, dir]);
    await git(dir, 'config', 'user.email', `engine${i}@test`);
    await git(dir, 'config', 'user.name', `engine${i}`);
    await git(dir, 'config', 'core.autocrlf', 'false');
    if (i === 0) {
      await git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'init');
      await git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
    } else {
      await git(dir, 'pull', '--quiet', 'origin', 'main');
    }
    clones.push(dir);
  }
  return clones;
}

const id = (n: number) => ({ user: `dev${n}`, host: `host${n}`, engine_id: `engine-${n}` });

describe('story lease over the workspace repo', { timeout: 30_000 }, () => {
  it('one engine claims; another engine cannot while the lease is fresh, but can after the TTL', async () => {
    const [a, b] = await workspaceRepo(2);
    let now = new Date('2026-11-23T10:00:00Z');
    const A = new LeaseManager(new GitWorkspace(a!), id(1), 30, '.sdlc/work', () => now);
    const B = new LeaseManager(new GitWorkspace(b!), id(2), 30, '.sdlc/work', () => now);
    expect(await A.claimStory('PAY-1')).toBe(true);
    expect(await B.claimStory('PAY-1')).toBe(false);
    expect(await A.claimStory('PAY-1')).toBe(true); // renew
    now = new Date('2026-11-23T10:31:00Z');
    expect(await B.claimStory('PAY-1')).toBe(true);
    expect(await A.claimStory('PAY-1')).toBe(false);
  });

  it('two engines racing for the same free story: exactly one wins (push as compare-and-swap)', async () => {
    const [a, b] = await workspaceRepo(2);
    const wsB = new GitWorkspace(b!);
    const A = new LeaseManager(new GitWorkspace(a!), id(1), 30);
    // B read the repo before A pushed: skip B's pull once to simulate the race
    const realPull = wsB.pull.bind(wsB);
    let skipped = false;
    wsB.pull = async () => {
      if (!skipped) {
        skipped = true;
        return;
      }
      return realPull();
    };
    const B = new LeaseManager(wsB, id(2), 30);
    expect(await A.claimStory('PAY-1')).toBe(true);
    expect(await B.claimStory('PAY-1')).toBe(false);
    await realPull();
    expect((await B.read(B.storyLeasePath('PAY-1')))?.engine_id).toBe('engine-1');
  });

  it('engines writing different stories never block each other', async () => {
    const [a, b] = await workspaceRepo(2);
    const wsB = new GitWorkspace(b!);
    const A = new LeaseManager(new GitWorkspace(a!), id(1), 30);
    const B = new LeaseManager(wsB, id(2), 30);
    const realPull = wsB.pull.bind(wsB);
    let skipped = false;
    wsB.pull = async () => (skipped ? realPull() : void (skipped = true));
    expect(await A.claimStory('PAY-1')).toBe(true);
    expect(await B.claimStory('PAY-2')).toBe(true); // push rejected once, rebased, pushed
    expect(await B.releaseStory('PAY-2')).toBe(true);
    expect(await B.releaseStory('PAY-1')).toBe(false); // not B's
  });

  it('team leases (e.g. preprod) serialize engines the same way', async () => {
    const [a, b] = await workspaceRepo(2);
    const A = new LeaseManager(new GitWorkspace(a!), id(1), 30);
    const B = new LeaseManager(new GitWorkspace(b!), id(2), 30);
    expect(await A.acquire(A.teamLeasePath('preprod'))).toBe(true);
    expect(await B.acquire(B.teamLeasePath('preprod'))).toBe(false);
    expect(await A.release(A.teamLeasePath('preprod'))).toBe(true);
    expect(await B.acquire(B.teamLeasePath('preprod'))).toBe(true);
  });
});
