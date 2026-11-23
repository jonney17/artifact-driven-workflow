import { describe, expect, it } from 'vitest';
import { StubRunner } from '@sdlc/runtimes';
import { Engine } from '../src/engine';
import { EventLog, replay } from '../src/recovery';
import { ArtifactStore } from '../src/store';
import { PROPOSAL, tempDir, testWorkflow } from './fixtures';

async function setup(runner = new StubRunner()) {
  const root = await tempDir();
  const store = new ArtifactStore(root);
  const events = new EventLog(root);
  const engine = new Engine({ store, events, runner, workflow: testWorkflow() });
  await store.write({ id: 'story-PAY-1', type: 'story', status: 'ready', produced_by: 'engine', story: 'PAY-1', body: 'AC1: invoices can be created' });
  return { root, store, events, engine, runner };
}

const story = { key: 'PAY-1', repos: ['api', 'web'], owned: true };
const types = async (events: EventLog) => (await events.read('PAY-1')).map((e) => `${e.type} ${e.instance ?? ''}`.trim());

describe('engine', () => {
  it('runs planner, then (after the gate) one developer per repo, each in a new session and worktree', async () => {
    const runner = new StubRunner()
      .on('planner', (_r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'proposal', body: PROPOSAL }], changedFiles: ['.team/changes/PAY-1/proposal.md'] }))
      .on('developer', (r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'code', repo: r.repo!, body: `code for ${r.repo}` }], changedFiles: ['src/app.ts'], aiCredits: 120 }));
    const { store, events, engine } = await setup(runner);

    const t1 = await engine.tick(story);
    expect(t1.dispatched).toEqual([{ instance: 'planner:PAY-1', attempt: 1, result: 'done', resumed: false }]);
    const proposal = await store.get('PAY-1', 'proposal-PAY-1');
    expect(proposal?.envelope.status).toBe('ready');
    expect(proposal?.envelope.derived_from.map((d) => d.id)).toEqual(['story-PAY-1']);

    // gate not passed: nothing runs
    expect((await engine.tick(story)).dispatched).toEqual([]);

    await store.setStatus('PAY-1', 'proposal-PAY-1', 'approved');
    const t3 = await engine.tick(story);
    expect(t3.dispatched.map((d) => d.instance).sort()).toEqual(['developer:PAY-1:api', 'developer:PAY-1:web']);
    const devCalls = runner.calls.filter((c) => c.contractId === 'developer');
    expect(new Set(devCalls.map((c) => c.workdir)).size).toBe(2);
    expect(devCalls.every((c) => c.resumeSessionId === undefined)).toBe(true);
    // inputs are artifacts only, never another agent's transcript
    expect(devCalls[0]!.inputs.map((a) => a.envelope.id)).toEqual(['proposal-PAY-1']);
    expect(devCalls[0]!.policy.writeDeny).toContain('${test_dirs}/**');

    const sessions = (await events.read('PAY-1')).filter((e) => e.type === 'attempt.finished').map((e) => e.session_id);
    expect(new Set(sessions).size).toBe(3);
  });

  it('a story edit makes downstream stale and reruns the planner with a new attempt', async () => {
    let n = 0;
    const runner = new StubRunner().on('planner', (_r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'proposal', body: PROPOSAL + `\n<!-- ${++n} -->` }], changedFiles: [] }));
    const { store, events, engine } = await setup(runner);
    await engine.tick(story);
    await store.write({ id: 'story-PAY-1', type: 'story', status: 'ready', produced_by: 'engine', story: 'PAY-1', body: 'AC1 edited in Jira' });
    const t = await engine.tick(story);
    expect(t.dispatched).toEqual([{ instance: 'planner:PAY-1', attempt: 2, result: 'done', resumed: false }]);
    expect((await store.get('PAY-1', 'proposal-PAY-1'))?.envelope.version).toBe(2);
    expect((await types(events)).filter((x) => x.startsWith('artifact.stale'))).toEqual(['artifact.stale']);
    // the stale event is not repeated on the next tick
    await engine.tick(story);
    expect((await types(events)).filter((x) => x.startsWith('artifact.stale'))).toHaveLength(1);
  });

  it('rejects invalid output and out-of-scope writes, and blocks after repeated failures', async () => {
    const runner = new StubRunner().on('planner', (_r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'proposal', body: '# no sections' }], changedFiles: [] }));
    const { store, events, engine } = await setup(runner);
    expect((await engine.tick(story)).dispatched[0]?.result).toBe('rejected');
    expect(await store.get('PAY-1', 'proposal-PAY-1')).toBeUndefined();
    await engine.tick(story);
    expect(await types(events)).toEqual([
      'attempt.dispatched planner:PAY-1',
      'validation.failed planner:PAY-1',
      'attempt.dispatched planner:PAY-1',
      'validation.failed planner:PAY-1',
      'instance.blocked planner:PAY-1',
    ]);
    // blocked: no further dispatch
    expect((await engine.tick(story)).dispatched).toEqual([]);
  });

  it('rejects a developer change to a sensitive path the proposal does not list', async () => {
    const runner = new StubRunner().on('developer', (r, { sessionId }) => ({
      status: 'done',
      sessionId,
      outputs: [{ type: 'code', repo: r.repo!, body: 'x' }],
      changedFiles: r.repo === 'api' ? ['package.json'] : ['.gitlab-ci.yml'],
    }));
    const { store, events, engine } = await setup(runner);
    await store.write({ id: 'proposal-PAY-1', type: 'proposal', status: 'approved', produced_by: 'planner#1', story: 'PAY-1', body: PROPOSAL });
    const t = await engine.tick(story);
    expect(Object.fromEntries(t.dispatched.map((d) => [d.instance, d.result]))).toEqual({ 'developer:PAY-1:api': 'done', 'developer:PAY-1:web': 'rejected' });
    const violation = (await events.read('PAY-1')).find((e) => e.type === 'scope.violation');
    expect(violation?.data).toEqual({ violations: [{ path: '.gitlab-ci.yml', reason: 'sensitive path not listed in the proposal' }] });
  });

  it('an ask_human wait pauses only that branch and the answer resumes the same session and attempt', async () => {
    let asked = false;
    const runner = new StubRunner().on('developer', (r, { sessionId }) => {
      if (r.repo === 'web' && !asked) {
        asked = true;
        return { status: 'waiting', sessionId, question: { route: 'technical', text: 'Which date format?' } };
      }
      return { status: 'done', sessionId, outputs: [{ type: 'code', repo: r.repo!, body: `code ${r.reworkInputs.map((a) => a.body).join()}` }], changedFiles: ['src/x.ts'] };
    });
    const { store, engine, events } = await setup(runner);
    await store.write({ id: 'proposal-PAY-1', type: 'proposal', status: 'approved', produced_by: 'planner#1', story: 'PAY-1', body: PROPOSAL });

    const t1 = await engine.tick(story);
    expect(Object.fromEntries(t1.dispatched.map((d) => [d.instance, d.result]))).toEqual({ 'developer:PAY-1:api': 'done', 'developer:PAY-1:web': 'waiting' });
    // only the waiting branch pauses: api moves on to review, web dispatches nothing, and QE (fan-in) waits for web
    const t2 = await engine.tick(story);
    expect(t2.dispatched.map((d) => d.instance)).toEqual(['reviewer:PAY-1:api']);
    expect(t2.decisions.find((d) => d.instance === 'qe-run:PAY-1')?.reason).toBe('waiting for input code');

    await engine.answer('PAY-1', 'developer:PAY-1:web', 'ISO 8601', 'bob@corp');
    const t3 = await engine.tick(story);
    expect(t3.dispatched.find((d) => d.instance === 'developer:PAY-1:web')).toEqual({ instance: 'developer:PAY-1:web', attempt: 1, result: 'done', resumed: true });
    const webCalls = runner.calls.filter((c) => c.repo === 'web');
    const waitingSession = (await events.read('PAY-1')).find((e) => e.type === 'attempt.waiting')?.session_id;
    expect(waitingSession).toBeDefined();
    expect(webCalls[1]!.resumeSessionId).toBe(waitingSession);
    expect((await store.get('PAY-1', 'code-PAY-1-web'))?.body).toBe('code ISO 8601');
    expect((await store.get('PAY-1', 'answer-developer_PAY-1_web-a1'))?.envelope.status).toBe('consumed');
  });

  it('after a crash, an unfinished attempt is re-dispatched with the same number in a new session', async () => {
    const runner = new StubRunner().on('planner', (_r, { sessionId }) => ({ status: 'done', sessionId, outputs: [{ type: 'proposal', body: PROPOSAL }], changedFiles: [] }));
    const { root, events } = await setup(runner);
    await events.append({ story: 'PAY-1', type: 'attempt.dispatched', instance: 'planner:PAY-1', attempt: 1, session_id: 'old-session' });
    // a new engine process over the same work root
    const restarted = new Engine({ store: new ArtifactStore(root), events: new EventLog(root), runner, workflow: testWorkflow() });
    const t = await restarted.tick(story);
    expect(t.dispatched).toEqual([{ instance: 'planner:PAY-1', attempt: 1, result: 'done', resumed: false }]);
    expect(runner.calls[0]!.resumeSessionId).toBeUndefined();
    expect(replay(await events.read('PAY-1')).unfinished).toEqual([]);
  });

  it('a taken-over instance is left alone, and an unowned story is never run', async () => {
    const runner = new StubRunner();
    const { events, engine } = await setup(runner);
    expect((await engine.tick({ ...story, owned: false })).dispatched).toEqual([]);
    await events.append({ story: 'PAY-1', type: 'takeover.started', instance: 'planner:PAY-1', data: { reason: 'delicate-change' } });
    expect((await engine.tick(story)).dispatched).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});
