import { type Artifact, artifactId } from '@sdlc/contracts';
import type { AttemptResult, OutputDraft, Runner } from '@sdlc/runtimes';
import { type EventLog, replay, type StoryReplay } from './recovery';
import type { ResolvedContract, ResolvedWorkflow } from './resolve';
import { findStale } from './stale';
import { type ArtifactStore, pin } from './store';
import { collectInputs, type Decision, evaluate, isReworkFor } from './trigger';
import { checkWriteScope, parseSensitiveChanges } from './writescope';
import { validateOutput } from './validate';

/** Provides a fresh git worktree per attempt (plan §2). */
export interface WorktreeProvider {
  prepare(args: { instance: string; story: string; repo?: string; attempt: number }): Promise<string>;
}

export interface EngineOptions {
  store: ArtifactStore;
  events: EventLog;
  runner: Runner;
  workflow: ResolvedWorkflow;
  worktrees?: WorktreeProvider;
  /** Failed attempts in a row before an instance is blocked and escalated. */
  maxFailures?: number;
}

export interface StoryInput {
  key: string;
  repos: string[];
  /** Whether this engine holds the story lease (see LeaseManager). */
  owned: boolean;
}

export interface TickReport {
  decisions: Decision[];
  dispatched: { instance: string; attempt: number; result: AttemptResult['status'] | 'rejected'; resumed: boolean }[];
}

/** Id of the answer artifact for an instance's waiting attempt. */
export function answerId(instance: string, attempt: number): string {
  return `answer-${instance.replace(/:/g, '_')}-a${attempt}`;
}

/**
 * One story's pass through the loop (plan §2, steps 3–9): mark stale artifacts, evaluate the contracts,
 * dispatch ready instances through the runner, validate outputs, check write scope, retry or escalate,
 * and append everything to the story's events.log. Workspace pull/push and Jira/GitLab sync wrap this.
 */
export class Engine {
  private readonly running = new Set<string>();
  private readonly worktrees: WorktreeProvider;
  private readonly maxFailures: number;

  constructor(private readonly o: EngineOptions) {
    this.worktrees = o.worktrees ?? {
      prepare: async ({ instance, attempt }) => `worktrees/${instance.replace(/:/g, '_')}/a${attempt}`,
    };
    this.maxFailures = o.maxFailures ?? 2;
  }

  async tick(story: StoryInput): Promise<TickReport> {
    const { store, events, workflow } = this.o;
    const artifacts = await store.list(story.key);
    const state = replay(await events.read(story.key));

    const stale = findStale(artifacts);
    for (const id of stale) {
      const a = artifacts.find((x) => x.envelope.id === id);
      const eventId = `stale:${story.key}:${id}:v${a?.envelope.version}`;
      if (a && !state.seen.has(eventId)) {
        await events.append({ id: eventId, story: story.key, type: 'artifact.stale', data: { artifact: id, version: a.envelope.version } });
      }
    }

    const locked = new Set<string>(this.running);
    const resumable: { instance: string; attempt: number; sessionId?: string; answer: Artifact }[] = [];
    for (const s of state.instances.values()) {
      if (s.state === 'blocked') locked.add(s.instance);
      if (s.state === 'waiting') {
        locked.add(s.instance);
        const answer = artifacts.find((a) => a.envelope.id === answerId(s.instance, s.lastAttempt) && a.envelope.status === 'open');
        if (answer) resumable.push({ instance: s.instance, attempt: s.lastAttempt, ...(s.sessionId ? { sessionId: s.sessionId } : {}), answer });
      }
    }

    const decisions = evaluate({
      story: { key: story.key, repos: story.repos, owned: story.owned, takenOver: state.takenOver },
      contracts: workflow.contracts,
      artifacts,
      stale,
      locked,
      limits: workflow.limits,
    });

    for (const d of decisions) {
      if (d.action === 'blocked' && state.instances.get(d.instance)?.state !== 'blocked') {
        await events.append({ story: story.key, type: 'instance.blocked', instance: d.instance, data: { reason: d.reason } });
      }
    }

    // Resumes first: a human answered, so that branch continues in the same session (plan §6).
    const jobs: (() => Promise<TickReport['dispatched'][number]>)[] = [];
    if (story.owned) {
      for (const r of resumable) {
        const rc = workflow.contracts.find((c) => r.instance.startsWith(`${c.contract.id}:`));
        if (!rc) continue;
        const repo = r.instance.split(':')[2];
        const inputs = this.currentInputs(story, rc, repo, artifacts, stale);
        if (!inputs) continue;
        const d: Decision = {
          action: 'run',
          instance: r.instance,
          contract: rc,
          ...(repo ? { repo } : {}),
          reason: 'rework',
          inputs: inputs.inputs,
          reworkInputs: [...inputs.reworkInputs, r.answer],
        };
        jobs.push(() => this.dispatch(story.key, d, r.attempt, state, r.sessionId));
      }
    }
    for (const d of decisions) {
      if (d.action !== 'run') continue;
      const s = state.instances.get(d.instance);
      // An attempt that was dispatched but never finished (crash) keeps its number; anything else is a new attempt.
      const attempt = s?.state === 'running' ? s.lastAttempt : (s?.lastAttempt ?? 0) + 1;
      jobs.push(() => this.dispatch(story.key, d, attempt, state));
    }

    const dispatched: TickReport['dispatched'] = [];
    const limit = Math.max(1, workflow.limits.concurrency - this.running.size);
    for (let i = 0; i < jobs.length; i += limit) {
      dispatched.push(...(await Promise.all(jobs.slice(i, i + limit).map((j) => j()))));
    }
    return { decisions, dispatched };
  }

  /** Records a human answer to a waiting attempt; the next tick resumes that session. */
  async answer(story: string, instance: string, text: string, by: string): Promise<void> {
    const s = replay(await this.o.events.read(story)).instances.get(instance);
    if (s?.state !== 'waiting') throw new Error(`${instance} is not waiting for an answer`);
    await this.o.store.write({
      id: answerId(instance, s.lastAttempt),
      type: 'answer',
      status: 'open',
      produced_by: `human:${by}`,
      story,
      ...(instance.split(':')[2] ? { repo: instance.split(':')[2] } : {}),
      body: text,
    });
  }

  /** Inputs for a resumed session: the instance's current inputs plus its open rework. */
  private currentInputs(story: StoryInput, rc: ResolvedContract, repo: string | undefined, artifacts: Artifact[], stale: Set<string>) {
    const inputs = collectInputs(rc.contract, story.key, repo, artifacts, stale, story.repos);
    if ('missing' in inputs) return undefined;
    const reworkInputs = artifacts.filter((a) => a.envelope.status === 'open' && isReworkFor(rc.contract, a, story.key, repo));
    return { inputs: inputs.artifacts, reworkInputs };
  }

  private async dispatch(
    story: string,
    d: Extract<Decision, { action: 'run' }>,
    attempt: number,
    state: StoryReplay,
    resumeSessionId?: string,
  ): Promise<TickReport['dispatched'][number]> {
    const { store, events, runner, workflow } = this.o;
    const c = d.contract.contract;
    this.running.add(d.instance);
    try {
      const resumed = resumeSessionId !== undefined;
      await events.append({
        story,
        type: resumed ? 'attempt.resumed' : 'attempt.dispatched',
        instance: d.instance,
        attempt,
        ...(resumeSessionId ? { session_id: resumeSessionId } : {}),
        data: { reason: d.reason },
      });
      const workdir = await this.worktrees.prepare({ instance: d.instance, story, ...(d.repo ? { repo: d.repo } : {}), attempt });
      const repoCfg = d.repo ? workflow.overlay.repos[d.repo] : undefined;
      const result = await runner.run({
        instance: d.instance,
        contractId: c.id,
        agent: c.agent,
        story,
        ...(d.repo ? { repo: d.repo } : {}),
        attempt,
        workdir,
        inputs: d.inputs,
        reworkInputs: d.reworkInputs,
        policy: {
          tools: c.tools,
          ...(d.contract.overlay.model ? { model: d.contract.overlay.model } : {}),
          maxTurns: d.contract.maxTurns,
          writeAllow: c.write_allow,
          writeDeny: c.write_deny,
        },
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      const base = { story, instance: d.instance, attempt, session_id: result.sessionId };

      if (result.status === 'waiting') {
        await events.append({ ...base, type: 'attempt.waiting', data: { question: result.question } });
        return { instance: d.instance, attempt, result: 'waiting', resumed };
      }
      if (result.status === 'failed') {
        await events.append({ ...base, type: 'attempt.failed', data: { reason: result.reason } });
        await this.escalateIfNeeded(story, d.instance, state, 'failed');
        return { instance: d.instance, attempt, result: 'failed', resumed };
      }

      const drafts = new Map<string, OutputDraft>(result.outputs.map((o) => [`${o.type}|${o.repo ?? ''}`, o]));
      const issues = c.outputs.flatMap((o) => validateOutput(o, drafts.get(`${o.type}|${o.scope === 'repo' ? (d.repo ?? '') : ''}`)?.body));
      if (issues.length) {
        await events.append({ ...base, type: 'validation.failed', data: { issues } });
        await this.escalateIfNeeded(story, d.instance, state, 'validation failed');
        return { instance: d.instance, attempt, result: 'rejected', resumed };
      }

      const proposal = d.inputs.find((a) => a.envelope.type === 'proposal' && a.envelope.status === 'approved');
      const violations = checkWriteScope({
        changedFiles: result.changedFiles,
        writeAllow: c.write_allow,
        writeDeny: c.write_deny,
        sensitivePaths: workflow.overlay.security.sensitive_paths,
        unlocked: proposal ? parseSensitiveChanges(proposal.body) : [],
        vars: { test_dirs: repoCfg?.test_dirs ?? [] },
      });
      if (violations.length) {
        await events.append({ ...base, type: 'scope.violation', data: { violations } });
        await this.escalateIfNeeded(story, d.instance, state, 'write scope violated');
        return { instance: d.instance, attempt, result: 'rejected', resumed };
      }

      const derived = [...d.inputs, ...d.reworkInputs].map(pin);
      for (const o of c.outputs) {
        const repo = o.scope === 'repo' ? d.repo : undefined;
        const draft = drafts.get(`${o.type}|${repo ?? ''}`);
        if (!draft) continue;
        const written = await store.write({
          id: artifactId(o.type, story, repo),
          type: o.type,
          status: o.status,
          produced_by: `${c.id}#${attempt}`,
          story,
          ...(repo ? { repo } : {}),
          derived_from: derived,
          body: draft.body,
        });
        await events.append({ ...base, type: 'artifact.written', data: { artifact: written.envelope.id, version: written.envelope.version } });
      }
      for (const r of d.reworkInputs) await store.setStatus(story, r.envelope.id, 'consumed');
      await events.append({ ...base, type: 'attempt.finished', data: { ai_credits: result.aiCredits ?? null, changed_files: result.changedFiles.length } });
      return { instance: d.instance, attempt, result: 'done', resumed };
    } finally {
      this.running.delete(d.instance);
    }
  }

  private async escalateIfNeeded(story: string, instance: string, state: StoryReplay, reason: string): Promise<void> {
    const failures = (state.instances.get(instance)?.failures ?? 0) + 1;
    if (failures >= this.maxFailures) {
      await this.o.events.append({ story, type: 'instance.blocked', instance, data: { reason: `${reason} ${failures} times in a row` } });
    }
  }
}
