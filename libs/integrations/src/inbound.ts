import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '@sdlc/orchestrator';
import type { ConfluenceConfig, JiraConfig, LifecycleConfig } from './config';
import type { ConfluenceApi } from './confluence/api';
import { prdArtifactBody, prdPageId } from './confluence/prd';
import type { JiraApi, JiraIssue } from './jira/api';
import { classify, dependsOn, intakeJql, type LifecycleState, repoHints, splitFrom, storyArtifactBody } from './jira/intake';
import { fenceUntrusted } from './untrusted';

export interface IntakeItem {
  key: string;
  state: LifecycleState;
  /** True the first time a state is seen, so callers act once (e.g. close MRs on cancel). */
  changed: boolean;
  issue: JiraIssue;
  repoHints: string[];
  dependsOn: string[];
  splitFrom?: string;
}

interface JiraState {
  state: LifecycleState;
  /** The active sprint (name or id), for sprint rollups. */
  sprint?: string;
  status: string;
  updated: string;
  splitFrom?: string;
}

export interface InboundOptions {
  jira: JiraConfig;
  lifecycle: LifecycleConfig;
  confluence?: ConfluenceConfig;
  owner: 'assignee' | 'all';
  /** Affected repos of a story (from the Planner's output, else the Jira hints). */
  reposOf: (key: string, hints: string[]) => Promise<string[]>;
  idPatterns?: { requirement?: string };
}

/**
 * Jira and Confluence → artifacts (plan §3 "Inbound", §3b). Writes `story-<KEY>` (a new version only when
 * Jira content changes, so staleness cascades), `topic-prd-<KEY>` from the Epic's PRD page, a split
 * reference for split stories, and reopen defects. Tracks each story's lifecycle in `stories/<KEY>/jira.json`.
 */
export class JiraInbound {
  constructor(
    private readonly jira: JiraApi,
    private readonly store: ArtifactStore,
    private readonly o: InboundOptions,
    private readonly confluence?: ConfluenceApi,
  ) {}

  private statePath = (key: string) => join(this.store.storyDir(key), 'jira.json');

  private async readState(key: string): Promise<JiraState | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath(key), 'utf8')) as JiraState;
    } catch {
      return undefined;
    }
  }

  private async writeState(key: string, s: JiraState) {
    await mkdir(this.store.storyDir(key), { recursive: true });
    await writeFile(this.statePath(key), JSON.stringify(s, null, 2) + '\n', 'utf8');
  }

  /**
   * Runs the intake query, plus a lookup of stories this engine already tracks that dropped out of it
   * (moved sprint, backlog, cancelled, done, reassigned). Reassigned stories are returned as not owned.
   */
  async intake(known: string[]): Promise<IntakeItem[]> {
    const me = await this.jira.myself();
    const found = await this.jira.search(intakeJql(this.o.jira, this.o.owner));
    const byKey = new Map(found.map((i) => [i.key, i]));
    for (const key of known) {
      if (byKey.has(key)) continue;
      const i = await this.jira.getIssue(key);
      if (i && (this.o.owner === 'all' || i.assignee?.accountId === me.accountId)) byKey.set(key, i);
    }

    const items: IntakeItem[] = [];
    for (const issue of byKey.values()) {
      const prev = await this.readState(issue.key);
      const artifacts = await this.store.list(issue.key);
      const inFlight = artifacts.some((a) => a.envelope.produced_by.startsWith(`${this.o.lifecycle.in_flight_after}#`));
      const state = classify(issue, { inFlight, wasDone: prev?.state === 'done' }, this.o.lifecycle);
      const hints = repoHints(issue, this.o.jira);
      const comments = await this.jira.getComments(issue.key);
      const original = splitFrom(issue, comments, this.o.lifecycle);

      await this.store.write({
        id: `story-${issue.key}`,
        type: 'story',
        status: 'ready',
        produced_by: 'engine:jira',
        story: issue.key,
        body: storyArtifactBody(issue, this.o.jira),
      });
      if (state === 'active' || state === 'reopened') await this.syncPrd(issue);
      if (original && this.o.lifecycle.split.reference_inputs && prev?.splitFrom !== original) await this.writeSplitReference(issue.key, original);
      if (state === 'reopened') {
        const reason = [...comments].reverse().find((c) => c.author?.accountId !== me.accountId)?.body ?? 'Reopened without a comment';
        const repos = await this.o.reposOf(issue.key, hints);
        const n = artifacts.filter((a) => a.envelope.type === 'defect' && a.envelope.id.includes('-reopen-')).length / Math.max(1, repos.length) + 1;
        for (const repo of repos) {
          await this.store.write({
            id: `defect-${issue.key}-${repo}-reopen-${n}`,
            type: 'defect',
            status: 'open',
            produced_by: 'engine:jira',
            story: issue.key,
            repo,
            body: `# Defect: ${issue.key} reopened after Done\n\nFix on a new branch from main with a new MR.\n\n## Reason (from the reopening comment)\n\n${fenceUntrusted(reason, 'jira')}\n`,
          });
        }
      }

      const active = issue.sprints.find((s) => s.state === 'active');
      const sprint = active ? (active.name ?? String(active.id)) : prev?.sprint;
      const next: JiraState = { state: state === 'reopened' ? 'active' : state, status: issue.status, updated: issue.updated, ...(sprint ? { sprint } : {}), ...(original ? { splitFrom: original } : {}) };
      const changed = prev?.state !== state;
      await this.writeState(issue.key, next);
      items.push({ key: issue.key, state, changed, issue, repoHints: hints, dependsOn: dependsOn(issue), ...(original ? { splitFrom: original } : {}) });
    }
    return items;
  }

  /** The Topic's PRD snapshot for a story; a new page version means a new artifact version (staleness). */
  private async syncPrd(issue: JiraIssue): Promise<void> {
    if (!this.confluence || !this.o.confluence || !issue.epicKey) return;
    const from = this.o.confluence.prd_link.from === 'epic' ? issue.epicKey : issue.key;
    const pageId = prdPageId(await this.jira.getRemoteLinks(from), this.o.confluence.prd_link.issue_link);
    if (!pageId) return;
    const page = await this.confluence.getPage(pageId);
    if (!page) return;
    const body = prdArtifactBody(issue.epicKey, page, this.o.idPatterns?.requirement);
    // shared, immutable snapshot per page version: any engine may write it without conflicts (plan §2)
    const topicDir = join(this.store.root, 'topics', issue.epicKey);
    await mkdir(topicDir, { recursive: true });
    await writeFile(join(topicDir, `prd-v${page.version}.md`), body, 'utf8');
    await this.store.write({ id: `topic-prd-${issue.key}`, type: 'topic-prd', status: 'ready', produced_by: 'engine:confluence', story: issue.key, body });
  }

  /** Read-only reference to the original story's work, an extra input for the Planner (plan §3b). */
  private async writeSplitReference(key: string, original: string): Promise<void> {
    const orig = await this.store.list(original);
    const parts = orig.filter((a) => ['proposal', 'decisions', 'mr'].includes(a.envelope.type));
    await this.store.write({
      id: `split-ref-${key}`,
      type: 'split-ref',
      status: 'ready',
      produced_by: 'engine:jira',
      story: key,
      body: [`# Split from ${original}`, '', 'Read-only: the original story\'s change folders, decisions and MR links.', '', ...parts.map((a) => `## ${a.envelope.id} (v${a.envelope.version})\n\n${a.body}`)].join('\n'),
    });
  }
}
