import type { Artifact } from '@sdlc/contracts';
import type { AttemptResult, Runner } from '@sdlc/runtimes';
import { type EventLog, replay, type StoryReplay } from './recovery';
import type { ResolvedContract, ResolvedWorkflow } from './resolve';
import { findStale } from './stale';
import { type ArtifactStore, pin } from './store';
import { collectInputs, type Decision, evaluate, isReworkFor } from './trigger';
import { checkWriteScope, parseSensitiveChanges } from './writescope';
import { planOutputs } from './outputs';
import { Semaphore } from './semaphore';
import type { BudgetGuard } from './budget';

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
  /** Shared session slots for the whole machine; defaults to `limits.concurrency`. */
  slots?: Semaphore;
  /** Environments the engine starts around attempts of contracts that name one (plan §4a). */
  environments?: Record<string, Environment>;
  /** AI-credit limits (plan §5a). Without it, nothing is enforced. */
  budget?: BudgetGuard;
}

/** Something the engine starts before an attempt and stops after it, e.g. the local stack for QE (c). */
export interface Environment {
  /** Starts (or joins) the environment; resolves to its release function and base URL. Throws if it can't start. */
  acquire(ctx: { story: string; instance: string; repos: string[] }): Promise<{ release: () => Promise<void>; baseUrl?: string }>;
}

export interface StoryInput {
  key: string;
  repos: string[];
  /** Whether this engine holds the story lease (see LeaseManager). */
  owned: boolean;
}

export interface TickReport {
  /** Set when no new session started because of the story budget or the personal reserve. */
  budgetStop?: string;
  decisions: Decision[];
  dispatched: { instance: string; attempt: number; result: AttemptResult['status'] | 'rejected'; resumed: boolean }[];
}

/** Sensitive paths the approved proposal among the inputs unlocks (plan §5b). */
function unlockedPaths(inputs: Artifact[]): string[] {
  const proposal = inputs.find((a) => a.envelope.type === 'proposal' && a.envelope.status === 'approved');
  return proposal ? parseSensitiveChanges(proposal.body) : [];
}

/** Maps `shell:<name>` tools to the repo's configured commands (`repos.<repo>.build` …). */
function shellCommands(tools: string[], repo: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) {
    const name = t.startsWith('shell:') ? t.slice(6) : undefined;
    const cmd = name && repo?.[name];
    if (name && typeof cmd === 'string') out[name] = cmd;
  }
  return out;
}

/** Changes whenever the story's budget is raised, so a new block/warning can be recorded after a raise. */
function storyLimitKey(events: { type: string }[]): number {
  return events.filter((e) => e.type === 'budget.raised').length;
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
  private readonly slots: Semaphore;

  constructor(private readonly o: EngineOptions) {
    this.slots = o.slots ?? new Semaphore(o.workflow.limits.concurrency);
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

    // Budget (plan §5a): limits apply when a new session starts; running sessions are never cut off.
    let budgetStop: string | undefined;
    if (this.o.budget && story.owned && (resumable.length || decisions.some((d) => d.action === 'run'))) {
      const allEvents = await events.read(story.key);
      const check = await this.o.budget.check(allEvents);
      if (!check.ok) {
        budgetStop = check.reason;
        const id = `budget:${story.key}:${check.reason}:${storyLimitKey(allEvents)}`;
        if (check.reason === 'story budget' && !state.seen.has(id)) {
          await events.append({ id, story: story.key, type: 'instance.blocked', data: { reason: 'blocked: budget', budget: true } });
        }
      } else if (check.warn) {
        const id = `budget-warn:${story.key}:${check.warn}:${storyLimitKey(allEvents)}`;
        if (!state.seen.has(id)) await events.append({ id, story: story.key, type: 'budget.warning', data: { kind: check.warn } });
      }
    }

    // Resumes first: a human answered, so that branch continues in the same session (plan §6).
    const jobs: (() => Promise<TickReport['dispatched'][number]>)[] = [];
    if (story.owned && !budgetStop) {
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
      if (d.action !== 'run' || budgetStop) continue;
      const s = state.instances.get(d.instance);
      // An attempt that was dispatched but never finished (crash) keeps its number; anything else is a new attempt.
      const attempt = s?.state === 'running' ? s.lastAttempt : (s?.lastAttempt ?? 0) + 1;
      jobs.push(() => this.dispatch(story.key, d, attempt, state));
    }

    const dispatched = await Promise.all(jobs.map((j) => this.slots.run(j)));
    return { decisions, dispatched, ...(budgetStop ? { budgetStop } : {}) };
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
  /** `sdlc budget raise <KEY> <n>` (plan §5a): more AI credits for one story; unblocks a `blocked: budget` story. */
  async raiseBudget(story: string, amount: number, by: string): Promise<void> {
    if (!(amount > 0)) throw new Error('amount must be positive');
    await this.o.events.append({ story, type: 'budget.raised', data: { amount, by } });
  }

  /**
   * A human passes a gate on an artifact (plan §2 "Gates"): role-checked by the caller (CLI, Web UI or
   * Jira sync) against `members`. The artifact must be waiting for it (status `ready`).
   */
  async passGate(story: string, artifactId: string, by: string): Promise<void> {
    const a = await this.o.store.get(story, artifactId);
    if (!a) throw new Error(`${artifactId} not found`);
    if (a.envelope.status !== 'ready') throw new Error(`${artifactId} is ${a.envelope.status}, not waiting for a gate`);
    await this.o.store.setStatus(story, artifactId, 'approved');
    await this.o.events.append({ id: `gate:${artifactId}:v${a.envelope.version}:pass`, story, type: 'gate.passed', data: { artifact: artifactId, version: a.envelope.version, by } });
  }

  /** A human rejects a gate: the artifact becomes `rejected` and its producer gets `<type>-feedback` as rework. */
  async rejectGate(story: string, artifactId: string, by: string, feedback: string): Promise<void> {
    const a = await this.o.store.get(story, artifactId);
    if (!a) throw new Error(`${artifactId} not found`);
    await this.o.store.setStatus(story, artifactId, 'rejected');
    const type = `${a.envelope.type}-feedback`;
    const base = `${type}-${story}${a.envelope.repo ? `-${a.envelope.repo}` : ''}`;
    const n = (await this.o.store.list(story)).filter((x) => x.envelope.id.startsWith(`${base}-`)).length + 1;
    await this.o.store.write({
      id: `${base}-${n}`,
      type,
      status: 'open',
      produced_by: `human:${by}`,
      story,
      ...(a.envelope.repo ? { repo: a.envelope.repo } : {}),
      derived_from: [pin(a)],
      body: `# Gate rejected: ${artifactId} v${a.envelope.version}\n\n${feedback}\n`,
    });
    await this.o.events.append({ story, type: 'gate.rejected', data: { artifact: artifactId, version: a.envelope.version, by } });
  }

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
      let release: (() => Promise<void>) | undefined;
      let environmentUrl: string | undefined;
      if (c.environment) {
        const env = this.o.environments?.[c.environment];
        try {
          if (!env) throw new Error(`environment ${c.environment} is not configured`);
          const acquired = await env.acquire({ story, instance: d.instance, repos: [...new Set(d.inputs.flatMap((a) => (a.envelope.repo ? [a.envelope.repo] : [])))] });
          release = acquired.release;
          environmentUrl = acquired.baseUrl;
        } catch (e) {
          await events.append({ story, instance: d.instance, attempt, type: 'attempt.failed', data: { reason: `environment ${c.environment}: ${(e as Error).message}`, environment: true } });
          await this.escalateIfNeeded(story, d.instance, state, 'environment failed');
          return { instance: d.instance, attempt, result: 'failed', resumed };
        }
      }
      const result = await runner
        .run({
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
          sensitivePaths: workflow.overlay.security.sensitive_paths,
          unlocked: unlockedPaths(d.inputs),
          vars: { test_dirs: repoCfg?.test_dirs ?? [] },
          shellCommands: shellCommands(c.tools, repoCfg),
          networkAllow: workflow.overlay.security.network.allow,
          ...(environmentUrl ? { environmentUrl } : {}),
        },
        ...(resumeSessionId ? { resumeSessionId } : {}),
        })
        .finally(() => release?.());
      const base = { story, instance: d.instance, attempt, session_id: result.sessionId };
      if (result.status === 'done' && result.aiCredits) await this.o.budget?.record(result.aiCredits);

      if (result.status === 'waiting') {
        await events.append({ ...base, type: 'attempt.waiting', data: { question: result.question } });
        return { instance: d.instance, attempt, result: 'waiting', resumed };
      }
      if (result.status === 'failed') {
        await events.append({ ...base, type: 'attempt.failed', data: { reason: result.reason } });
        await this.escalateIfNeeded(story, d.instance, state, 'failed');
        return { instance: d.instance, attempt, result: 'failed', resumed };
      }

      const existing = await store.list(story);
      const { issues, writes } = planOutputs({
        contract: c,
        gateMode: d.contract.gateMode,
        story,
        ...(d.repo ? { instanceRepo: d.repo } : {}),
        drafts: result.outputs,
        existing,
      });
      if (issues.length) {
        await events.append({ ...base, type: 'validation.failed', data: { issues } });
        await this.escalateIfNeeded(story, d.instance, state, 'validation failed');
        return { instance: d.instance, attempt, result: 'rejected', resumed };
      }

      const violations = checkWriteScope({
        changedFiles: result.changedFiles,
        writeAllow: c.write_allow,
        writeDeny: c.write_deny,
        sensitivePaths: workflow.overlay.security.sensitive_paths,
        unlocked: unlockedPaths(d.inputs),
        vars: { test_dirs: repoCfg?.test_dirs ?? [] },
      });
      if (violations.length) {
        await events.append({ ...base, type: 'scope.violation', data: { violations } });
        await this.escalateIfNeeded(story, d.instance, state, 'write scope violated');
        return { instance: d.instance, attempt, result: 'rejected', resumed };
      }

      // Only regular inputs are pinned. Rework inputs are one-shot (marked consumed below); pinning them
      // would make the output stale as soon as the reviewer re-runs on it (a cycle through the review).
      const derived = d.inputs.map(pin);
      for (const w of writes) {
        const written = await store.write({
          id: w.id,
          type: w.type,
          status: w.status,
          produced_by: `${c.id}#${attempt}`,
          story,
          ...(w.repo ? { repo: w.repo } : {}),
          derived_from: derived,
          body: w.body,
        });
        await events.append({ ...base, type: 'artifact.written', data: { artifact: written.envelope.id, version: written.envelope.version, status: w.status } });
        if (w.rework) {
          const r = await store.write({
            id: w.rework.id,
            type: w.rework.type,
            status: 'open',
            produced_by: `${c.id}#${attempt}`,
            story,
            ...(w.rework.repo ? { repo: w.rework.repo } : {}),
            derived_from: [pin(written)],
            body: w.body,
          });
          await events.append({ ...base, type: 'artifact.written', data: { artifact: r.envelope.id, version: r.envelope.version, status: 'open' } });
        }
      }
      for (const r of d.reworkInputs) await store.setStatus(story, r.envelope.id, 'consumed');
      await events.append({ ...base, type: 'attempt.finished', data: { ai_credits: result.aiCredits ?? null, changed_files: result.changedFiles.length, consumed: d.reworkInputs.map((r) => r.envelope.id) } });
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
