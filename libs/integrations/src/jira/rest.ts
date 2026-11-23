import type { JiraApi, JiraComment, JiraIssue, JiraLink, JiraRemoteLink, JiraSprint, JiraTransition, JiraUser, NewIssue } from './api';

export interface JiraRestOptions {
  site: string;
  /** Jira Cloud: email + API token (basic auth). Data Center: a personal access token (bearer). */
  auth: { email: string; token: string } | { bearer: string };
  /** Display names of the fields the engine reads, resolved to field ids on first use. */
  fieldNames: { acceptanceCriteria: string; topic: string; sprint: string };
  fetch?: typeof fetch;
}

type Raw = Record<string, any>;

/**
 * Jira REST v2 client. Kept on plain `fetch` so it is easy to record and replay in tests.
 * NOT YET VERIFIED against the team's Jira: run the Atlassian spike (HANDOFF "Later on the work machine").
 */
export class JiraRestClient implements JiraApi {
  private fieldIds?: { ac?: string; topic?: string; sprint?: string };
  private readonly f: typeof fetch;

  constructor(private readonly o: JiraRestOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    headers.Authorization =
      'bearer' in this.o.auth ? `Bearer ${this.o.auth.bearer}` : `Basic ${Buffer.from(`${this.o.auth.email}:${this.o.auth.token}`).toString('base64')}`;
    const res = await this.f(new URL(path, this.o.site), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private async fields() {
    if (!this.fieldIds) {
      const all = await this.call<{ id: string; name: string }[]>('GET', '/rest/api/2/field');
      const id = (name: string) => all.find((f) => f.name.toLowerCase() === name.toLowerCase())?.id;
      this.fieldIds = { ac: id(this.o.fieldNames.acceptanceCriteria), topic: id(this.o.fieldNames.topic), sprint: id(this.o.fieldNames.sprint) };
    }
    return this.fieldIds;
  }

  private async normalise(raw: Raw): Promise<JiraIssue> {
    const ids = await this.fields();
    const f = raw.fields ?? {};
    const links: JiraLink[] = (f.issuelinks ?? []).map((l: Raw) =>
      l.inwardIssue
        ? { type: l.type.name, phrase: l.type.inward, key: l.inwardIssue.key }
        : { type: l.type.name, phrase: l.type.outward, key: l.outwardIssue.key },
    );
    const sprints: JiraSprint[] = ((ids.sprint && f[ids.sprint]) || []).map((s: Raw) => ({ id: s.id, name: s.name, state: String(s.state).toLowerCase() }));
    const topicRaw = ids.topic ? f[ids.topic] : undefined;
    const epicKey = typeof topicRaw === 'string' ? topicRaw : topicRaw?.key ?? (f.parent?.fields?.issuetype?.name === 'Epic' ? f.parent.key : undefined);
    const acRaw = ids.ac ? f[ids.ac] : undefined;
    return {
      key: raw.key,
      issuetype: f.issuetype?.name ?? '',
      summary: f.summary ?? '',
      description: f.description ?? '',
      status: f.status?.name ?? '',
      statusCategory: f.status?.statusCategory?.key === 'done' ? 'done' : f.status?.statusCategory?.key === 'new' ? 'new' : 'indeterminate',
      ...(f.resolution?.name ? { resolution: f.resolution.name } : {}),
      ...(f.assignee ? { assignee: { accountId: f.assignee.accountId ?? f.assignee.name, email: f.assignee.emailAddress, displayName: f.assignee.displayName } } : {}),
      ...(f.priority?.name ? { priority: f.priority.name } : {}),
      labels: f.labels ?? [],
      sprints,
      ...(epicKey ? { epicKey } : {}),
      ...(acRaw ? { acceptanceCriteria: typeof acRaw === 'string' ? acRaw : JSON.stringify(acRaw) } : {}),
      links,
      updated: f.updated ?? '',
    };
  }

  async myself(): Promise<JiraUser> {
    const r = await this.call<Raw>('GET', '/rest/api/2/myself');
    return { accountId: r.accountId ?? r.name, email: r.emailAddress, displayName: r.displayName };
  }

  async search(jql: string): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    for (let startAt = 0; ; ) {
      const r = await this.call<Raw>('POST', '/rest/api/2/search', { jql, startAt, maxResults: 100, fields: ['*all'] });
      for (const i of r.issues ?? []) out.push(await this.normalise(i));
      startAt += (r.issues ?? []).length;
      if (!r.issues?.length || startAt >= r.total) return out;
    }
  }

  async getIssue(key: string) {
    try {
      return await this.normalise(await this.call<Raw>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}`));
    } catch (e) {
      if (String(e).includes(': 404')) return undefined;
      throw e;
    }
  }

  async getComments(key: string): Promise<JiraComment[]> {
    const r = await this.call<Raw>('GET', `/rest/api/2/issue/${key}/comment?expand=properties&maxResults=1000`);
    return (r.comments ?? []).map((c: Raw) => ({
      id: c.id,
      author: c.author ? { accountId: c.author.accountId ?? c.author.name, email: c.author.emailAddress } : undefined,
      body: c.body,
      created: c.created,
      properties: Object.fromEntries((c.properties ?? []).map((p: Raw) => [p.key, p.value])),
    }));
  }

  async addComment(key: string, body: string, properties?: Record<string, unknown>) {
    const props = properties ? Object.entries(properties).map(([k, value]) => ({ key: k, value })) : undefined;
    const c = await this.call<Raw>('POST', `/rest/api/2/issue/${key}/comment`, { body, ...(props ? { properties: props } : {}) });
    return { id: c.id, body: c.body, created: c.created, ...(properties ? { properties } : {}) };
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const r = await this.call<Raw>('GET', `/rest/api/2/issue/${key}/transitions`);
    return (r.transitions ?? []).map((t: Raw) => ({ id: t.id, name: t.name, to: t.to?.name }));
  }

  async transition(key: string, transitionId: string) {
    await this.call('POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id: transitionId } });
  }

  async getRemoteLinks(key: string): Promise<JiraRemoteLink[]> {
    const r = await this.call<Raw[]>('GET', `/rest/api/2/issue/${key}/remotelink`);
    return r.map((l) => ({ globalId: l.globalId, url: l.object?.url, title: l.object?.title, relationship: l.relationship }));
  }

  async upsertRemoteLink(key: string, link: JiraRemoteLink & { globalId: string }) {
    await this.call('POST', `/rest/api/2/issue/${key}/remotelink`, {
      globalId: link.globalId,
      ...(link.relationship ? { relationship: link.relationship } : {}),
      object: { url: link.url, title: link.title },
    });
  }

  async createIssue(issue: NewIssue) {
    const r = await this.call<Raw>('POST', '/rest/api/2/issue', {
      fields: {
        project: { key: issue.project },
        issuetype: { name: issue.issuetype },
        summary: issue.summary,
        description: issue.description,
        ...(issue.parent ? { parent: { key: issue.parent } } : {}),
        ...(issue.labels ? { labels: issue.labels } : {}),
      },
    });
    return r.key as string;
  }

  async linkIssues(type: string, inwardKey: string, outwardKey: string) {
    await this.call('POST', '/rest/api/2/issueLink', { type: { name: type }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } });
  }
}
