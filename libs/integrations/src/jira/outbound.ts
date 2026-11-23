import type { JiraConfig, Members } from '../config';
import { hasRole } from '../config';
import type { JiraApi, JiraComment, JiraIssue } from './api';

export const EVENT_PROPERTY = 'sdlc.event';

export type StatusKey = keyof JiraConfig['status_map'];

export type TransitionOutcome = 'transitioned' | 'already there' | 'not mapped' | 'no such transition' | 'protected';

/**
 * The engine's only writes to Jira (plan §3 "Outbound"), each idempotent:
 * transitions are skipped when Jira already has the status; comments carry a hidden
 * `sdlc.event` property and are skipped when one with the same event id exists;
 * remote links are upserted by global id; defects are recorded by a marked comment.
 */
export class JiraOutbound {
  constructor(
    private readonly jira: JiraApi,
    private readonly cfg: JiraConfig,
    private readonly opts: { jiraDevPanel: boolean; dryRun?: boolean } = { jiraDevPanel: false },
  ) {}

  /**
   * Moves the story to the mapped status. Never moves it out of a status a human set to pass a gate
   * (e.g. "Accepted"), except on to `done`: the engine must not undo a human's move.
   */
  async transitionTo(key: string, status: StatusKey): Promise<TransitionOutcome> {
    const target = this.cfg.status_map[status];
    if (!target) return 'not mapped';
    const issue = await this.jira.getIssue(key);
    if (issue?.status === target) return 'already there';
    const humanStatuses = [this.cfg.gates_from_jira.story_acceptance?.transition].filter(Boolean);
    if (issue && humanStatuses.includes(issue.status) && status !== 'done') return 'protected';
    const t = (await this.jira.getTransitions(key)).find((x) => x.to === target || x.name === target);
    if (!t) return 'no such transition';
    if (!this.opts.dryRun) await this.jira.transition(key, t.id);
    return 'transitioned';
  }

  private async findByEvent(key: string, eventId: string): Promise<JiraComment | undefined> {
    return (await this.jira.getComments(key)).find((c) => c.properties?.[EVENT_PROPERTY] === eventId || c.body.includes(`[sdlc:${eventId}]`));
  }

  /** Posts `[sdlc] <text>` once per event id. Returns false when it already exists. */
  async comment(key: string, eventId: string, text: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    if (await this.findByEvent(key, eventId)) return false;
    if (!this.opts.dryRun) await this.jira.addComment(key, `[sdlc] ${text}`, { [EVENT_PROPERTY]: eventId, ...extra });
    return true;
  }

  /** Adds an MR link to the story, unless GitLab's Jira integration shows MRs on the dev panel. */
  async linkMr(key: string, mrUrl: string, title: string): Promise<boolean> {
    if (this.opts.jiraDevPanel) return false;
    if (!this.opts.dryRun) await this.jira.upsertRemoteLink(key, { globalId: `sdlc:mr:${mrUrl}`, url: mrUrl, title });
    return true;
  }

  /** Creates a defect per `defects.mode`, once per event id. Returns the defect key (or the story key for `comment` mode). */
  async createDefect(key: string, eventId: string, summary: string, description: string): Promise<string> {
    const marker = `defect:${eventId}`;
    const existing = await this.findByEvent(key, marker);
    if (existing) return String(existing.properties?.['sdlc.defect'] ?? key);
    const { mode, issuetype } = this.cfg.defects;
    if (mode === 'comment' || this.opts.dryRun) {
      if (!this.opts.dryRun) await this.jira.addComment(key, `[sdlc] Defect: ${summary}\n\n${description}`, { [EVENT_PROPERTY]: marker, 'sdlc.defect': key });
      return key;
    }
    const project = key.split('-')[0]!;
    const defect = await this.jira.createIssue({
      project,
      issuetype: mode === 'subtask' ? issuetype : 'Bug',
      summary,
      description,
      ...(mode === 'subtask' ? { parent: key } : {}),
      labels: ['sdlc'],
    });
    if (mode === 'linked_bug') await this.jira.linkIssues('Relates', key, defect);
    await this.jira.addComment(key, `[sdlc] Defect ${defect} created: ${summary}`, { [EVENT_PROPERTY]: marker, 'sdlc.defect': defect });
    return defect;
  }
}

export interface JiraGates {
  story_acceptance?: { by?: string };
  scenario_approval?: { by: string; commentId: string };
}

/**
 * Gates a human passed in Jira (plan §2 "Gates", §3): the acceptance status, and a comment command
 * from someone with the configured role in `members`. Comments from anyone else are ignored.
 */
export function readJiraGates(issue: JiraIssue, comments: JiraComment[], cfg: JiraConfig, members: Members): JiraGates {
  const gates: JiraGates = {};
  const acc = cfg.gates_from_jira.story_acceptance;
  if (acc && issue.status === acc.transition) gates.story_acceptance = {};
  const sc = cfg.gates_from_jira.scenario_approval;
  if (sc) {
    const c = comments.find((x) => x.body.trim().toLowerCase().startsWith(sc.comment_command.toLowerCase()) && hasRole(members, x.author?.email, sc.role));
    if (c?.author?.email) gates.scenario_approval = { by: c.author.email, commentId: c.id };
  }
  return gates;
}
