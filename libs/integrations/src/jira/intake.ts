import type { JiraConfig, LifecycleConfig } from '../config';
import { fenceUntrusted } from '../untrusted';
import type { JiraComment, JiraIssue } from './api';

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

/**
 * Splits the AC field into criteria (plan §3). Bullets, numbered lines or plain lines each become one
 * criterion. Ids already in the text (`PAY-12-AC3`) are kept; the rest are numbered `<KEY>-AC<n>`.
 */
export function parseAcceptanceCriteria(text: string | undefined, key: string): AcceptanceCriterion[] {
  if (!text?.trim()) return [];
  const idRe = new RegExp(`^(${key.replace(/[-]/g, '\\-')}-AC\\d+)\\s*[:.)-]?\\s*`, 'i');
  const items = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•#]+|\d+[.)]|\(\d+\)|AC\s*\d+\s*[:.)-])\s*/i, '').trim())
    .filter(Boolean);
  const used = new Set<string>();
  const out: AcceptanceCriterion[] = [];
  for (const item of items) {
    const m = idRe.exec(item);
    if (m?.[1]) {
      used.add(m[1].toUpperCase());
      out.push({ id: m[1].toUpperCase(), text: item.slice(m[0].length).trim() });
    } else out.push({ id: '', text: item });
  }
  let n = 0;
  for (const c of out) {
    if (c.id) continue;
    do n++;
    while (used.has(`${key}-AC${n}`));
    c.id = `${key}-AC${n}`;
    used.add(c.id);
  }
  return out;
}

/** Repo hints from labels (`fields.repos: labels:repo-*` → label `repo-billing-api` → `billing-api`). */
export function repoHints(issue: JiraIssue, cfg: JiraConfig): string[] {
  const spec = cfg.fields.repos;
  if (!spec?.startsWith('labels:')) return [];
  const prefix = spec.slice('labels:'.length).replace(/\*$/, '');
  return issue.labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
}

export const dependsOn = (issue: JiraIssue) => issue.links.filter((l) => /is blocked by/i.test(l.phrase)).map((l) => l.key);

/** The `story-<KEY>` artifact body. Jira text is fenced as untrusted. */
export function storyArtifactBody(issue: JiraIssue, cfg: JiraConfig): string {
  const ac = parseAcceptanceCriteria(issue.acceptanceCriteria, issue.key);
  const deps = dependsOn(issue);
  const hints = repoHints(issue, cfg);
  return [
    `# ${issue.key}`,
    '',
    `- Summary: ${fenceInline(issue.summary)}`,
    `- Topic: ${issue.epicKey ?? 'none'}`,
    `- Priority: ${issue.priority ?? 'none'}`,
    `- Depends on: ${deps.length ? deps.join(', ') : 'none'}`,
    `- Repo hints: ${hints.length ? hints.join(', ') : 'none'}`,
    '',
    '## Description',
    '',
    fenceUntrusted(issue.description || '(empty)', 'jira'),
    '',
    '## Acceptance criteria',
    '',
    ...(ac.length ? ac.map((c) => `- **${c.id}**: ${fenceInline(c.text)}`) : ['(none: the Planner must ask the PO)']),
    '',
  ].join('\n');
}

const fenceInline = (s: string) => '`' + s.replace(/`/g, "'").replace(/\s+/g, ' ').trim() + '`';

export type LifecycleState = 'active' | 'held' | 'paused' | 'cancelled' | 'done' | 'reopened';

/** Where a story stands in its lifecycle (plan §3b). */
export function classify(issue: JiraIssue, ctx: { inFlight: boolean; wasDone: boolean }, lc: LifecycleConfig): LifecycleState {
  if (lc.cancel.statuses.includes(issue.status) || (issue.resolution && lc.cancel.resolutions.includes(issue.resolution))) return 'cancelled';
  if (issue.statusCategory === 'done') return 'done';
  if (ctx.wasDone) return 'reopened';
  if (issue.sprints.some((s) => s.state === 'active')) return 'active';
  if (issue.sprints.some((s) => s.state === 'future')) return ctx.inFlight && lc.carry_over === 'keep_in_flight' ? 'active' : 'held';
  return 'paused';
}

/** The original story of a split (plan §3b): a "split from" link, or a "split from <KEY>" comment. */
export function splitFrom(issue: JiraIssue, comments: JiraComment[], lc: LifecycleConfig): string | undefined {
  const link = issue.links.find((l) => l.phrase.toLowerCase() === lc.split.link_type.toLowerCase());
  if (link) return link.key;
  if (!lc.split.also_comment) return undefined;
  for (const c of comments) {
    const m = /\bsplit\s+from\s+([A-Z][A-Z0-9_]+-\d+)\b/i.exec(c.body);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return undefined;
}

/** The intake query for this engine (plan §2): the team's JQL plus `assignee = currentUser()` in local mode. */
export function intakeJql(cfg: JiraConfig, owner: 'assignee' | 'all'): string {
  return owner === 'assignee' ? `${cfg.intake_jql} AND assignee = currentUser()` : cfg.intake_jql;
}
