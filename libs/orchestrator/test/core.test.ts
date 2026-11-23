import { describe, expect, it } from 'vitest';
import { ArtifactStore, hashBody, parseArtifact, pin, serializeArtifact } from '../src/store';
import { findStale } from '../src/stale';
import { OverlayError } from '../src/resolve';
import { evaluate, instanceKey } from '../src/trigger';
import { checkWriteScope, expandPatterns, parseSensitiveChanges } from '../src/writescope';
import { validateOutput } from '../src/validate';
import { replay } from '../src/recovery';
import { leaseState } from '../src/lease';
import { type Artifact, ContractOutputSchema, type EngineEvent } from '@sdlc/contracts';
import { baseOverlay, PROPOSAL, tempDir, testWorkflow } from './fixtures';

const art = (id: string, type: string, status: string, body = id, extra: Partial<Artifact['envelope']> = {}): Artifact => ({
  envelope: { id, type, version: 1, status, produced_by: 'test', story: 'PAY-1', derived_from: [], ...extra },
  body,
});

describe('artifact store', () => {
  it('round-trips the envelope and bumps the version only when the body changes', async () => {
    const store = new ArtifactStore(await tempDir());
    const w = { id: 'story-PAY-1', type: 'story', status: 'ready', produced_by: 'engine', story: 'PAY-1', body: 'AC1' };
    expect((await store.write(w)).envelope.version).toBe(1);
    expect((await store.write(w)).envelope.version).toBe(1);
    expect((await store.setStatus('PAY-1', 'story-PAY-1', 'approved')).envelope.version).toBe(1);
    expect((await store.write({ ...w, body: 'AC1 edited' })).envelope.version).toBe(2);
    const listed = await store.list('PAY-1');
    expect(listed).toHaveLength(1);
    expect(parseArtifact(serializeArtifact(listed[0]!))).toEqual(listed[0]);
  });

  it('rejects a file without front matter', () => {
    expect(() => parseArtifact('no front matter')).toThrow(/front matter/);
  });
});

describe('staleness', () => {
  it('cascades through derived_from and ignores status-only changes', () => {
    const story = art('story-PAY-1', 'story', 'approved', 'v2 body', { version: 2 });
    const proposal = art('proposal-PAY-1', 'proposal', 'approved', 'p', {
      derived_from: [{ id: 'story-PAY-1', version: 1, hash: hashBody('v1 body') }],
    });
    const code = art('code-PAY-1-api', 'code', 'ready', 'c', { repo: 'api', derived_from: [pin(proposal)] });
    const unrelated = art('other-PAY-1', 'other', 'ready', 'o', { derived_from: [pin(story)] });
    expect([...findStale([story, proposal, code, unrelated])].sort()).toEqual(['code-PAY-1-api', 'proposal-PAY-1']);
  });
});

describe('overlay resolve', () => {
  it('applies how-settings: model, enabled, gate mode', () => {
    const wf = testWorkflow({ ...baseOverlay(), agents: { developer: { model: 'm1' }, reviewer: { enabled: false } }, gates: { proposal_approval: 'human' } });
    const dev = wf.contracts.find((c) => c.contract.id === 'developer')!;
    expect(dev.overlay.model).toBe('m1');
    expect(wf.contracts.find((c) => c.contract.id === 'reviewer')!.enabled).toBe(false);
    expect(wf.contracts.find((c) => c.contract.id === 'planner')!.gateMode).toBe('human');
  });

  it.each(['inputs', 'outputs', 'write_allow', 'write_deny', 'tools', 'fan_out'])('refuses an overlay that changes %s', (field) => {
    expect(() => testWorkflow({ ...baseOverlay(), agents: { developer: { [field]: [] } } })).toThrow(OverlayError);
  });

  it('refuses contracts in the overlay, unknown agents, unknown settings and a different pack', () => {
    expect(() => testWorkflow({ ...baseOverlay(), contracts: [] })).toThrow(/may not define or change contracts/);
    expect(() => testWorkflow({ ...baseOverlay(), agents: { ghost: { model: 'x' } } })).toThrow(/no such agent/);
    expect(() => testWorkflow({ ...baseOverlay(), agents: { developer: { temperature: 1 } } })).toThrow(OverlayError);
    expect(() => testWorkflow({ ...baseOverlay(), pack: 'other@1' })).toThrow(/loaded pack is test-pack@1/);
  });
});

describe('trigger', () => {
  const wf = testWorkflow();
  const run = (artifacts: Artifact[], opts: { repos?: string[]; owned?: boolean; takenOver?: Set<string> | 'story'; locked?: string[] } = {}) =>
    evaluate({
      story: { key: 'PAY-1', repos: opts.repos ?? ['api', 'web'], owned: opts.owned ?? true, takenOver: opts.takenOver ?? new Set() },
      contracts: wf.contracts,
      artifacts,
      stale: findStale(artifacts),
      locked: new Set(opts.locked ?? []),
      limits: wf.limits,
    });
  const byInstance = (ds: ReturnType<typeof run>) => Object.fromEntries(ds.map((d) => [d.instance, `${d.action}: ${d.reason}`]));

  it('runs the planner when its output is missing and waits downstream', () => {
    const ds = byInstance(run([art('story-PAY-1', 'story', 'ready')]));
    expect(ds['planner:PAY-1']).toBe('run: output missing');
    expect(ds['developer:PAY-1:api']).toBe('idle: waiting for input proposal');
    expect(ds['qe-run:PAY-1']).toBe('idle: waiting for input code');
  });

  it('fans the developer out per repo only after the proposal is approved (the gate)', () => {
    const proposal = art('proposal-PAY-1', 'proposal', 'ready', PROPOSAL);
    expect(byInstance(run([art('story-PAY-1', 'story', 'ready'), proposal]))['developer:PAY-1:api']).toMatch(/^idle/);
    const ds = run([art('story-PAY-1', 'story', 'ready'), { ...proposal, envelope: { ...proposal.envelope, status: 'approved' } }]);
    expect(ds.filter((d) => d.action === 'run').map((d) => d.instance)).toEqual(['developer:PAY-1:api', 'developer:PAY-1:web']);
  });

  it('fan-in waits until every repo has usable code', () => {
    const story = art('story-PAY-1', 'story', 'ready');
    const proposal = art('proposal-PAY-1', 'proposal', 'approved', 'p');
    const planned = [story, { ...proposal, envelope: { ...proposal.envelope, derived_from: [pin(story)] } }];
    const api = art('code-PAY-1-api', 'code', 'ready', 'a', { repo: 'api' });
    const webDraft = art('code-PAY-1-web', 'code', 'draft', 'w', { repo: 'web' });
    expect(byInstance(run([...planned, api, webDraft]))['qe-run:PAY-1']).toBe('idle: waiting for input code');
    const web = art('code-PAY-1-web', 'code', 'ready', 'w', { repo: 'web' });
    expect(byInstance(run([...planned, api, web]))['qe-run:PAY-1']).toBe('run: output missing');
    expect(byInstance(run([...planned, api]))['qe-run:PAY-1']).toBe('idle: waiting for input code'); // web not produced yet
  });

  it('reruns on stale output and on open rework, and blocks past the round limit', () => {
    const story = art('story-PAY-1', 'story', 'ready');
    const proposal = art('proposal-PAY-1', 'proposal', 'approved', 'p', { derived_from: [pin(story)] });
    const code = art('code-PAY-1-api', 'code', 'ready', 'c', { repo: 'api', derived_from: [pin(proposal)] });
    const base = [story, proposal, code];
    expect(byInstance(run(base, { repos: ['api'] }))['developer:PAY-1:api']).toBe('idle: up to date');

    const editedStory = { ...story, envelope: { ...story.envelope, version: 2 }, body: 'edited' };
    expect(byInstance(run([editedStory, proposal, code], { repos: ['api'] }))['developer:PAY-1:api']).toMatch(/^idle: waiting for input proposal/);

    const review = (n: number, status: string) => art(`review-PAY-1-api-${n}`, 'review', status, 'r', { repo: 'api' });
    expect(byInstance(run([...base, review(1, 'open')], { repos: ['api'] }))['developer:PAY-1:api']).toBe('run: rework');
    expect(byInstance(run([...base, review(1, 'consumed'), review(2, 'open')], { repos: ['api'] }))['developer:PAY-1:api']).toBe('run: rework');
    expect(byInstance(run([...base, review(1, 'consumed'), review(2, 'consumed'), review(3, 'open')], { repos: ['api'] }))['developer:PAY-1:api']).toBe(
      'blocked: review_rounds exceeded',
    );
  });

  it('never runs a story it does not own, a disabled agent, a taken-over or locked instance', () => {
    const story = [art('story-PAY-1', 'story', 'ready')];
    expect(byInstance(run(story, { owned: false }))['planner:PAY-1']).toBe('idle: story not owned by this engine');
    expect(byInstance(run(story, { takenOver: new Set([instanceKey('planner', 'PAY-1')]) }))['planner:PAY-1']).toBe('idle: taken over by a human');
    expect(byInstance(run(story, { takenOver: 'story' }))['planner:PAY-1']).toBe('idle: taken over by a human');
    expect(byInstance(run(story, { locked: ['planner:PAY-1'] }))['planner:PAY-1']).toBe('idle: locked');
    const disabled = testWorkflow({ ...baseOverlay(), agents: { planner: { enabled: false } } });
    const ds = evaluate({ story: { key: 'PAY-1', repos: [], owned: true, takenOver: new Set() }, contracts: disabled.contracts, artifacts: story, stale: new Set(), locked: new Set(), limits: disabled.limits });
    expect(ds.find((d) => d.instance === 'planner:PAY-1')?.reason).toBe('agent disabled in the overlay');
  });
});

describe('write scope', () => {
  const dev = { writeAllow: ['**'], writeDeny: ['${test_dirs}/**', '.sdlc/**'], sensitivePaths: ['**/package.json', '.gitlab-ci.yml'], vars: { test_dirs: ['e2e', 'src/acceptance/'] } };

  it('expands placeholders', () => {
    expect(expandPatterns(['${test_dirs}/**'], { test_dirs: ['e2e', 'src/acceptance/'] })).toEqual(['e2e/**', 'src/acceptance/**']);
  });

  it('rejects writes to test dirs, denied and sensitive paths, and accepts the rest', () => {
    const v = checkWriteScope({ ...dev, unlocked: [], changedFiles: ['src/app.ts', 'e2e/login.spec.ts', '.sdlc/team/team.yaml', 'package.json', 'src\\acceptance\\X.java'] });
    expect(v).toEqual([
      { path: 'e2e/login.spec.ts', reason: 'in write_deny' },
      { path: '.sdlc/team/team.yaml', reason: 'in write_deny' },
      { path: 'package.json', reason: 'sensitive path not listed in the proposal' },
      { path: 'src/acceptance/X.java', reason: 'in write_deny' },
    ]);
  });

  it('a sensitive path listed in the approved proposal is allowed; others stay locked', () => {
    const unlocked = parseSensitiveChanges(PROPOSAL);
    expect(unlocked).toEqual(['package.json']);
    expect(checkWriteScope({ ...dev, unlocked, changedFiles: ['package.json', '.gitlab-ci.yml'] })).toEqual([
      { path: '.gitlab-ci.yml', reason: 'sensitive path not listed in the proposal' },
    ]);
    expect(parseSensitiveChanges('## Sensitive changes\nnone\n')).toEqual([]);
  });

  it('a file outside write_allow is rejected', () => {
    expect(checkWriteScope({ writeAllow: ['${test_dirs}/**'], writeDeny: [], sensitivePaths: [], unlocked: [], vars: { test_dirs: ['e2e'] }, changedFiles: ['src/app.ts'] })).toEqual([
      { path: 'src/app.ts', reason: 'not in write_allow' },
    ]);
  });
});

describe('output validation', () => {
  const out = ContractOutputSchema.parse({ type: 'proposal', required_sections: ['Interfaces & test hooks', 'Sensitive changes'] });
  it('requires the sections the contract names', () => {
    expect(validateOutput(out, PROPOSAL)).toEqual([]);
    expect(validateOutput(out, '# Proposal\n## Sensitive changes\nnone')).toEqual([{ type: 'proposal', message: 'missing required section "Interfaces & test hooks"' }]);
    expect(validateOutput(out, '  ')).toEqual([{ type: 'proposal', message: 'output is empty' }]);
    expect(validateOutput(out, undefined)).toEqual([{ type: 'proposal', message: 'output not produced' }]);
  });
});

describe('replay', () => {
  const ev = (type: EngineEvent['type'], instance?: string, extra: Partial<EngineEvent> = {}): EngineEvent => ({
    id: `${type}-${instance}-${Math.random()}`,
    ts: new Date().toISOString(),
    story: 'PAY-1',
    type,
    ...(instance ? { instance } : {}),
    data: {},
    ...extra,
  });

  it('finds unfinished and waiting attempts and takeovers', () => {
    const r = replay([
      ev('attempt.dispatched', 'planner:PAY-1', { attempt: 1 }),
      ev('attempt.finished', 'planner:PAY-1', { attempt: 1 }),
      ev('attempt.dispatched', 'developer:PAY-1:api', { attempt: 1 }),
      ev('attempt.dispatched', 'developer:PAY-1:web', { attempt: 2 }),
      ev('attempt.waiting', 'developer:PAY-1:web', { attempt: 2, session_id: 's-7' }),
      ev('takeover.started', 'reviewer:PAY-1:api'),
    ]);
    expect(r.unfinished.map((s) => [s.instance, s.lastAttempt])).toEqual([['developer:PAY-1:api', 1]]);
    expect(r.waiting.map((s) => [s.instance, s.lastAttempt, s.sessionId])).toEqual([['developer:PAY-1:web', 2, 's-7']]);
    expect(r.takenOver).toEqual(new Set(['reviewer:PAY-1:api']));
  });
});

describe('lease state', () => {
  const me = { user: 'bob', host: 'laptop', engine_id: 'e1' };
  const now = new Date('2026-11-23T10:00:00Z');
  const lease = (engine_id: string, minutesAgo: number) => ({ user: 'x', host: 'h', engine_id, heartbeat_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString() });
  it('is free, mine, held or expired', () => {
    expect(leaseState(undefined, me, now, 30)).toBe('free');
    expect(leaseState(lease('e1', 100), me, now, 30)).toBe('mine');
    expect(leaseState(lease('e2', 10), me, now, 30)).toBe('held');
    expect(leaseState(lease('e2', 31), me, now, 30)).toBe('expired');
  });
});
