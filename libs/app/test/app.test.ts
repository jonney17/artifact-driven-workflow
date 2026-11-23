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

  it('the inbox shows gates waiting for a human', async () => {
    const d = await setupDemo();
    await d.cycle();
    expect((await inbox(d.ctx)).map((i) => `${i.kind} ${i.id}`)).toEqual(['gate proposal-PAY-12-billing-api']);
  });
});
