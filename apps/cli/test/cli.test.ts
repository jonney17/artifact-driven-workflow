import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { setupDemo } from '@sdlc/app';
import { program } from '../src/program';

/** Runs `sdlc <args>` in-process against a demo setup (fake Jira/GitLab, scripted agents, real git workspace). */
async function cli() {
  const demo = await setupDemo();
  const config = join(demo.dir, 'config.yaml');
  await writeFile(config, stringify({ workspace: join(demo.dir, 'workspace'), user: 'bob@demo', worktrees: join(demo.dir, 'worktrees') }));
  process.env.SDLC_CONFIG = config;
  const apis = { jira: demo.jira, gitlab: demo.gitlab, runner: (demo.ctx as any).engine.o.runner, worktrees: { prepare: async ({ instance, attempt }: { instance: string; attempt: number }) => join(demo.dir, 'wt', instance.replace(/:/g, '_'), `a${attempt}`) }, push: async () => undefined };
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const p = program({ out: (l) => out.push(l), err: (l) => out.push(l), apis });
    p.exitOverride();
    await p.parseAsync(['node', 'sdlc', ...args]);
    return out.join('\n');
  };
  return { demo, run };
}

describe('sdlc CLI', { timeout: 120_000 }, () => {
  it('run, status, inbox, approve with a role check, takeover and handback, budget', async () => {
    const { demo, run } = await cli();
    expect(await run('run', '--once')).toMatch(/owned PAY-12; ran PAY-12 planner:PAY-12#1:done/);
    expect(await run('status')).toMatch(/^PAY-12\s+refining\s+gates 1/);
    expect(await run('inbox')).toContain('gate     PAY-12     proposal-PAY-12-billing-api: proposal_approval: proposal (billing-api) v1');
    expect(await run('show', 'PAY-12', 'proposal-PAY-12-billing-api')).toContain('## Interfaces & test hooks');

    // bob is a dev: may approve the proposal, not the QE scenarios
    await run('run', '--once');
    await expect(run('approve', 'PAY-12', 'test-scenarios-PAY-12-billing-api')).rejects.toThrow(/needs role qe/);
    expect(await run('approve', 'PAY-12', 'proposal-PAY-12-billing-api')).toBe('approved proposal-PAY-12-billing-api v1');

    // takeover stops the agents of that step; handback needs the contract to hold
    await expect(run('takeover', 'PAY-12', 'billing-api', '--reason', 'stuck', '--note', '')).rejects.toThrow(/note is required/);
    expect(await run('takeover', 'PAY-12', 'billing-api', '--reason', 'delicate-change', '--note', 'tax rounding')).toBe(
      'taken over: developer:PAY-12:billing-api, reviewer:PAY-12:billing-api',
    );
    expect(await run('status', 'PAY-12')).toMatch(/developer:PAY-12:billing-api\s+human/);
    await expect(run('handback', 'PAY-12', 'billing-api', '--at', 'review')).rejects.toThrow(/mr-description is missing/);
    expect(await run('handback', 'PAY-12', 'billing-api', '--at', 'develop')).toBe('handed back PAY-12 billing-api at develop');

    expect(await run('budget')).toMatch(/your month: \d+ \/ 50000 AI credits \(reserve stop at 35000\)/);
    expect(await run('budget', 'raise', 'PAY-12', '500')).toBe('raised PAY-12 by 500');
    expect(await run('log', 'PAY-12', '-n', '3')).toContain('budget.raised');
    expect(demo.jira.issues.get('PAY-12')!.status).toBe('In Refinement');
  });

  it('build writes the generated agent files into the workspace repo', async () => {
    const { run } = await cli();
    const out = await run('build');
    expect(out.split('\n')).toEqual([
      'wrote .github/agents/sdlc-planner.agent.md',
      'wrote .github/agents/sdlc-qe.agent.md',
      'wrote .github/agents/sdlc-developer.agent.md',
      'wrote .github/agents/sdlc-reviewer.agent.md',
      'wrote .github/agents/sdlc-coach.agent.md',
    ]);
  });
});
