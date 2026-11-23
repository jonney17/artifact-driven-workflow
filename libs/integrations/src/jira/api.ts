/**
 * The Jira operations the engine needs, over a normalised issue shape. Two implementations:
 * `JiraRestClient` (real Jira, REST v2) and `FakeJira` (in memory, for tests).
 * Only the engine holds a JiraApi; agents never do (invariant).
 */
export interface JiraUser {
  accountId: string;
  email?: string;
  displayName?: string;
}

export interface JiraLink {
  /** Link type name, e.g. "Blocks", "Split". */
  type: string;
  /** The phrase from this issue's side, e.g. "is blocked by", "split from". */
  phrase: string;
  key: string;
}

export interface JiraRemoteLink {
  globalId?: string;
  url: string;
  title: string;
  relationship?: string;
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  body: string;
  created: string;
  properties?: Record<string, unknown>;
}

export interface JiraSprint {
  id: number;
  name?: string;
  state: 'active' | 'future' | 'closed';
}

export interface JiraIssue {
  key: string;
  issuetype: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  resolution?: string;
  assignee?: JiraUser;
  priority?: string;
  labels: string[];
  sprints: JiraSprint[];
  /** The Topic (Epic) key, from the configured topic field (Epic Link) or the parent. */
  epicKey?: string;
  /** Raw text of the configured acceptance-criteria field. */
  acceptanceCriteria?: string;
  links: JiraLink[];
  updated: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: string;
}

export interface NewIssue {
  project: string;
  issuetype: string;
  summary: string;
  description: string;
  parent?: string;
  labels?: string[];
}

export interface JiraApi {
  myself(): Promise<JiraUser>;
  search(jql: string): Promise<JiraIssue[]>;
  getIssue(key: string): Promise<JiraIssue | undefined>;
  getComments(key: string): Promise<JiraComment[]>;
  /** Adds a comment; `properties` are hidden entity properties (used for idempotency markers). */
  addComment(key: string, body: string, properties?: Record<string, unknown>): Promise<JiraComment>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  transition(key: string, transitionId: string): Promise<void>;
  getRemoteLinks(key: string): Promise<JiraRemoteLink[]>;
  /** Creates or updates a remote link; Jira upserts by `globalId`, which makes it idempotent. */
  upsertRemoteLink(key: string, link: JiraRemoteLink & { globalId: string }): Promise<void>;
  createIssue(issue: NewIssue): Promise<string>;
  linkIssues(type: string, inwardKey: string, outwardKey: string): Promise<void>;
}
