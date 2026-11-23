import type { Artifact, EngineEvent } from '@sdlc/contracts';

export type Signal =
  | 'rework'
  | 'rejected'
  | 'validation-failed'
  | 'scope-violation'
  | 'failed'
  | 'blocking-question'
  | 'blocked'
  | 'cost-outlier'
  | 'takeover';

/** One agent session (= one attempt), built from `events.log` (plan §7 "Data per session"). */
export interface SessionRecord {
  story: string;
  instance: string;
  contract: string;
  agent: string;
  repo?: string;
  attempt: number;
  sessionId?: string;
  overlayRev?: string | null;
  model?: string;
  startedAt: string;
  endedAt?: string;
  /** Agent time: running, not waiting for a human. */
  agentMs: number;
  /** Time waiting for an `ask_human` answer, by role of the question's route. */
  waitMsByRoute: Record<string, number>;
  result: 'done' | 'failed' | 'rejected' | 'waiting' | 'running';
  aiCredits: number;
  questions: number;
  /** Rework input types this attempt consumed (why it ran). */
  consumed: string[];
  outputs: { id: string; version: number; status?: string }[];
  /** Why this session deserves a retro (empty = metrics only). */
  signals: Signal[];
  /** Detail per signal, e.g. the takeover reason or the rework type. */
  signalDetail: Record<string, string>;
  /** The outcome is known: a later attempt, a downstream artifact or a gate decision exists, or the session failed. */
  settled: boolean;
}

const ms = (a?: string, b?: string) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : 0);

/**
 * Sessions of a story from its events and artifacts. Signals point at the session whose output caused
 * the follow-up: a review finding consumed by attempt n+1 is a `rework` signal on attempt n.
 */
export function buildSessions(story: string, events: EngineEvent[], artifacts: Artifact[]): SessionRecord[] {
  const byKey = new Map<string, SessionRecord>();
  const order: SessionRecord[] = [];
  const open = new Map<string, { since: string; waitingSince?: string; route?: string }>();
  const key = (instance: string, attempt: number) => `${instance}#${attempt}`;

  for (const e of events) {
    if (!e.instance || !e.attempt) continue;
    const k = key(e.instance, e.attempt);
    let s = byKey.get(k);
    if (e.type === 'attempt.dispatched' && !s) {
      const [contract] = e.instance.split(':');
      s = {
        story,
        instance: e.instance,
        contract: String(e.data.contract ?? contract),
        agent: String(e.data.agent ?? contract),
        ...(e.data.repo ? { repo: String(e.data.repo) } : e.instance.split(':')[2] ? { repo: e.instance.split(':')[2]! } : {}),
        attempt: e.attempt,
        overlayRev: (e.data.overlay_rev as string | null | undefined) ?? null,
        ...(e.data.model ? { model: String(e.data.model) } : {}),
        startedAt: e.ts,
        agentMs: 0,
        waitMsByRoute: {},
        result: 'running',
        aiCredits: 0,
        questions: 0,
        consumed: [],
        outputs: [],
        signals: [],
        signalDetail: {},
        settled: false,
      };
      byKey.set(k, s);
      order.push(s);
      open.set(k, { since: e.ts });
      continue;
    }
    if (!s) continue;
    const o = open.get(k);
    if (e.session_id) s.sessionId = e.session_id;
    switch (e.type) {
      case 'attempt.waiting': {
        if (o) {
          s.agentMs += ms(o.since, e.ts);
          o.waitingSince = e.ts;
          o.route = (e.data.question as { route?: string } | undefined)?.route ?? 'unknown';
        }
        s.questions++;
        s.result = 'waiting';
        mark(s, 'blocking-question');
        break;
      }
      case 'attempt.resumed':
        if (o?.waitingSince) {
          s.waitMsByRoute[o.route ?? 'unknown'] = (s.waitMsByRoute[o.route ?? 'unknown'] ?? 0) + ms(o.waitingSince, e.ts);
          o.since = e.ts;
          delete o.waitingSince;
        }
        s.result = 'running';
        break;
      case 'artifact.written':
        s.outputs.push({ id: String(e.data.artifact), version: Number(e.data.version), ...(e.data.status ? { status: String(e.data.status) } : {}) });
        break;
      case 'attempt.finished':
      case 'attempt.failed':
      case 'validation.failed':
      case 'scope.violation':
        if (o && !o.waitingSince) s.agentMs += ms(o.since, e.ts);
        open.delete(k);
        s.endedAt = e.ts;
        s.aiCredits += typeof e.data.ai_credits === 'number' ? e.data.ai_credits : 0;
        s.result = e.type === 'attempt.finished' ? 'done' : e.type === 'attempt.failed' ? 'failed' : 'rejected';
        if (e.type === 'validation.failed') mark(s, 'validation-failed');
        if (e.type === 'scope.violation') mark(s, 'scope-violation');
        if (e.type === 'attempt.failed') mark(s, 'failed', String(e.data.reason ?? ''));
        if (e.type === 'attempt.finished') s.consumed = ((e.data.consumed as string[] | undefined) ?? []).map((id) => artifacts.find((a) => a.envelope.id === id)?.envelope.type ?? id.split('-').slice(0, -3).join('-'));
        break;
      default:
        break;
    }
  }

  // cross-session signals
  for (const s of order) {
    const later = order.filter((x) => x.instance === s.instance && x.attempt > s.attempt);
    const next = later[0];
    if (next?.consumed.length) mark(s, 'rework', next.consumed.join(', '));
    if (s.result === 'failed' || s.result === 'rejected' || later.length) s.settled = true;
    for (const out of s.outputs) {
      const consumedDownstream = artifacts.some((a) => a.envelope.derived_from.some((d) => d.id === out.id && d.version === out.version));
      const gate = events.find((e) => (e.type === 'gate.passed' || e.type === 'gate.rejected') && e.data.artifact === out.id && e.data.version === out.version);
      if (gate?.type === 'gate.rejected') mark(s, 'rejected', `${out.id} v${out.version}`);
      if (consumedDownstream || gate) s.settled = true;
    }
  }
  const after = (s: SessionRecord, e: EngineEvent) => e.ts >= s.startedAt && (!order.find((x) => x.instance === s.instance && x.attempt === s.attempt + 1) || e.ts <= order.find((x) => x.instance === s.instance && x.attempt === s.attempt + 1)!.startedAt);
  for (const e of events) {
    if (!e.instance) continue;
    const s = [...order].reverse().find((x) => x.instance === e.instance && after(x, e));
    if (!s) continue;
    if (e.type === 'instance.blocked') mark(s, 'blocked', String(e.data.reason ?? ''));
    if (e.type === 'takeover.started') {
      mark(s, 'takeover', `${e.data.reason}: ${e.data.note}`);
      s.settled = true;
    }
  }

  // cost outliers: more than twice the agent's median in this set
  const byAgent = new Map<string, number[]>();
  for (const s of order) if (s.aiCredits) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s.aiCredits]);
  for (const s of order) {
    const xs = (byAgent.get(s.agent) ?? []).slice().sort((a, b) => a - b);
    const median = xs.length >= 3 ? xs[Math.floor(xs.length / 2)]! : undefined;
    if (median && s.aiCredits > 2 * median) mark(s, 'cost-outlier', `${s.aiCredits} vs median ${median}`);
  }
  return order;
}

function mark(s: SessionRecord, sig: Signal, detail?: string) {
  if (!s.signals.includes(sig)) s.signals.push(sig);
  if (detail) s.signalDetail[sig] = detail;
}
