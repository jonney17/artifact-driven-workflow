import { type Artifact, artifactId, type Contract, type Limits } from '@sdlc/contracts';
import type { ResolvedContract } from './resolve';

export function instanceKey(contractId: string, story: string, repo?: string): string {
  return repo ? `${contractId}:${story}:${repo}` : `${contractId}:${story}`;
}

export interface StoryContext {
  key: string;
  /** Affected repos (from the Planner's explore artifact, or Jira hints). Drives `fan_out: repo`. */
  repos: string[];
  /** Whether this engine holds the story lease. */
  owned: boolean;
  /** Instance keys a human has taken over, or `'story'` for the whole story (plan §6a). */
  takenOver: Set<string> | 'story';
}

export type Decision =
  | {
      action: 'run';
      instance: string;
      contract: ResolvedContract;
      repo?: string;
      reason: 'output missing' | 'output stale' | 'rework';
      inputs: Artifact[];
      reworkInputs: Artifact[];
    }
  | {
      action: 'idle' | 'blocked';
      instance: string;
      contract: ResolvedContract;
      repo?: string;
      reason: string;
    };

export interface EvaluateArgs {
  story: StoryContext;
  contracts: ResolvedContract[];
  artifacts: Artifact[];
  stale: Set<string>;
  /** Instances that are running, waiting for a human, or otherwise locked. */
  locked: Set<string>;
  limits: Limits;
}

/** The make-like trigger rule (plan §2): which instances of a story should run now, and why not otherwise. */
export function evaluate(args: EvaluateArgs): Decision[] {
  const { story, contracts, artifacts, stale, locked, limits } = args;
  const decisions: Decision[] = [];
  for (const rc of contracts) {
    const c = rc.contract;
    const repos: (string | undefined)[] = c.fan_out === 'repo' ? story.repos : [undefined];
    for (const repo of repos) {
      const instance = instanceKey(c.id, story.key, repo);
      const base = { instance, contract: rc, ...(repo ? { repo } : {}) };
      if (!story.owned) {
        decisions.push({ ...base, action: 'idle', reason: 'story not owned by this engine' });
        continue;
      }
      if (!rc.enabled) {
        decisions.push({ ...base, action: 'idle', reason: 'agent disabled in the overlay' });
        continue;
      }
      if (story.takenOver === 'story' || story.takenOver.has(instance)) {
        decisions.push({ ...base, action: 'idle', reason: 'taken over by a human' });
        continue;
      }
      if (locked.has(instance)) {
        decisions.push({ ...base, action: 'idle', reason: 'locked' });
        continue;
      }

      const inputs = collectInputs(c, story.key, repo, artifacts, stale, story.repos);
      if ('missing' in inputs) {
        decisions.push({ ...base, action: 'idle', reason: `waiting for input ${inputs.missing}` });
        continue;
      }

      const rework = artifacts.filter((a) => isReworkFor(c, a, story.key, repo));
      const over = c.rework_inputs.find((ri) => {
        if (!ri.limit) return false;
        const rounds = rework.filter((a) => a.envelope.type === ri.type && a.envelope.status !== 'cancelled').length;
        return rounds > (limits[ri.limit] ?? Number.POSITIVE_INFINITY);
      });
      const openRework = rework.filter((a) => a.envelope.status === 'open');
      if (over && openRework.some((a) => a.envelope.type === over.type)) {
        decisions.push({ ...base, action: 'blocked', reason: `${over.limit} exceeded` });
        continue;
      }

      const outputIds = c.outputs.map((o) => artifactId(o.type, story.key, o.scope === 'repo' ? repo : undefined));
      const outputs = outputIds.map((id) => artifacts.find((a) => a.envelope.id === id));
      let reason: 'output missing' | 'output stale' | 'rework' | undefined;
      if (outputs.some((o) => !o)) reason = 'output missing';
      else if (outputIds.some((id) => stale.has(id))) reason = 'output stale';
      else if (openRework.length > 0) reason = 'rework';

      if (reason) decisions.push({ ...base, action: 'run', reason, inputs: inputs.artifacts, reworkInputs: openRework });
      else decisions.push({ ...base, action: 'idle', reason: 'up to date' });
    }
  }
  return decisions;
}

/** The usable inputs of one instance, or the first input type that isn't satisfied yet. */
export function collectInputs(
  c: Contract,
  story: string,
  repo: string | undefined,
  artifacts: Artifact[],
  stale: Set<string>,
  storyRepos: string[] = [],
): { artifacts: Artifact[] } | { missing: string } {
  const out: Artifact[] = [];
  for (const input of c.inputs) {
    const candidates = artifacts.filter(
      (a) =>
        a.envelope.type === input.type &&
        a.envelope.story === story &&
        (input.scope !== 'repo' || a.envelope.repo === repo) &&
        a.envelope.status !== 'cancelled',
    );
    const usable = candidates.filter((a) => input.status.includes(a.envelope.status) && !stale.has(a.envelope.id));
    if (input.scope === 'any') {
      // fan-in: every artifact of the type must be usable, and every affected repo must have one
      const reposCovered = storyRepos.every((r) => usable.some((a) => a.envelope.repo === r));
      const complete = candidates.length > 0 && usable.length === candidates.length && reposCovered;
      if (!complete && !input.optional) return { missing: input.type };
    } else if (usable.length === 0 && !input.optional) {
      return { missing: input.type };
    }
    out.push(...usable);
  }
  return { artifacts: out };
}

export function isReworkFor(c: Contract, a: Artifact, story: string, repo: string | undefined): boolean {
  const ri = c.rework_inputs.find((r) => r.type === a.envelope.type);
  if (!ri || a.envelope.story !== story) return false;
  return ri.scope === 'story' || a.envelope.repo === repo;
}
