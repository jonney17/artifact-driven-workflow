import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitLabConfig } from '../config';
import type { GitLabApi, MergeRequest } from './api';

const exec = promisify(execFile);

export interface ReviewFinding {
  /** e.g. `src/api/Invoice.java:42` */
  where?: string;
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  text: string;
}

export const SENSITIVE_LABEL = 'sdlc-sensitive';
export const WAITING_UPSTREAM_LABEL = 'sdlc-waiting-upstream';

/** Hidden marker in a thread body, so a retry finds the thread it already posted (plan §2). */
const marker = (eventId: string, n: number) => `<!-- sdlc:${eventId}:${n} -->`;

/** What the engine does on GitLab (plan §3a): one Draft MR per Story × repo, review threads, ready, close. */
export class MrSync {
  constructor(
    private readonly gl: GitLabApi,
    private readonly cfg: GitLabConfig,
    private readonly opts: { dryRun?: boolean } = {},
  ) {}

  /** Opens the Draft MR for a story branch, or returns the open one. Idempotent across retries and restarts. */
  async ensureDraftMr(a: {
    project: string;
    story: string;
    repo: string;
    targetBranch: string;
    title: string;
    description: string;
    sensitive: boolean;
  }): Promise<MergeRequest | undefined> {
    const branch = `${a.story}/${a.repo}`;
    const existing = await this.gl.findOpenMr(a.project, branch);
    if (existing) return existing;
    if (this.opts.dryRun) return undefined;
    return this.gl.createMr({
      project: a.project,
      sourceBranch: branch,
      targetBranch: a.targetBranch,
      title: `${a.story}: ${a.title}`,
      description: a.description,
      draft: true,
      labels: [...this.cfg.mr.labels, ...(a.sensitive ? [SENSITIVE_LABEL] : [])],
    });
  }

  /** Posts review findings as threads, once each. Never approves. Returns how many were new. */
  async postReview(mr: MergeRequest, eventId: string, findings: ReviewFinding[]): Promise<number> {
    const notes = await this.gl.listNotes(mr.project, mr.iid);
    let posted = 0;
    for (const [i, f] of findings.entries()) {
      const m = marker(eventId, i);
      if (notes.some((n) => n.body.includes(m))) continue;
      const body = `[sdlc Code Reviewer] **${f.severity}**${f.where ? ` \`${f.where}\`` : ''}: ${f.text}\n\n${m}`;
      if (!this.opts.dryRun) await this.gl.createThread(mr.project, mr.iid, body);
      posted++;
    }
    return posted;
  }

  /** Removes Draft (after QE (c) passes, `draft_until: qe_pass`). */
  async markReady(mr: MergeRequest): Promise<void> {
    if (mr.draft && !this.opts.dryRun) await this.gl.setDraft(mr.project, mr.iid, false);
  }

  /** Keeps a downstream MR labelled "waiting for upstream merge" until every upstream MR is merged. */
  async syncUpstreamLabel(mr: MergeRequest, upstreamPending: string[]): Promise<void> {
    const has = mr.labels.includes(WAITING_UPSTREAM_LABEL);
    const want = upstreamPending.length > 0;
    if (has === want || this.opts.dryRun) return;
    await this.gl.setLabels(mr.project, mr.iid, want ? [...mr.labels, WAITING_UPSTREAM_LABEL] : mr.labels.filter((l) => l !== WAITING_UPSTREAM_LABEL));
  }

  /** Cancelled story (plan §3b): close MRs with a comment; branches are kept. */
  async closeForCancel(mr: MergeRequest, reason: string): Promise<void> {
    if (mr.state !== 'opened' || this.opts.dryRun) return;
    await this.gl.createThread(mr.project, mr.iid, `[sdlc] Story cancelled in Jira (${reason}). Closing this MR; the branch is kept.`);
    await this.gl.closeMr(mr.project, mr.iid);
  }
}

/** Repos whose MRs must merge before `repo`'s (plan §3a, merge order from `depends_on`). */
export function upstreamPending(repo: string, deps: Record<string, string[]>, mrState: Record<string, MergeRequest['state'] | undefined>): string[] {
  return (deps[repo] ?? []).filter((up) => mrState[up] !== 'merged');
}

/**
 * Pushes an attempt's worktree to its story branch with the developer's own git credentials. The
 * engine process has them; agent sessions don't (plan §5b). `--force-with-lease` because a rebase
 * rework rewrites the branch.
 */
export async function pushBranch(worktree: string, branch: string, remote = 'origin'): Promise<void> {
  await exec('git', ['push', '--quiet', '--force-with-lease', remote, `HEAD:refs/heads/${branch}`], { cwd: worktree, windowsHide: true });
}
