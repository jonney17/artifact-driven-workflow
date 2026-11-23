import type { JiraApi, JiraComment, JiraIssue, JiraRemoteLink, JiraTransition, JiraUser, NewIssue } from './api';

/**
 * In-memory Jira for tests. It understands the JQL subset the engine uses: clauses joined by AND —
 * `project = X`, `issuetype = X`, `sprint in openSprints()`, `assignee = currentUser()`, `key in (A, B)`.
 * Transitions: any status in `statuses` is reachable from any other, named after the target status.
 */
export class FakeJira implements JiraApi {
  readonly issues = new Map<string, JiraIssue>();
  readonly comments = new Map<string, JiraComment[]>();
  readonly remoteLinks = new Map<string, (JiraRemoteLink & { globalId?: string })[]>();
  readonly calls: string[] = [];
  private seq = 0;

  constructor(
    readonly me: JiraUser = { accountId: 'u-bob', email: 'bob@corp', displayName: 'Bob' },
    readonly statuses: string[] = ['To Do', 'In Refinement', 'In Progress', 'In Review', 'In QA', 'Ready for Acceptance', 'Accepted', 'Done', 'Cancelled'],
  ) {}

  put(issue: Partial<JiraIssue> & { key: string }): JiraIssue {
    const prev = this.issues.get(issue.key);
    const full: JiraIssue = {
      issuetype: 'Story',
      summary: issue.key,
      description: '',
      status: 'To Do',
      statusCategory: 'new',
      labels: [],
      sprints: [{ id: 1, state: 'active' }],
      links: [],
      ...prev,
      ...issue,
      updated: new Date(Date.now() + ++this.seq).toISOString(),
    };
    this.issues.set(full.key, full);
    return full;
  }

  /** A human comment, as if typed in Jira. */
  humanComment(key: string, author: JiraUser, body: string): JiraComment {
    const c: JiraComment = { id: `c${++this.seq}`, author, body, created: new Date().toISOString() };
    this.comments.set(key, [...(this.comments.get(key) ?? []), c]);
    return c;
  }

  async myself() {
    return this.me;
  }

  async search(jql: string): Promise<JiraIssue[]> {
    this.calls.push(`search ${jql}`);
    const clauses = jql.split(/\s+AND\s+/i).map((c) => c.trim());
    return [...this.issues.values()].filter((i) =>
      clauses.every((c) => {
        let m: RegExpExecArray | null;
        if ((m = /^project\s*=\s*"?([\w-]+)"?$/i.exec(c))) return i.key.startsWith(`${m[1]}-`);
        if ((m = /^issuetype\s*=\s*"?([\w -]+?)"?$/i.exec(c))) return i.issuetype === m[1];
        if (/^sprint\s+in\s+openSprints\(\)$/i.test(c)) return i.sprints.some((s) => s.state === 'active');
        if (/^assignee\s*=\s*currentUser\(\)$/i.test(c)) return i.assignee?.accountId === this.me.accountId;
        if ((m = /^key\s+in\s*\(([^)]*)\)$/i.exec(c))) return m[1]!.split(',').map((k) => k.trim()).includes(i.key);
        throw new Error(`FakeJira: unsupported JQL clause: ${c}`);
      }),
    );
  }

  async getIssue(key: string) {
    return this.issues.get(key);
  }

  async getComments(key: string) {
    return this.comments.get(key) ?? [];
  }

  async addComment(key: string, body: string, properties?: Record<string, unknown>) {
    this.calls.push(`comment ${key}`);
    const c: JiraComment = { id: `c${++this.seq}`, author: this.me, body, created: new Date().toISOString(), ...(properties ? { properties } : {}) };
    this.comments.set(key, [...(this.comments.get(key) ?? []), c]);
    return c;
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const cur = this.issues.get(key)?.status;
    return this.statuses.filter((s) => s !== cur).map((s, i) => ({ id: String(i + 1), name: s, to: s }));
  }

  async transition(key: string, transitionId: string) {
    const t = (await this.getTransitions(key)).find((x) => x.id === transitionId);
    if (!t) throw new Error(`no transition ${transitionId} for ${key}`);
    this.calls.push(`transition ${key} → ${t.to}`);
    const cat = t.to === 'Done' || t.to === 'Cancelled' ? 'done' : t.to === 'To Do' ? 'new' : 'indeterminate';
    this.put({ key, status: t.to, statusCategory: cat });
  }

  async getRemoteLinks(key: string) {
    return this.remoteLinks.get(key) ?? [];
  }

  async upsertRemoteLink(key: string, link: JiraRemoteLink & { globalId: string }) {
    const links = (this.remoteLinks.get(key) ?? []).filter((l) => l.globalId !== link.globalId);
    this.remoteLinks.set(key, [...links, link]);
  }

  async createIssue(issue: NewIssue) {
    const key = `${issue.project}-${900 + ++this.seq}`;
    this.calls.push(`create ${issue.issuetype} ${key}${issue.parent ? ` under ${issue.parent}` : ''}`);
    this.put({ key, issuetype: issue.issuetype, summary: issue.summary, description: issue.description, labels: issue.labels ?? [] });
    return key;
  }

  async linkIssues(type: string, inwardKey: string, outwardKey: string) {
    this.calls.push(`link ${type} ${inwardKey} → ${outwardKey}`);
    const i = this.issues.get(inwardKey);
    if (i) this.put({ key: inwardKey, links: [...i.links, { type, phrase: `relates to`, key: outwardKey }] });
  }
}
