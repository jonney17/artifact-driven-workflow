import type { Artifact, EngineEvent } from '@sdlc/contracts';
import type { Question } from '@sdlc/runtimes';
import { buildSessions, type SessionRecord } from './sessions';

export type StoryOutcome = 'done' | 'cancelled' | 'carried-over' | 'split' | 'in-progress';

/** `story-metrics-<KEY>.json` (plan §7 "Per-story metrics"). Agents and roles, never people. */
export interface StoryMetrics {
  story: string;
  outcome: StoryOutcome;
  sprint?: string;
  effort: {
    sessions: number;
    attemptsByAgentRepo: Record<string, number>;
    aiCredits: number;
    aiCreditsByAgent: Record<string, number>;
    fallbackModelSessions: number;
    takeovers: { step: string; reason: string }[];
  };
  quality: {
    reviewRoundsByRepo: Record<string, number>;
    defectRoundsByRepo: Record<string, number>;
    proposalRejections: number;
    poRejections: number;
    redPipelines: number;
    overturnedAssumptions: number;
  };
  flow: {
    leadTimeMs: number;
    /** Agent time vs waiting for humans, per role (never per person). */
    agentMs: number;
    humanWaitMsByRole: Record<string, number>;
    humanWaitShare: number;
  };
  questions: { total: number; byCategory: Record<string, number>; blocking: number; nonBlocking: number; medianAnswerMs?: number };
  acCoverage?: { covered: number; total: number };
}

const ROUTE_ROLE: Record<string, string> = { requirement: 'po', technical: 'dev', test: 'qe', environment: 'sm' };
const GATE_ROLE: Record<string, string> = { proposal: 'dev', 'test-scenarios': 'qe', 'story-acceptance': 'po' };

export function storyMetrics(a: {
  story: string;
  events: EngineEvent[];
  artifacts: Artifact[];
  questions: Question[];
  outcome: StoryOutcome;
  sprint?: string;
  fallbackModels?: string[];
}): StoryMetrics {
  const sessions = buildSessions(a.story, a.events, a.artifacts);
  const count = (f: (s: SessionRecord) => string) => sessions.reduce<Record<string, number>>((m, s) => ((m[f(s)] = (m[f(s)] ?? 0) + 1), m), {});
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
  const byType = (t: string) => a.artifacts.filter((x) => x.envelope.type === t);
  const perRepo = (t: string) => byType(t).reduce<Record<string, number>>((m, x) => ((m[x.envelope.repo ?? '-'] = (m[x.envelope.repo ?? '-'] ?? 0) + 1), m), {});

  // human waits: questions (by route → role) and gates (artifact ready → passed/rejected, by gate role)
  const wait: Record<string, number> = {};
  for (const s of sessions) for (const [route, w] of Object.entries(s.waitMsByRoute)) wait[ROUTE_ROLE[route] ?? route] = (wait[ROUTE_ROLE[route] ?? route] ?? 0) + w;
  for (const g of a.events.filter((e) => e.type === 'gate.passed' || e.type === 'gate.rejected')) {
    const written = a.events.find((e) => e.type === 'artifact.written' && e.data.artifact === g.data.artifact && e.data.version === g.data.version);
    const type = a.artifacts.find((x) => x.envelope.id === g.data.artifact)?.envelope.type ?? '';
    if (written) wait[GATE_ROLE[type] ?? 'dev'] = (wait[GATE_ROLE[type] ?? 'dev'] ?? 0) + Math.max(0, Date.parse(g.ts) - Date.parse(written.ts));
  }
  const first = a.events[0]?.ts;
  const last = a.events.at(-1)?.ts;
  const leadTimeMs = first && last ? Date.parse(last) - Date.parse(first) : 0;
  const humanWait = sum(Object.values(wait));

  const answered = a.questions.filter((q) => q.answeredAt && q.status === 'answered').map((q) => Date.parse(q.answeredAt!) - Date.parse(q.askedAt)).sort((x, y) => x - y);
  const acceptance = byType('story-acceptance').at(-1);
  const rows = acceptance?.body.match(/^\|\s*[A-Z][A-Z0-9_]+-\d+-AC\d+\s*\|.*$/gim) ?? [];
  const passed = rows.filter((r) => /\|\s*pass\s*\|/i.test(r)).length;

  return {
    story: a.story,
    outcome: a.outcome,
    ...(a.sprint ? { sprint: a.sprint } : {}),
    effort: {
      sessions: sessions.length,
      attemptsByAgentRepo: count((s) => (s.repo ? `${s.agent}:${s.repo}` : s.agent)),
      aiCredits: sum(sessions.map((s) => s.aiCredits)),
      aiCreditsByAgent: sessions.reduce<Record<string, number>>((m, s) => ((m[s.agent] = (m[s.agent] ?? 0) + s.aiCredits), m), {}),
      fallbackModelSessions: sessions.filter((s) => s.model && (a.fallbackModels ?? []).includes(s.model)).length,
      takeovers: a.events.filter((e) => e.type === 'takeover.started').map((e) => ({ step: String(e.data.step ?? ''), reason: String(e.data.reason ?? '') })),
    },
    quality: {
      reviewRoundsByRepo: perRepo('review-finding'),
      defectRoundsByRepo: perRepo('defect'),
      proposalRejections: a.events.filter((e) => e.type === 'gate.rejected' && String(e.data.artifact).startsWith('proposal-')).length,
      poRejections: a.events.filter((e) => e.type === 'gate.rejected' && String(e.data.artifact).startsWith('story-acceptance-')).length,
      redPipelines: byType('pipeline-failure').length,
      overturnedAssumptions: 0, // needs Reviewer/QE to mark assumptions overturned: see HANDOFF gaps
    },
    flow: { leadTimeMs, agentMs: sum(sessions.map((s) => s.agentMs)), humanWaitMsByRole: wait, humanWaitShare: leadTimeMs ? humanWait / leadTimeMs : 0 },
    questions: {
      total: a.questions.length,
      byCategory: a.questions.reduce<Record<string, number>>((m, q) => ((m[q.route] = (m[q.route] ?? 0) + 1), m), {}),
      blocking: a.questions.filter((q) => q.blocking).length,
      nonBlocking: a.questions.filter((q) => !q.blocking).length,
      ...(answered.length ? { medianAnswerMs: answered[Math.floor(answered.length / 2)]! } : {}),
    },
    ...(rows.length ? { acCoverage: { covered: passed, total: rows.length } } : {}),
  };
}

const days = (ms: number) => `${(ms / 86_400_000).toFixed(1)} days`;

/** The one-line `[sdlc]` Jira summary at done or cancel (plan §7). */
export function oneLine(m: StoryMetrics): string {
  const review = Object.values(m.quality.reviewRoundsByRepo).reduce((x, y) => x + y, 0);
  const defects = Object.values(m.quality.defectRoundsByRepo).reduce((x, y) => x + y, 0);
  return `${m.effort.sessions} sessions · ${review} review round${review === 1 ? '' : 's'} · ${defects} defect${defects === 1 ? '' : 's'} · ${m.questions.total} question${m.questions.total === 1 ? '' : 's'} · ${days(m.flow.leadTimeMs)} (${Math.round(m.flow.humanWaitShare * 100)}% waiting for humans) · ${m.effort.aiCredits.toLocaleString('en-US')} AI credits`;
}

/** Story-level retro triggers (`metrics.story_retro`). */
export function storyRetroSignals(m: StoryMetrics, cfg: { po_rejection?: boolean; defect_rounds_at_least?: number; over_budget?: boolean; human_wait_share_above?: number }, budget: number): string[] {
  const out: string[] = [];
  if ((cfg.po_rejection ?? true) && m.quality.poRejections > 0) out.push('po-rejection');
  if (Object.values(m.quality.defectRoundsByRepo).some((n) => n >= (cfg.defect_rounds_at_least ?? 2))) out.push('defect-rounds');
  if ((cfg.over_budget ?? true) && m.effort.aiCredits > budget) out.push('over-budget');
  if (m.flow.humanWaitShare > (cfg.human_wait_share_above ?? 0.6)) out.push('human-wait');
  return out;
}

/** `sdlc metrics --sprint`: computed on read from the story-metrics files. Nothing extra is written. */
export function sprintRollup(all: StoryMetrics[], sprint?: string) {
  const xs = sprint ? all.filter((m) => m.sprint === sprint) : all;
  const sum = (f: (m: StoryMetrics) => number) => xs.reduce((s, m) => s + f(m), 0);
  return {
    stories: xs.length,
    byOutcome: xs.reduce<Record<string, number>>((m, x) => ((m[x.outcome] = (m[x.outcome] ?? 0) + 1), m), {}),
    sessions: sum((m) => m.effort.sessions),
    aiCredits: sum((m) => m.effort.aiCredits),
    reviewRounds: sum((m) => Object.values(m.quality.reviewRoundsByRepo).reduce((a, b) => a + b, 0)),
    defectRounds: sum((m) => Object.values(m.quality.defectRoundsByRepo).reduce((a, b) => a + b, 0)),
    takeovers: sum((m) => m.effort.takeovers.length),
    medianLeadTimeMs: xs.map((m) => m.flow.leadTimeMs).sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0,
  };
}
