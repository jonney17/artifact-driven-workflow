import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact, EngineEvent } from '@sdlc/contracts';
import { parseRetro, recurring, type RetroFinding } from '../src/coach';
import { compareOverlay } from '../src/effect';
import { buildSessions, type SessionRecord } from '../src/sessions';
import { oneLine, sprintRollup, storyMetrics, storyRetroSignals } from '../src/story-metrics';
import { OtlpReceiver, otelEnv, stripContent } from '../src/telemetry';

let n = 0;
const t0 = Date.parse('2026-11-23T08:00:00Z');
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const ev = (min: number, type: EngineEvent['type'], instance?: string, attempt?: number, data: Record<string, unknown> = {}, session_id?: string): EngineEvent => ({
  id: `e${++n}`,
  ts: at(min),
  story: 'PAY-1',
  type,
  ...(instance ? { instance } : {}),
  ...(attempt ? { attempt } : {}),
  ...(session_id ? { session_id } : {}),
  data,
});
const art = (id: string, type: string, status: string, extra: Partial<Artifact['envelope']> = {}, body = ''): Artifact => ({ envelope: { id, type, version: 1, status, produced_by: 'x', story: 'PAY-1', derived_from: [], ...extra }, body });

const DEV = 'developer:PAY-1:api';
const events: EngineEvent[] = [
  ev(0, 'attempt.dispatched', 'planner:PAY-1', 1, { agent: 'planner', contract: 'planner', overlay_rev: 'r1' }),
  ev(10, 'artifact.written', 'planner:PAY-1', 1, { artifact: 'proposal-PAY-1-api', version: 1, status: 'ready' }),
  ev(10, 'attempt.finished', 'planner:PAY-1', 1, { ai_credits: 100, consumed: [] }, 's1'),
  ev(70, 'gate.passed', undefined, undefined, { artifact: 'proposal-PAY-1-api', version: 1, by: 'bob' }),
  ev(71, 'attempt.dispatched', DEV, 1, { agent: 'developer', repo: 'api', overlay_rev: 'r1' }),
  ev(80, 'attempt.waiting', DEV, 1, { question: { route: 'requirement', text: '?' } }, 's2'),
  ev(140, 'attempt.resumed', DEV, 1, {}, 's2'),
  ev(150, 'artifact.written', DEV, 1, { artifact: 'code-PAY-1-api', version: 1 }),
  ev(150, 'attempt.finished', DEV, 1, { ai_credits: 300, consumed: ['answer-x'] }, 's2'),
  ev(160, 'attempt.dispatched', DEV, 2, { agent: 'developer', repo: 'api', overlay_rev: 'r1' }),
  ev(170, 'artifact.written', DEV, 2, { artifact: 'code-PAY-1-api', version: 2 }),
  ev(170, 'attempt.finished', DEV, 2, { ai_credits: 200, consumed: ['review-finding-PAY-1-api-1'] }, 's3'),
  ev(180, 'takeover.started', DEV, undefined, { step: 'develop', reason: 'stuck', note: 'loops' }),
];
const artifacts = [
  art('proposal-PAY-1-api', 'proposal', 'approved', { repo: 'api' }),
  art('code-PAY-1-api', 'code', 'ready', { repo: 'api', version: 2 }),
  art('review-finding-PAY-1-api-1', 'review-finding', 'consumed', { repo: 'api' }),
  art('answer-x', 'answer', 'consumed'),
  art('review-PAY-1-api', 'review', 'approved', { repo: 'api', derived_from: [{ id: 'code-PAY-1-api', version: 2, hash: 'h' }] }),
  art('story-acceptance-PAY-1', 'story-acceptance', 'approved', {}, '| PAY-1-AC1 | t1 | pass |\n| PAY-1-AC2 | t2 | fail |'),
];

describe('sessions and signals (plan §7)', () => {
  it('measures agent time vs human wait, and puts signals on the session whose output caused them', () => {
    const [planner, dev1, dev2] = buildSessions('PAY-1', events, artifacts);
    expect(planner).toMatchObject({ agent: 'planner', attempt: 1, aiCredits: 100, agentMs: 10 * 60_000, signals: [], settled: true, overlayRev: 'r1' });
    expect(dev1).toMatchObject({ attempt: 1, questions: 1, agentMs: 19 * 60_000, waitMsByRoute: { requirement: 60 * 60_000 }, settled: true });
    expect(dev1!.signals).toEqual(['blocking-question', 'rework']);
    expect(dev1!.signalDetail.rework).toBe('review-finding');
    expect(dev2!.signals).toEqual(['takeover']);
    expect(dev2!.signalDetail.takeover).toBe('stuck: loops');
    expect(dev2!.settled).toBe(true);
  });

  it('a clean session gets metrics only (no signals)', () => {
    expect(buildSessions('PAY-1', events.slice(0, 3), artifacts)[0]!.signals).toEqual([]);
  });
});

describe('story metrics', () => {
  it('rolls up effort, quality, flow (wait per role, never per person) and AC coverage; one-line Jira summary', () => {
    const m = storyMetrics({
      story: 'PAY-1',
      events,
      artifacts,
      questions: [{ id: 'Q-1', story: 'PAY-1', instance: DEV, attempt: 1, route: 'requirement', role: 'po', people: ['alice'], text: '?', blocking: true, status: 'answered', askedAt: at(80), answeredAt: at(140), answer: 'x' }],
      outcome: 'done',
      sprint: 'S12',
    });
    expect(m.effort).toMatchObject({ sessions: 3, aiCredits: 600, attemptsByAgentRepo: { planner: 1, 'developer:api': 2 }, takeovers: [{ step: 'develop', reason: 'stuck' }] });
    expect(m.quality.reviewRoundsByRepo).toEqual({ api: 1 });
    expect(m.flow.humanWaitMsByRole).toEqual({ po: 60 * 60_000, dev: 60 * 60_000 });
    expect(m.flow.leadTimeMs).toBe(180 * 60_000);
    expect(m.questions).toMatchObject({ total: 1, byCategory: { requirement: 1 }, blocking: 1, medianAnswerMs: 60 * 60_000 });
    expect(m.acCoverage).toEqual({ covered: 1, total: 2 });
    expect(JSON.stringify(m)).not.toMatch(/alice|bob/);
    expect(oneLine(m)).toBe('3 sessions · 1 review round · 0 defects · 1 question · 0.1 days (67% waiting for humans) · 600 AI credits');
    expect(storyRetroSignals(m, {}, 4000)).toEqual(['human-wait']);
    expect(sprintRollup([m, { ...m, sprint: 'S13' }], 'S12')).toMatchObject({ stories: 1, aiCredits: 600, takeovers: 1 });
  });
});

describe('Coach findings', () => {
  const retro = (agent: string, target: string, cause = 'missing-instruction') =>
    `# Session retro: developer:PAY-1:api attempt 1\n\n## Root cause\n\n- Root cause: ${cause}\n- Agent: ${agent}\n- Fix target: \`${target}\`\n\n## Proposed change\n\nAdd a line.\n`;
  it('parses retros; a fix target outside .sdlc/team/ is refused', () => {
    expect(parseRetro(retro('developer', '.sdlc/team/agents/developer/instructions.md'), 'f', 'PAY-1')).toMatchObject({ rootCause: 'missing-instruction', agent: 'developer', attempt: 1, proposedChange: 'Add a line.' });
    expect(parseRetro(retro('developer', 'src/main/App.java'), 'f', 'PAY-1')).toBeUndefined();
    expect(parseRetro(retro('developer', 'pack', 'contract-gap'), 'f', 'PAY-1')?.rootCause).toBe('contract-gap');
  });

  it('two matching findings trigger Coach (b); a second finding for an agent with an open Coach MR waits', () => {
    const f = (agent: string, cause = 'missing-instruction'): RetroFinding => ({ file: 'x', story: 'PAY-1', instance: 'i', rootCause: cause as never, agent, fixTarget: `.sdlc/team/agents/${agent}/instructions.md`, proposedChange: '' });
    const r = recurring([f('developer'), f('developer'), f('qe'), f('qe'), f('reviewer'), f('planner', 'contract-gap'), f('planner', 'contract-gap')], 2, new Set(['qe']));
    expect(r.ready.map((g) => g.agent)).toEqual(['developer']);
    expect(r.waiting.map((g) => g.agent)).toEqual(['qe']);
    expect(r.packProposals.map((g) => g.agent)).toEqual(['planner']);
  });
});

describe('effect check', () => {
  const s = (rev: string, rework: boolean, extra: Partial<SessionRecord> = {}): SessionRecord =>
    ({ story: 'P', instance: 'developer:P:api', contract: 'developer', agent: 'developer', attempt: 1, overlayRev: rev, startedAt: at(0), agentMs: 1, waitMsByRoute: {}, result: 'done', aiCredits: 100, questions: 0, consumed: [], outputs: [], signals: rework ? ['rework'] : [], signalDetail: {}, settled: true, ...extra }) as SessionRecord;
  const run = (sessions: SessionRecord[]) => compareOverlay({ sessions, agent: 'developer', rev: 'r2', revOrder: ['r1', 'r2'], primary: 'rework_rounds', guardrails: ['ai_credits_per_session', 'takeover_rate'] });

  it('< 5 comparable sessions on a side is inconclusive', () => {
    expect(run([...Array(5)].map(() => s('r1', true)).concat([...Array(4)].map(() => s('r2', false)))).verdict).toBe('inconclusive');
  });
  it('fewer rework rounds after the change is better; takeovers and fallback-model sessions are left out', () => {
    const before = [...Array(5)].map(() => s('r1', true));
    const after = [...Array(5)].map(() => s('r2', false)).concat([s('r2', true, { signals: ['rework', 'takeover'] }), s('r2', true, { model: 'cheap' })]);
    const r = compareOverlay({ sessions: [...before, ...after], agent: 'developer', rev: 'r2', revOrder: ['r1', 'r2'], primary: 'rework_rounds', guardrails: ['ai_credits_per_session'], fallbackModels: ['cheap'] });
    expect(r).toMatchObject({ verdict: 'better', before: { n: 5, primary: 1 }, after: { n: 5, primary: 0 } });
  });
  it('a worse guardrail makes it worse even if the primary metric improved', () => {
    const before = [...Array(5)].map(() => s('r1', true));
    const after = [...Array(5)].map(() => s('r2', false, { aiCredits: 300 }));
    expect(run([...before, ...after])).toMatchObject({ verdict: 'worse', reason: 'guardrail got worse: ai_credits_per_session' });
  });
});

describe('telemetry', () => {
  it('session OTLP env carries sdlc attributes; the receiver stores OTLP JSON without prompt text', async () => {
    const env = otelEnv('http://127.0.0.1:4318', { team: 'pay', story: 'PAY-1', repo: 'api', agent: 'developer', instance: DEV, attempt: 2, overlayRev: 'r1' });
    expect(env.OTEL_SERVICE_NAME).toBe('sdlc-developer');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('sdlc.instance=developer%3APAY-1%3Aapi');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('sdlc.attempt=2');

    const span = { resourceSpans: [{ resource: { attributes: [{ key: 'sdlc.instance', value: { stringValue: DEV } }] }, scopeSpans: [{ spans: [{ name: 'chat', attributes: [{ key: 'gen_ai.prompt', value: { stringValue: 'SECRET PROMPT' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: 120 } }] }] }] }] };
    expect(JSON.stringify(stripContent(span))).not.toContain('SECRET PROMPT');
    expect(JSON.stringify(stripContent(span))).toContain('input_tokens');

    const dir = await mkdtemp(join(tmpdir(), 'sdlc-otlp-'));
    const rx = new OtlpReceiver(dir);
    const url = await rx.start();
    try {
      expect((await fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(span) })).status).toBe(200);
      expect((await fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/x-protobuf' }, body: 'x' })).status).toBe(415);
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const stored = await readFile(join(dir, files[0]!), 'utf8');
      expect(stored).toContain('sdlc.instance');
      expect(stored).not.toContain('SECRET PROMPT');
    } finally {
      await rx.stop();
    }
  });
});
