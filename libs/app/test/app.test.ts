import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadPack, resolveWorkflow } from '@sdlc/orchestrator';
import { runDemo, setupDemo } from '../src/demo';
import { inbox, storyView } from '../src/views';

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');

describe('example overlays (step 8: one pack, two teams)', () => {
  it.each(['payments-squad', 'throwaway'])('%s resolves against safe-scrum@1', async (name) => {
    const pack = await loadPack(join(ROOT, 'packs/safe-scrum'));
    const raw = parse(await readFile(join(ROOT, 'examples/overlays', name, 'team.yaml'), 'utf8'));
    const wf = resolveWorkflow(pack, raw);
    expect(wf.contracts).toHaveLength(7);
    expect(wf.overlay.team).toBe(raw.team);
  });
});

describe('the whole app on one machine (demo)', { timeout: 120_000 }, () => {
  it('runs one story from Jira to Done through the composition root, with the workspace repo, leases and the inbox', async () => {
    const lines: string[] = [];
    const d = await runDemo((l) => lines.push(l));
    expect(d.jira.issues.get('PAY-12')!.status).toBe('Done');
    expect(lines.at(-1)).toMatch(/^PAY-12: done · 1\d{3}\/4000 AI credits/);
    // the story's state was pushed to the workspace repo, with the lease
    const { stdout } = await exec('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: join(d.dir, 'workspace.git') });
    expect(stdout).toContain('.sdlc/work/stories/PAY-12/owner.json');
    expect(stdout).toContain('.sdlc/work/stories/PAY-12/artifacts/preprod-check-PAY-12.md');
    expect(stdout).toContain('.sdlc/work/topics/PAY-1/prd-v1.md');
    expect(stdout).not.toContain('leases/preprod.json'); // released after the check
    const v = await storyView(d.ctx, 'PAY-12');
    expect(v.gates).toEqual([]);
    expect(v.instances.find((i) => i.instance === 'developer:PAY-12:billing-api')).toMatchObject({ attempt: 3, state: 'idle' });
  });

  it('self-improvement: session metrics, Coach retros on signals, story metrics + one Jira line, Coach (b) overlay MR', async () => {
    const d = await runDemo(() => undefined);
    const dir = join(d.ctx.workRoot, 'retro', 'PAY-12');
    const files = (await import('node:fs/promises')).readdir(dir);
    const names = await files;
    // every settled session has metrics; only sessions with signals have a retro
    expect(names.filter((f) => f.endsWith('.metrics.json')).length).toBeGreaterThanOrEqual(9);
    expect(names.filter((f) => f.endsWith('.md')).sort()).toEqual(['session-developer_PAY-12_billing-api-1.md', 'session-developer_PAY-12_billing-api-2.md']); // a review asking for changes is no signal for the Reviewer
    const m = JSON.parse(await readFile(join(d.ctx.store.storyDir('PAY-12'), 'story-metrics-PAY-12.json'), 'utf8'));
    expect(m).toMatchObject({ outcome: 'done', quality: { reviewRoundsByRepo: { 'billing-api': 1 }, redPipelines: 1 }, effort: { sessions: 10 } });
    const lines = (await d.jira.getComments('PAY-12')).filter((c) => /sessions · /.test(c.body));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toMatch(/^\[sdlc\] 10 sessions · 1 review round · 0 defects · 0 questions · /);

    // more passes after Done: still exactly one Jira summary
    await d.cycle();
    expect((await d.jira.getComments('PAY-12')).filter((c) => /sessions · /.test(c.body))).toHaveLength(1);

    // Coach (b): 2 matching findings for the developer → 1 overlay MR touching only .sdlc/team/
    const r = await d.ctx.retro.improve();
    expect(r.opened.map((i) => [i.agent, i.rootCause, i.fixTarget])).toEqual([['developer', 'missing-instruction', '.sdlc/team/agents/developer/instructions.md']]);
    const mr = d.gitlab.mrs.find((x) => x.project === 'payments/payments-sdlc-workspace')!;
    expect(mr.sourceBranch).toMatch(/^sdlc\/coach-developer-/);
    const { stdout: changed } = await exec('git', ['diff', '--name-only', `main...${mr.sourceBranch}`], { cwd: join(d.dir, 'workspace.git') });
    expect(changed.trim().split('\n').every((f) => f.startsWith('.sdlc/team/'))).toBe(true);
    // one open Coach MR per agent: the developer's next finding waits
    expect((await d.ctx.retro.improve()).opened.filter((i) => i.agent === 'developer')).toEqual([]);
    expect((await d.ctx.retro.compare('developer', 'unknown-rev')).verdict).toBe('inconclusive');
  });

  it('the inbox shows gates waiting for a human', async () => {
    const d = await setupDemo();
    await d.cycle();
    expect((await inbox(d.ctx)).map((i) => `${i.kind} ${i.id}`)).toEqual(['gate proposal-PAY-12-billing-api']);
  });
});
