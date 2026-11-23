import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, EngineEvent } from '@sdlc/contracts';
import { replay, storyCredits, storyLimit, storyRepos, storyStatus } from '@sdlc/orchestrator';
import type { Question } from '@sdlc/runtimes';
import type { SdlcContext } from './context';

export interface StoryView {
  key: string;
  status?: string;
  repos: string[];
  /** Jira lifecycle state from `jira.json` (active, paused, …). */
  lifecycle?: string;
  instances: { instance: string; state: string; attempt: number }[];
  gates: { artifact: string; type: string; repo?: string; version: number; gate: string }[];
  questions: { id: string; route: string; text: string; status: string; people: string[] }[];
  credits: { used: number; limit: number };
  artifacts: { id: string; type: string; status: string; version: number; repo?: string }[];
}

/** One story for the Board (plan §8): status, steps, pending gates, open questions, credits per story. */
export async function storyView(ctx: SdlcContext, key: string): Promise<StoryView> {
  const artifacts = await ctx.store.list(key);
  const events = await ctx.events.read(key);
  const state = replay(events);
  const repos = storyRepos(artifacts);
  const gated = new Map(ctx.workflow.contracts.flatMap((c) => (c.contract.gate ? c.contract.outputs.filter((o) => o.gated).map((o) => [o.type, c.contract.gate!] as const) : [])));
  const questions = await ctx.questions.list(key);
  const lifecycle = await readFile(join(ctx.store.storyDir(key), 'jira.json'), 'utf8').then((t) => JSON.parse(t).state as string, () => undefined);
  return {
    key,
    status: storyStatus(artifacts, repos, ctx.pack.jiraStatus ?? []),
    repos,
    ...(lifecycle ? { lifecycle } : {}),
    instances: [
      ...[...state.instances.values()].map((s) => ({ instance: s.instance, state: state.takenOver === 'story' || (state.takenOver as Set<string>).has(s.instance) ? 'human' : s.state, attempt: s.lastAttempt })),
      ...(state.takenOver === 'story' ? [] : [...state.takenOver].filter((i) => !state.instances.has(i)).map((i) => ({ instance: i, state: 'human', attempt: 0 }))),
    ],
    gates: artifacts
      .filter((a) => a.envelope.status === 'ready' && gated.has(a.envelope.type))
      .map((a) => ({ artifact: a.envelope.id, type: a.envelope.type, ...(a.envelope.repo ? { repo: a.envelope.repo } : {}), version: a.envelope.version, gate: gated.get(a.envelope.type)! })),
    questions: questions.filter((q) => q.status === 'open' || q.status === 'waiting').map((q) => ({ id: q.id, route: q.route, text: q.text, status: q.status, people: q.people })),
    credits: { used: storyCredits(events), limit: storyLimit(events, ctx.workflow.limits.ai_credits_per_story) },
    artifacts: artifacts.map(summary),
  };
}

const summary = (a: Artifact) => ({ id: a.envelope.id, type: a.envelope.type, status: a.envelope.status, version: a.envelope.version, ...(a.envelope.repo ? { repo: a.envelope.repo } : {}) });

export async function board(ctx: SdlcContext): Promise<StoryView[]> {
  return Promise.all((await ctx.knownStories()).map((k) => storyView(ctx, k)));
}

export interface InboxItem {
  kind: 'gate' | 'question' | 'blocked' | 'budget';
  story: string;
  id: string;
  text: string;
}

/** The owner's inbox (plan §8 "inbox and gates first"): gates to pass, questions for me, blocked steps, budget warnings. */
export async function inbox(ctx: SdlcContext, me = ctx.local.user): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  for (const key of await ctx.knownStories()) {
    const v = await storyView(ctx, key);
    for (const g of v.gates) items.push({ kind: 'gate', story: key, id: g.artifact, text: `${g.gate}: ${g.type}${g.repo ? ` (${g.repo})` : ''} v${g.version}` });
    for (const q of v.questions) if (q.people.map((p) => p.toLowerCase()).includes(me.toLowerCase())) items.push({ kind: 'question', story: key, id: q.id, text: q.text });
    for (const i of v.instances) if (i.state === 'blocked') items.push({ kind: 'blocked', story: key, id: i.instance, text: `${i.instance} is blocked` });
    if (v.credits.used >= v.credits.limit) items.push({ kind: 'budget', story: key, id: `budget-${key}`, text: `blocked: budget (${v.credits.used}/${v.credits.limit} AI credits)` });
  }
  return items;
}

export async function activity(ctx: SdlcContext, key: string, limit = 50): Promise<EngineEvent[]> {
  return (await ctx.events.read(key)).slice(-limit);
}

export async function artifact(ctx: SdlcContext, key: string, id: string): Promise<Artifact | undefined> {
  return ctx.store.get(key, id);
}

export async function questionsFor(ctx: SdlcContext, me = ctx.local.user): Promise<Question[]> {
  const all = await Promise.all((await ctx.knownStories()).map((k) => ctx.questions.list(k)));
  return all.flat().filter((q) => (q.status === 'open' || q.status === 'waiting') && q.people.map((p) => p.toLowerCase()).includes(me.toLowerCase()));
}
