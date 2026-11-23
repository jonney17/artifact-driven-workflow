import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StubRunner } from '@sdlc/runtimes';
import { BudgetGuard } from '../src/budget';
import { Engine } from '../src/engine';
import { EventLog } from '../src/recovery';
import { ArtifactStore } from '../src/store';
import { PROPOSAL, tempDir, testWorkflow } from './fixtures';

async function setup(credits: number, monthlyAllowance = 100_000) {
  const root = await tempDir();
  const store = new ArtifactStore(root);
  const events = new EventLog(root);
  const budget = new BudgetGuard({ perStory: 100, warnAt: 0.8, monthlyAllowance, reserveShare: 0.7, usageFile: join(root, 'usage.json'), now: () => new Date('2026-11-23T10:00:00Z') });
  let n = 0;
  const runner = new StubRunner().on('planner', (_r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'proposal', body: PROPOSAL + `\n<!-- ${++n} -->` }], changedFiles: [], aiCredits: credits }));
  const engine = new Engine({ store, events, runner, workflow: testWorkflow(), budget });
  const story = async (body: string) => store.write({ id: 'story-PAY-1', type: 'story', status: 'ready', produced_by: 'engine', story: 'PAY-1', body });
  await story('v1');
  return { engine, events, budget, story, runner };
}
const s = { key: 'PAY-1', repos: [], owned: true };

describe('budget (plan §5a)', () => {
  it('warns at 80%, blocks new sessions at 100% of the story budget, and a raise unblocks', async () => {
    const { engine, events, story, runner } = await setup(85);
    expect((await engine.tick(s)).dispatched).toHaveLength(1); // 85 used
    await story('v2'); // story edited: planner should rerun
    const t2 = await engine.tick(s); // 85 ≥ 80: warning only, still runs → 170
    expect(t2.dispatched).toHaveLength(1);
    await story('v3');
    const t3 = await engine.tick(s);
    expect(t3.budgetStop).toBe('story budget');
    expect(t3.dispatched).toEqual([]);
    expect(runner.calls).toHaveLength(2);
    const types = (await events.read('PAY-1')).map((e) => `${e.type}${e.data.reason ? ` ${e.data.reason}` : ''}`);
    expect(types).toContain('budget.warning');
    expect(types).toContain('instance.blocked blocked: budget');
    await engine.raiseBudget('PAY-1', 200, 'bob@corp');
    expect((await engine.tick(s)).dispatched).toHaveLength(1);
  });

  it('the personal reserve stops new sessions on this machine without blocking the story', async () => {
    const { engine, budget } = await setup(10, 1000); // reserve = 700
    await budget.record(700);
    const t = await engine.tick(s);
    expect(t.budgetStop).toBe('personal reserve');
    expect(t.dispatched).toEqual([]);
  });

  it('usage is recorded per month on this machine only', async () => {
    const { engine, budget } = await setup(42);
    await engine.tick(s);
    expect(await budget.monthUsed()).toBe(42);
  });
});
