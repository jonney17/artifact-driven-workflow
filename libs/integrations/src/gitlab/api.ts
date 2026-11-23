export type PipelineStatus = 'created' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual';

export interface MergeRequest {
  project: string;
  iid: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  state: 'opened' | 'merged' | 'closed';
  draft: boolean;
  labels: string[];
  webUrl: string;
  headSha?: string;
  pipeline?: { status: PipelineStatus; webUrl?: string };
  /** `can_be_merged`, `cannot_be_merged` (conflict), … */
  mergeStatus?: string;
  approvedBy: string[];
  mergedAt?: string;
}

export interface JobRun {
  status: PipelineStatus;
  sha?: string;
  finishedAt?: string;
}

export interface MrNote {
  id: string;
  body: string;
}

export interface NewMr {
  project: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  draft: boolean;
  labels: string[];
}

/**
 * The GitLab operations the engine needs (plan §3a). Only the engine holds a GitLabApi, with the
 * developer's own token in Phase 1. There is deliberately no approve or merge operation: only humans do that.
 */
export interface GitLabApi {
  /** The open MR for a source branch (GitLab allows only one), if any. */
  findOpenMr(project: string, sourceBranch: string): Promise<MergeRequest | undefined>;
  getMr(project: string, iid: number): Promise<MergeRequest | undefined>;
  createMr(mr: NewMr): Promise<MergeRequest>;
  setDraft(project: string, iid: number, draft: boolean): Promise<void>;
  setLabels(project: string, iid: number, labels: string[]): Promise<void>;
  setDescription(project: string, iid: number, description: string): Promise<void>;
  closeMr(project: string, iid: number): Promise<void>;
  listNotes(project: string, iid: number): Promise<MrNote[]>;
  /** A discussion thread (comment), never an approval. */
  createThread(project: string, iid: number, body: string): Promise<void>;
  /** The latest run of a CI job on a ref, e.g. `deploy_preprod` on `main` (Q19). */
  latestJob(project: string, ref: string, job: string): Promise<JobRun | undefined>;
}
