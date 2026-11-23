import type { GitLabApi, MergeRequest, MrNote, NewMr } from './api';

const MR_FIELDS = `iid title description state draft webUrl sourceBranch targetBranch diffHeadSha detailedMergeStatus mergedAt
  labels { nodes { title } } headPipeline { status path } approvedBy { nodes { username } }`;

type Raw = Record<string, any>;

/**
 * GitLab client: GraphQL first, REST only where GraphQL lacks an operation (plan §3a; Q3).
 * REST is used for setting labels by name. The org's GitLab MCP server is never used here.
 * NOT YET VERIFIED against the team's GitLab: GitLab spike (HANDOFF "Later on the work machine").
 */
export class GitLabGraphqlClient implements GitLabApi {
  private readonly f: typeof fetch;

  constructor(private readonly o: { url: string; token: string; fetch?: typeof fetch }) {
    this.f = o.fetch ?? fetch;
  }

  private async gql<T = Raw>(query: string, variables: Raw): Promise<T> {
    const res = await this.f(`${this.o.url.replace(/\/$/, '')}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.o.token}` },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) throw new Error(`GitLab GraphQL: ${res.status} ${body.errors?.map((e) => e.message).join('; ')}`);
    return body.data as T;
  }

  private async rest(method: string, path: string, body?: Raw) {
    const res = await this.f(`${this.o.url.replace(/\/$/, '')}/api/v4${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': this.o.token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitLab REST ${method} ${path}: ${res.status}`);
  }

  private toMr(project: string, n: Raw): MergeRequest {
    return {
      project,
      iid: Number(n.iid),
      sourceBranch: n.sourceBranch,
      targetBranch: n.targetBranch,
      title: n.title,
      description: n.description ?? '',
      state: String(n.state).toLowerCase() as MergeRequest['state'],
      draft: !!n.draft,
      labels: (n.labels?.nodes ?? []).map((l: Raw) => l.title),
      webUrl: n.webUrl,
      ...(n.diffHeadSha ? { headSha: n.diffHeadSha } : {}),
      ...(n.headPipeline ? { pipeline: { status: String(n.headPipeline.status).toLowerCase() as never, webUrl: n.headPipeline.path } } : {}),
      ...(n.detailedMergeStatus ? { mergeStatus: String(n.detailedMergeStatus).toLowerCase() } : {}),
      approvedBy: (n.approvedBy?.nodes ?? []).map((u: Raw) => u.username),
      ...(n.mergedAt ? { mergedAt: n.mergedAt } : {}),
    };
  }

  async findOpenMr(project: string, sourceBranch: string) {
    const d = await this.gql(
      `query($p: ID!, $b: [String!]) { project(fullPath: $p) { mergeRequests(sourceBranches: $b, state: opened, first: 1) { nodes { ${MR_FIELDS} } } } }`,
      { p: project, b: [sourceBranch] },
    );
    const n = d.project?.mergeRequests?.nodes?.[0];
    return n ? this.toMr(project, n) : undefined;
  }

  async getMr(project: string, iid: number) {
    const d = await this.gql(`query($p: ID!, $i: String!) { project(fullPath: $p) { mergeRequest(iid: $i) { ${MR_FIELDS} } } }`, { p: project, i: String(iid) });
    const n = d.project?.mergeRequest;
    return n ? this.toMr(project, n) : undefined;
  }

  async createMr(n: NewMr) {
    const d = await this.gql(
      `mutation($p: ID!, $s: String!, $t: String!, $title: String!, $d: String, $l: [String!]) {
        mergeRequestCreate(input: { projectPath: $p, sourceBranch: $s, targetBranch: $t, title: $title, description: $d, labels: $l }) {
          mergeRequest { ${MR_FIELDS} } errors } }`,
      { p: n.project, s: n.sourceBranch, t: n.targetBranch, title: n.draft ? `Draft: ${n.title}` : n.title, d: n.description, l: n.labels },
    );
    const r = d.mergeRequestCreate;
    if (r.errors?.length) throw new Error(`mergeRequestCreate: ${r.errors.join('; ')}`);
    return this.toMr(n.project, r.mergeRequest);
  }

  async setDraft(project: string, iid: number, draft: boolean) {
    await this.gql(`mutation($p: ID!, $i: String!, $d: Boolean!) { mergeRequestSetDraft(input: { projectPath: $p, iid: $i, draft: $d }) { errors } }`, {
      p: project,
      i: String(iid),
      d: draft,
    });
  }

  async setLabels(project: string, iid: number, labels: string[]) {
    await this.rest('PUT', `/projects/${encodeURIComponent(project)}/merge_requests/${iid}`, { labels: labels.join(',') });
  }

  async setDescription(project: string, iid: number, description: string) {
    await this.gql(`mutation($p: ID!, $i: String!, $d: String) { mergeRequestUpdate(input: { projectPath: $p, iid: $i, description: $d }) { errors } }`, {
      p: project,
      i: String(iid),
      d: description,
    });
  }

  async closeMr(project: string, iid: number) {
    await this.gql(`mutation($p: ID!, $i: String!) { mergeRequestUpdate(input: { projectPath: $p, iid: $i, state: CLOSED }) { errors } }`, { p: project, i: String(iid) });
  }

  async listNotes(project: string, iid: number): Promise<MrNote[]> {
    const d = await this.gql(`query($p: ID!, $i: String!) { project(fullPath: $p) { mergeRequest(iid: $i) { notes(first: 100) { nodes { id body } } } } }`, {
      p: project,
      i: String(iid),
    });
    return d.project?.mergeRequest?.notes?.nodes ?? [];
  }

  async latestJob(project: string, ref: string, job: string) {
    const d = await this.gql(
      `query($p: ID!, $r: String!) { project(fullPath: $p) { pipelines(ref: $r, first: 5) { nodes { sha jobs { nodes { name status finishedAt } } } } } }`,
      { p: project, r: ref },
    );
    for (const pl of d.project?.pipelines?.nodes ?? []) {
      const j = (pl.jobs?.nodes ?? []).find((x: Raw) => x.name === job);
      if (j) return { status: String(j.status).toLowerCase() as never, sha: pl.sha, finishedAt: j.finishedAt ?? undefined };
    }
    return undefined;
  }

  async createThread(project: string, iid: number, body: string) {
    const d = await this.gql(`query($p: ID!, $i: String!) { project(fullPath: $p) { mergeRequest(iid: $i) { id } } }`, { p: project, i: String(iid) });
    await this.gql(`mutation($n: NoteableID!, $b: String!) { createDiscussion(input: { noteableId: $n, body: $b }) { errors } }`, {
      n: d.project.mergeRequest.id,
      b: body,
    });
  }
}
