import type { HandbackAt, TakeoverReason, TakeoverStep } from '@sdlc/orchestrator';
import type { SdlcContext } from './context';

/** Which role may pass which gate (plan §2 "Gates", role-checked against `members`). */
export const GATE_ROLES: Record<string, string[]> = {
  proposal_approval: ['dev'],
  scenario_approval: ['qe'],
  story_acceptance: ['po'],
};

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

const rolesOf = (ctx: SdlcContext, user: string) => ctx.team.members[user] ?? [];

/** Persists a human action to the workspace repo right away (the loop does the same each pass). */
async function persist(ctx: SdlcContext, key: string, what: string, user: string) {
  if (!ctx.dryRun) await ctx.ws.commitAndPush(`sdlc: ${what} (${user})`, [`.sdlc/work/stories/${key}`]);
}

export function gateOf(ctx: SdlcContext, type: string): string | undefined {
  return ctx.workflow.contracts.find((c) => c.contract.gate && c.contract.outputs.some((o) => o.type === type && o.gated))?.contract.gate ?? undefined;
}

/** The human actions of plan §2, §5a, §6, §6a, shared by the CLI and the API. */
export const actions = {
  async approve(ctx: SdlcContext, key: string, id: string, user: string): Promise<number> {
    const a = await ctx.store.get(key, id);
    if (!a) throw new NotFoundError(`${id} not found`);
    const gate = gateOf(ctx, a.envelope.type);
    if (!gate) throw new ForbiddenError(`${a.envelope.type} has no gate`);
    const need = GATE_ROLES[gate] ?? [];
    if (need.length && !rolesOf(ctx, user).some((r) => need.includes(r))) {
      throw new ForbiddenError(`${gate} needs role ${need.join(' or ')}; ${user} has ${rolesOf(ctx, user).join(', ') || 'none'}`);
    }
    await ctx.engine.passGate(key, id, user);
    await persist(ctx, key, `approve ${id}`, user);
    return a.envelope.version;
  },

  async reject(ctx: SdlcContext, key: string, id: string, user: string, reason: string): Promise<void> {
    const a = await ctx.store.get(key, id);
    if (!a) throw new NotFoundError(`${id} not found`);
    const gate = gateOf(ctx, a.envelope.type);
    const need = gate ? (GATE_ROLES[gate] ?? []) : [];
    if (need.length && !rolesOf(ctx, user).some((r) => need.includes(r))) throw new ForbiddenError(`${gate} needs role ${need.join(' or ')}`);
    if (!reason.trim()) throw new ForbiddenError('a reason is required');
    await ctx.engine.rejectGate(key, id, user, reason);
    await persist(ctx, key, `reject ${id}`, user);
  },

  async answer(ctx: SdlcContext, key: string, qid: string, user: string, text: string) {
    const r = await ctx.questions.answer(key, qid.toUpperCase(), text, user);
    if (r === 'rejected') throw new ForbiddenError(`${qid} isn't routed to ${user}`);
    await persist(ctx, key, `answer ${qid}`, user);
    return r;
  },

  async takeover(ctx: SdlcContext, a: { key: string; repo?: string; step: TakeoverStep; reason: TakeoverReason; note: string; user: string }) {
    if ((a.step === 'qe-write' || a.step === 'qe-run') && !rolesOf(ctx, a.user).includes('qe')) throw new ForbiddenError(`${a.step} takeover needs role qe`);
    const stopped = await ctx.takeovers.takeover({ story: a.key, ...(a.repo ? { repo: a.repo } : {}), step: a.step, reason: a.reason, note: a.note, by: a.user });
    await persist(ctx, a.key, `takeover ${a.key} ${a.step}`, a.user);
    return stopped;
  },

  async handback(ctx: SdlcContext, a: { key: string; repo?: string; step: TakeoverStep; at: HandbackAt; user: string; summary?: string }) {
    await ctx.takeovers.handback({ story: a.key, ...(a.repo ? { repo: a.repo } : {}), step: a.step, at: a.at, by: a.user, ...(a.summary ? { summary: a.summary } : {}) });
    await persist(ctx, a.key, `handback ${a.key} at ${a.at}`, a.user);
  },

  async raiseBudget(ctx: SdlcContext, key: string, amount: number, user: string) {
    await ctx.engine.raiseBudget(key, amount, user);
    await persist(ctx, key, `budget raise ${key}`, user);
  },
};
