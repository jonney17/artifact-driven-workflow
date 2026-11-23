import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { StubRunner } from '@sdlc/runtimes';
import { Engine } from '../src/engine';
import { GitWorkspace } from '../src/git';
import { LeaseManager } from '../src/lease';
import { EngineLoop } from '../src/loop';
import { EventLog } from '../src/recovery';
import { Semaphore } from '../src/semaphore';
import { ArtifactStore } from '../src/store';
import { GitWorktreeProvider, storyBranch } from '../src/worktree';
import { PROPOSAL, tempDir, testWorkflow } from './fixtures';
import { bareWithClones, git } from './git-helpers';

const exec = promisify(execFile);

describe('semaphore', () => {
  it('never runs more than its size at once', async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        s.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('git worktrees per attempt', { timeout: 30_000 }, () => {
  it('creates the story branch from the base, gives each attempt a new worktree, and reuses the pushed branch on another machine', async () => {
    const { base, bare, clones } = await bareWithClones(1, (d) => writeFile(join(d, 'app.ts'), 'v1\n'));
    const repo = clones[0]!;
    const wt = new GitWorktreeProvider({ repos: { api: { path: repo, branch: 'main' } }, root: join(base, 'wt') });
    const a1 = await wt.prepare({ instance: 'developer:PAY-1:api', story: 'PAY-1', repo: 'api', attempt: 1 });
    expect(await git(a1, 'branch', '--show-current')).toBe(storyBranch('PAY-1', 'api'));
    await writeFile(join(a1, 'app.ts'), 'v2\n');
    await writeFile(join(a1, 'new.ts'), 'x\n');
    expect(await wt.changedFiles(a1, 'main')).toEqual(['app.ts', 'new.ts']);
    await git(a1, 'add', '-A');
    await git(a1, 'commit', '--quiet', '-m', 'wip');
    await git(a1, 'push', '--quiet', 'origin', 'PAY-1/api');

    const a2 = await wt.prepare({ instance: 'developer:PAY-1:api', story: 'PAY-1', repo: 'api', attempt: 2 });
    expect(a2).not.toBe(a1);
    expect(existsSync(a1)).toBe(false);
    expect(await readFile(join(a2, 'app.ts'), 'utf8')).toBe('v2\n');

    // another machine (handover): no local branch, but the pushed one exists
    const other = join(base, 'other');
    await exec('git', ['clone', '--quiet', '-c', 'core.autocrlf=false', bare, other]);
    const wt2 = new GitWorktreeProvider({ repos: { api: { path: other, branch: 'main' } }, root: join(base, 'wt2') });
    const b1 = await wt2.prepare({ instance: 'developer:PAY-1:api', story: 'PAY-1', repo: 'api', attempt: 3 });
    expect(await readFile(join(b1, 'new.ts'), 'utf8')).toBe('x\n');
  });

  it('gives story-level instances an empty scratch dir', async () => {
    const wt = new GitWorktreeProvider({ repos: {}, root: await tempDir() });
    expect(existsSync(await wt.prepare({ instance: 'planner:PAY-1', story: 'PAY-1', attempt: 1 }))).toBe(true);
  });
});

describe('engine loop over the workspace repo', { timeout: 60_000 }, () => {
  function engineFor(dir: string, n: number, assigned: () => { key: string; repos: string[] }[]) {
    const ws = new GitWorkspace(dir);
    const root = join(dir, '.sdlc/work');
    const runner = new StubRunner().on('planner', (_r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'proposal', body: PROPOSAL }], changedFiles: [] }));
    const store = new ArtifactStore(root);
    const engine = new Engine({ store, events: new EventLog(root), runner, workflow: testWorkflow() });
    const leases = new LeaseManager(ws, { user: `dev${n}`, host: `h${n}`, engine_id: `e${n}` }, 30);
    const loop = new EngineLoop({
      ws,
      leases,
      engine,
      hooks: {
        assigned: async () => assigned(),
        syncIn: async (s) => {
          await store.write({ id: `story-${s.key}`, type: 'story', status: 'ready', produced_by: 'engine', story: s.key, body: `story ${s.key}` });
        },
      },
    });
    return { loop, runner };
  }

  it('claims, ticks and pushes owned stories; skips stories leased elsewhere; releases on reassignment', async () => {
    const { clones } = await bareWithClones(2);
    let aStories = [
      { key: 'PAY-1', repos: [] },
      { key: 'PAY-2', repos: [] },
    ];
    const A = engineFor(clones[0]!, 1, () => aStories);
    const B = engineFor(clones[1]!, 2, () => [{ key: 'PAY-2', repos: [] }]);

    const r1 = await A.loop.once();
    expect(r1.owned).toEqual(['PAY-1', 'PAY-2']);
    expect(r1.pushed).toBe('ok');
    expect(r1.ticks['PAY-1']?.dispatched[0]?.instance).toBe('planner:PAY-1');

    const r2 = await B.loop.once();
    expect(r2.owned).toEqual([]);
    expect(r2.skipped).toEqual([{ key: 'PAY-2', reason: 'lease held by another engine' }]);
    expect(existsSync(join(clones[1]!, '.sdlc/work/stories/PAY-1/artifacts/proposal-PAY-1.md'))).toBe(true);

    aStories = [{ key: 'PAY-1', repos: [] }]; // PAY-2 reassigned to B in Jira
    expect((await A.loop.once()).released).toEqual(['PAY-2']);
    const r4 = await B.loop.once();
    expect(r4.owned).toEqual(['PAY-2']);
    expect(r4.ticks['PAY-2']?.dispatched).toEqual([]); // A already produced the proposal: nothing to redo
  });
});
