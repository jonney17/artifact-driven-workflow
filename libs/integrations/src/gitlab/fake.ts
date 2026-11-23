import type { GitLabApi, MergeRequest, MrNote, NewMr, PipelineStatus } from './api';

/** In-memory GitLab for tests, plus helpers that play the humans and CI (pipelines, approvals, merges). */
export class FakeGitLab implements GitLabApi {
  readonly mrs: MergeRequest[] = [];
  readonly notes = new Map<string, MrNote[]>();
  readonly calls: string[] = [];
  private seq = 0;

  private key = (project: string, iid: number) => `${project}!${iid}`;

  async findOpenMr(project: string, sourceBranch: string) {
    return this.mrs.find((m) => m.project === project && m.sourceBranch === sourceBranch && m.state === 'opened');
  }

  async getMr(project: string, iid: number) {
    return this.mrs.find((m) => m.project === project && m.iid === iid);
  }

  async createMr(n: NewMr) {
    if (await this.findOpenMr(n.project, n.sourceBranch)) throw new Error('Another open merge request already exists for this source branch');
    const mr: MergeRequest = {
      project: n.project,
      iid: ++this.seq,
      sourceBranch: n.sourceBranch,
      targetBranch: n.targetBranch,
      title: n.draft ? `Draft: ${n.title}` : n.title,
      description: n.description,
      state: 'opened',
      draft: n.draft,
      labels: [...n.labels],
      webUrl: `https://gitlab.test/${n.project}/-/merge_requests/${this.seq}`,
      approvedBy: [],
      mergeStatus: 'can_be_merged',
    };
    this.mrs.push(mr);
    this.calls.push(`create ${n.project} ${n.sourceBranch}`);
    return mr;
  }

  private must(project: string, iid: number) {
    const mr = this.mrs.find((m) => m.project === project && m.iid === iid);
    if (!mr) throw new Error(`no MR ${project}!${iid}`);
    return mr;
  }

  async setDraft(project: string, iid: number, draft: boolean) {
    const mr = this.must(project, iid);
    mr.draft = draft;
    mr.title = draft ? `Draft: ${mr.title.replace(/^Draft:\s*/, '')}` : mr.title.replace(/^Draft:\s*/, '');
    this.calls.push(`draft ${project}!${iid} ${draft}`);
  }

  async setLabels(project: string, iid: number, labels: string[]) {
    this.must(project, iid).labels = [...labels];
  }

  async setDescription(project: string, iid: number, description: string) {
    this.must(project, iid).description = description;
  }

  async closeMr(project: string, iid: number) {
    this.must(project, iid).state = 'closed';
    this.calls.push(`close ${project}!${iid}`);
  }

  async listNotes(project: string, iid: number) {
    return this.notes.get(this.key(project, iid)) ?? [];
  }

  async createThread(project: string, iid: number, body: string) {
    const k = this.key(project, iid);
    this.notes.set(k, [...(this.notes.get(k) ?? []), { id: `n${++this.seq}`, body }]);
    this.calls.push(`thread ${project}!${iid}`);
  }

  // ---- humans and CI ----
  pipeline(project: string, branch: string, status: PipelineStatus, sha = 'abc123') {
    const mr = this.mrs.find((m) => m.project === project && m.sourceBranch === branch && m.state === 'opened');
    if (mr) {
      mr.pipeline = { status, webUrl: `https://gitlab.test/${project}/-/pipelines/${++this.seq}` };
      mr.headSha = sha;
    }
  }

  approve(project: string, iid: number, user: string) {
    this.must(project, iid).approvedBy.push(user);
  }

  merge(project: string, iid: number) {
    this.must(project, iid).state = 'merged';
  }

  conflict(project: string, iid: number) {
    this.must(project, iid).mergeStatus = 'cannot_be_merged';
  }
}
