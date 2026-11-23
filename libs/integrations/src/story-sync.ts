import { type ArtifactStore, type Engine, type EventLog, parseSensitiveChanges, replay, type StatusRule, storyRepos, storyStatus, type TickReport } from '@sdlc/orchestrator';
import type { Artifact } from '@sdlc/contracts';
import type { JiraConfig, LifecycleConfig, Members } from './config';
import type { GitLabApi, MergeRequest } from './gitlab/api';
import { MrSync, type ReviewFinding, pushBranch } from './gitlab/mr-sync';
import type { JiraApi } from './jira/api';
import { JiraOutbound, readJiraGates, type StatusKey } from './jira/outbound';
import type { IntakeItem, JiraInbound } from './inbound';
import { type Notifier, type Question, QuestionRouter } from '@sdlc/runtimes';

export interface RepoTarget {
  /** Local clone; story branches live here (worktrees share its refs). */
  path: string;
  gitlabProject: string;
  branch: string;
}

export interface StorySyncOptions {
  store: ArtifactStore;
  events: EventLog;
  engine: Engine;
  inbound: JiraInbound;
  jira: JiraApi;
  jiraCfg: JiraConfig;
  lifecycle: LifecycleConfig;
  gitlab: GitLabApi;
  mr: MrSync;
  outbound: JiraOutbound;
  repos: Record<string, RepoTarget>;
  members: Members;
  statusRules: StatusRule[];
  /** QE (c) preprod check waits for this job on the target branch after merge (Q19: `deploy_preprod`). */
  preprodJob?: string;
  /** `ask_human` router: Jira replies `/sdlc answer Q-n …` from the routed person answer questions (plan §6). */
  questions?: QuestionRouter;
  /** Push story branches from the repo clone (default: real git push with the dev's own credentials). */
  push?: (repoPath: string, branch: string) => Promise<void>;
  dryRun?: boolean;
}

/** Parses review findings: `- **major** \`path:42\`: text`. */
export function parseFindings(body: string): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*[-*]\s+\*\*(blocker|major|minor|nit)\*\*\s*(?:`([^`]+)`)?\s*:?\s*(.+)$/i.exec(line);
    if (m) out.push({ severity: m[1]!.toLowerCase() as ReviewFinding['severity'], ...(m[2] ? { where: m[2] } : {}), text: m[3]!.trim() });
  }
  return out;
}

/**
 * The engine's sync around each tick (plan §2 loop steps 2 and 10, §3, §3a). Implements the
 * `EngineLoop` hooks. Everything it writes outside is idempotent, so a crash between steps is safe.
 */
export class StorySync {
  private intakeCache = new Map<string, IntakeItem>();

  constructor(private readonly o: StorySyncOptions) {}

  /** `LoopHooks.assigned`: Jira intake; returns the stories this engine should drive now. */
  async assigned(known: string[]) {
    const items = await this.o.inbound.intake(known);
    const out: { key: string; repos: string[] }[] = [];
    for (const item of items) {
      this.intakeCache.set(item.key, item);
      if (item.state === 'cancelled' && item.changed) await this.cancel(item);
      if (item.state === 'active' || item.state === 'reopened') {
        out.push({ key: item.key, repos: storyRepos(await this.o.store.list(item.key), item.repoHints) });
      }
    }
    return out;
  }

  private async cancel(item: IntakeItem) {
    for (const [repo, t] of Object.entries(this.o.repos)) {
      const mr = await this.o.gitlab.findOpenMr(t.gitlabProject, `${item.key}/${repo}`);
      if (mr) await this.o.mr.closeForCancel(mr, item.issue.status);
    }
    for (const a of await this.o.store.list(item.key)) {
      if (!['cancelled', 'consumed'].includes(a.envelope.status)) await this.o.store.setStatus(item.key, a.envelope.id, 'cancelled');
    }
  }

  private mrOf = async (story: string, repo: string): Promise<MergeRequest | undefined> => {
    const t = this.o.repos[repo];
    if (!t) return undefined;
    return (await this.o.gitlab.findOpenMr(t.gitlabProject, `${story}/${repo}`)) ?? (await this.mergedMr(story, repo));
  };

  private async mergedMr(story: string, repo: string): Promise<MergeRequest | undefined> {
    const a = await this.o.store.get(story, `mr-${story}-${repo}`);
    const iid = a && /iid: (\d+)/.exec(a.body)?.[1];
    const t = this.o.repos[repo];
    return iid && t ? this.o.gitlab.getMr(t.gitlabProject, Number(iid)) : undefined;
  }

  /** `LoopHooks.syncIn`: GitLab state → engine artifacts; gates passed in Jira → engine gates. */
  async syncIn(story: { key: string; repos: string[] }): Promise<void> {
    const { store, engine } = this.o;
    const key = story.key;
    let artifacts = await store.list(key);

    // gates passed in Jira (role-checked)
    const issue = this.intakeCache.get(key)?.issue ?? (await this.o.jira.getIssue(key));
    if (issue) {
      const comments = await this.o.jira.getComments(key);
      if (this.o.questions) {
        for (const c of comments) {
          const cmd = QuestionRouter.parseAnswerCommand(c.body);
          if (cmd && c.author?.email) await this.o.questions.answer(key, cmd.id, cmd.text, c.author.email);
        }
      }
      const gates = readJiraGates(issue, comments, this.o.jiraCfg, this.o.members);
      for (const a of artifacts) {
        if (a.envelope.status !== 'ready') continue;
        if (gates.story_acceptance && a.envelope.type === 'story-acceptance') await engine.passGate(key, a.envelope.id, 'jira:accepted');
        if (gates.scenario_approval && a.envelope.type === 'test-scenarios') await engine.passGate(key, a.envelope.id, gates.scenario_approval.by);
      }
    }

    // MR and pipeline state → mr / pipeline-failure / rebase artifacts
    const mrStates: Record<string, MergeRequest | undefined> = {};
    for (const repo of story.repos) {
      const mr = await this.mrOf(key, repo);
      mrStates[repo] = mr;
      if (!mr) continue;
      const pipeline = mr.pipeline?.status;
      const status = mr.state === 'merged' ? 'merged' : pipeline === 'success' ? 'pipeline_green' : pipeline === 'failed' ? 'pipeline_failed' : 'pipeline_running';
      await store.write({
        id: `mr-${key}-${repo}`,
        type: 'mr',
        status,
        produced_by: 'engine:gitlab',
        story: key,
        repo,
        body: `# MR ${repo}\n\n- url: ${mr.webUrl}\n- iid: ${mr.iid}\n- head: ${mr.headSha ?? 'unknown'}\n- pipeline: ${pipeline ?? 'none'}${mr.pipeline?.webUrl ? ` (${mr.pipeline.webUrl})` : ''}\n`,
      });
      const marker = `head: ${mr.headSha ?? '?'}`;
      if (pipeline === 'failed' && !artifacts.some((a) => a.envelope.type === 'pipeline-failure' && a.envelope.repo === repo && a.body.includes(marker))) {
        await this.rework(key, repo, 'pipeline-failure', `# Pipeline failed\n\n- ${marker}\n- log: ${mr.pipeline?.webUrl ?? 'see the MR'}\n\nFix the build, tests or lint so the MR pipeline is green.\n`);
      }
      if (mr.mergeStatus === 'cannot_be_merged' && mr.state === 'opened' && !artifacts.some((a) => a.envelope.type === 'rebase' && a.envelope.repo === repo && a.body.includes(marker))) {
        await this.rework(key, repo, 'rebase', `# Rebase needed\n\n- ${marker}\n\nThe MR can't merge cleanly into ${mr.targetBranch}. Rebase onto it and resolve the conflicts.\n`);
      }
    }

    // all merged + main deployed to preprod → merged
    artifacts = await store.list(key);
    const allMerged = story.repos.length > 0 && story.repos.every((r) => mrStates[r]?.state === 'merged');
    if (allMerged && !artifacts.some((a) => a.envelope.type === 'merged')) {
      const deployed = await this.preprodDeployed(story.repos, mrStates);
      if (deployed) {
        await store.write({ id: `merged-${key}`, type: 'merged', status: 'merged', produced_by: 'engine:gitlab', story: key, body: `# Merged and deployed to preprod\n\n${story.repos.map((r) => `- ${r}: ${mrStates[r]?.webUrl}`).join('\n')}\n` });
      }
    }
  }

  private async preprodDeployed(repos: string[], mrs: Record<string, MergeRequest | undefined>): Promise<boolean> {
    if (!this.o.preprodJob) return true;
    for (const r of repos) {
      const t = this.o.repos[r]!;
      const job = await this.o.gitlab.latestJob(t.gitlabProject, t.branch, this.o.preprodJob);
      const mergedAt = mrs[r]?.mergedAt;
      if (job?.status !== 'success' || (mergedAt && job.finishedAt && job.finishedAt < mergedAt)) return false;
    }
    return true;
  }

  private async rework(story: string, repo: string, type: string, body: string) {
    const n = (await this.o.store.list(story)).filter((a) => a.envelope.type === type && a.envelope.repo === repo).length + 1;
    await this.o.store.write({ id: `${type}-${story}-${repo}-${n}`, type, status: 'open', produced_by: 'engine:gitlab', story, repo, body });
  }

  /** `LoopHooks.syncOut`: branches and MRs on GitLab; status, comments, links and defects in Jira. */
  async syncOut(story: { key: string; repos: string[] }, _report?: TickReport): Promise<void> {
    const { store, mr, outbound } = this.o;
    const key = story.key;
    const artifacts = await store.list(key);
    const get = (type: string, repo?: string) => artifacts.find((a) => a.envelope.type === type && (repo === undefined || a.envelope.repo === repo) && a.envelope.status !== 'cancelled');

    // proposals waiting for the gate
    for (const p of artifacts.filter((a) => a.envelope.type === 'proposal' && a.envelope.status === 'ready')) {
      await outbound.comment(key, `proposal:${p.envelope.id}:v${p.envelope.version}`, `Proposal for ${p.envelope.repo} is ready for approval (v${p.envelope.version}).`);
    }

    for (const repo of story.repos) {
      const t = this.o.repos[repo];
      const code = get('code', repo);
      if (!t || !code) continue;
      // merged: never push again or open a second MR from the same branch (a later fix uses a new branch, see HANDOFF gaps)
      if (get('mr', repo)?.envelope.status === 'merged') continue;
      if (!this.o.dryRun) await (this.o.push ?? ((p, b) => pushBranch(p, b)))(t.path, `${key}/${repo}`);
      const proposal = get('proposal', repo);
      const description = get('mr-description', repo)?.body ?? code.body;
      const open = await mr.ensureDraftMr({
        project: t.gitlabProject,
        story: key,
        repo,
        targetBranch: t.branch,
        title: this.intakeCache.get(key)?.issue.summary ?? key,
        description,
        sensitive: proposal ? parseSensitiveChanges(proposal.body).length > 0 : false,
      });
      if (!open) continue;
      await outbound.linkMr(key, open.webUrl, `${repo} MR !${open.iid}`);

      const review = get('review', repo);
      if (review?.envelope.status === 'changes_requested') await mr.postReview(open, `review:${review.envelope.id}:v${review.envelope.version}`, parseFindings(review.body));
    }

    // QE (c) passed → MRs leave Draft (draft_until: qe_pass)
    const acceptance = get('story-acceptance');
    if (acceptance && ['ready', 'approved'].includes(acceptance.envelope.status)) {
      for (const repo of story.repos) {
        const t = this.o.repos[repo];
        const open = t && (await this.o.gitlab.findOpenMr(t.gitlabProject, `${key}/${repo}`));
        if (open) await mr.markReady(open);
      }
      if (acceptance.envelope.status === 'ready') {
        await outbound.comment(key, `acceptance:${acceptance.envelope.id}:v${acceptance.envelope.version}`, `QE passed: the acceptance pack is ready for the PO.\n\n${acceptance.body}`);
      }
    }

    // defects → Jira per defects.mode
    for (const d of artifacts.filter((a) => a.envelope.type === 'defect' && a.envelope.produced_by.startsWith('qe'))) {
      const title = /^#\s+(.+)$/m.exec(d.body)?.[1] ?? d.envelope.id;
      await outbound.createDefect(key, d.envelope.id, title, d.body);
    }

    // blocked instances and open questions → comments
    const state = replay(await this.o.events.read(key));
    for (const s of state.instances.values()) {
      if (s.state === 'blocked') await outbound.comment(key, `blocked:${s.instance}:a${s.lastAttempt}`, `${s.instance} is blocked and needs a human (see the Board).`);
    }

    // Jira status
    const status = storyStatus(artifacts, story.repos, this.o.statusRules);
    if (status) await outbound.transitionTo(key, status as StatusKey);
  }
}

export type { Artifact };

/**
 * Posts each question as a Jira comment for the routed people (plan §6: in local mode, people other
 * than the story owner answer by replying in Jira). Idempotent per question id.
 */
export class JiraQuestionNotifier implements Notifier {
  constructor(private readonly outbound: JiraOutbound) {}

  async notify(q: Question): Promise<void> {
    const who = q.people.length ? q.people.join(', ') : `the ${q.role}`;
    const text =
      q.status === 'assumed'
        ? `${q.id} (${q.instance}): proceeding with an assumption, to be checked by the Reviewer and QE.

Question: ${q.text}
Assumption: ${q.answer}`
        : `${q.id} for ${who} (${q.instance}):

${q.text}${q.options?.length ? `

Options: ${q.options.join(' | ')}` : ''}${q.recommended ? `
Recommended: ${q.recommended}` : ''}

Reply with: /sdlc answer ${q.id} <your answer>`;
    await this.outbound.comment(q.story, `question:${q.id}`, text);
  }
}
