import type { SessionRecord } from './sessions';

/** Per-session metrics the effect check can compare (plan §7 "Effect check"). */
export const SESSION_METRICS: Record<string, (s: SessionRecord) => number> = {
  rework_rounds: (s) => (s.signals.includes('rework') ? 1 : 0),
  ai_credits_per_session: (s) => s.aiCredits,
  takeover_rate: (s) => (s.signals.includes('takeover') ? 1 : 0),
  failure_rate: (s) => (s.result === 'failed' || s.result === 'rejected' ? 1 : 0),
  questions: (s) => s.questions,
  defect_rounds: (s) => (s.signals.includes('rework') && /defect/.test(s.signalDetail.rework ?? '') ? 1 : 0),
};

export type Verdict = 'better' | 'worse' | 'no change' | 'inconclusive';

export interface EffectResult {
  agent: string;
  rev: string;
  primary: string;
  before: { n: number; primary: number; guardrails: Record<string, number> };
  after: { n: number; primary: number; guardrails: Record<string, number> };
  verdict: Verdict;
  reason: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * `sdlc metrics --compare-overlay <rev>`: the agent's comparable sessions before and after an overlay
 * revision, pooled from all engines. Fallback-model sessions and takeover periods are left out.
 * Fewer than `minEach` sessions on a side → inconclusive (after `maxSprints` the change simply stays).
 * Lower is better for every metric here; a relative change under `tolerance` counts as no change.
 */
export function compareOverlay(a: {
  sessions: SessionRecord[];
  agent: string;
  rev: string;
  /** Overlay revisions in order (oldest first), to know which side of `rev` a session is on. */
  revOrder: string[];
  primary: string;
  guardrails: string[];
  minEach?: number;
  tolerance?: number;
  fallbackModels?: string[];
}): EffectResult {
  const minEach = a.minEach ?? 5;
  const tol = a.tolerance ?? 0.1;
  const idx = a.revOrder.indexOf(a.rev);
  const comparable = a.sessions.filter((s) => s.agent === a.agent && s.settled && !s.signals.includes('takeover') && !(s.model && (a.fallbackModels ?? []).includes(s.model)) && s.overlayRev);
  const side = (s: SessionRecord) => {
    const i = a.revOrder.indexOf(s.overlayRev!);
    return i < 0 || idx < 0 ? undefined : i < idx ? 'before' : 'after';
  };
  const before = comparable.filter((s) => side(s) === 'before');
  const after = comparable.filter((s) => side(s) === 'after');
  const m = (xs: SessionRecord[], metric: string) => mean(xs.map(SESSION_METRICS[metric] ?? (() => 0)));
  const summary = (xs: SessionRecord[]) => ({ n: xs.length, primary: m(xs, a.primary), guardrails: Object.fromEntries(a.guardrails.map((g) => [g, m(xs, g)])) });
  const res = { agent: a.agent, rev: a.rev, primary: a.primary, before: summary(before), after: summary(after) };
  if (before.length < minEach || after.length < minEach) return { ...res, verdict: 'inconclusive', reason: `need ≥ ${minEach} comparable sessions on each side (have ${before.length} before, ${after.length} after)` };
  const worse = (x: number, y: number) => y > x * (1 + tol) && y - x > 1e-9;
  const better = (x: number, y: number) => y < x * (1 - tol) && x - y > 1e-9;
  const badGuard = a.guardrails.filter((g) => worse(res.before.guardrails[g]!, res.after.guardrails[g]!));
  if (worse(res.before.primary, res.after.primary)) return { ...res, verdict: 'worse', reason: `${a.primary} went from ${res.before.primary.toFixed(2)} to ${res.after.primary.toFixed(2)}` };
  if (badGuard.length) return { ...res, verdict: 'worse', reason: `guardrail got worse: ${badGuard.join(', ')}` };
  if (better(res.before.primary, res.after.primary)) return { ...res, verdict: 'better', reason: `${a.primary} went from ${res.before.primary.toFixed(2)} to ${res.after.primary.toFixed(2)}` };
  return { ...res, verdict: 'no change', reason: `${a.primary} within ±${tol * 100}%` };
}

export interface Improvement {
  id: string;
  agent: string;
  rootCause: string;
  fixTarget: string;
  primaryMetric: string;
  guardrails: string[];
  /** Overlay revision the change landed in (after merge). */
  rev?: string;
  mrUrl?: string;
  revertMrUrl?: string;
  openedAt: string;
  status: 'open' | 'merged' | 'rejected' | 'reverted' | 'confirmed' | 'inconclusive';
  sprintsWaited?: number;
}

/** The Coach hit rate for the sprint retro (plan §7). */
export function hitRate(xs: Improvement[]) {
  const c = (s: Improvement['status']) => xs.filter((x) => x.status === s).length;
  return { opened: xs.length, merged: xs.filter((x) => ['merged', 'confirmed', 'reverted', 'inconclusive'].includes(x.status)).length, rejected: c('rejected'), reverted: c('reverted'), confirmed: c('confirmed') };
}
