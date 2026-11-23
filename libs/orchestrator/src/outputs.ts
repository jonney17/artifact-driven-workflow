import { type Artifact, artifactId, type Contract, type ContractOutput } from '@sdlc/contracts';
import type { OutputDraft } from '@sdlc/runtimes';
import { type OutputIssue, validateOutput } from './validate';

export interface PlannedWrite {
  id: string;
  type: string;
  status: string;
  repo?: string;
  body: string;
  /** A rework input created from a verdict (e.g. changes requested → review-finding for the Developer). */
  rework?: { id: string; type: string; repo?: string };
}

/** Reads `Verdict: <value>` from an output body (first match, case-insensitive). */
export function readVerdict(body: string): string | undefined {
  return /^\s*(?:\*\*)?verdict(?:\*\*)?\s*:\s*\**\s*([a-z_-]+)/im.exec(body)?.[1]?.toLowerCase();
}

/**
 * Turns an attempt's drafts into the artifacts to write (plan §2 "validate the outputs"):
 * - a single output per story, or per repo for a fan-out instance;
 * - `multiple`: the agent emits one per repo (e.g. the Planner's proposal per affected repo);
 * - `numbered`: each draft gets the next free number (e.g. defects);
 * - `verdicts`: the body's `Verdict:` sets the status and may emit a rework input;
 * - a gated output becomes `approved` at once when the overlay sets the gate to `auto`.
 */
export function planOutputs(args: {
  contract: Contract;
  gateMode: 'human' | 'auto' | null;
  story: string;
  instanceRepo?: string;
  drafts: OutputDraft[];
  existing: Artifact[];
}): { issues: OutputIssue[]; writes: PlannedWrite[] } {
  const { contract, story, instanceRepo, existing } = args;
  const issues: OutputIssue[] = [];
  const writes: PlannedWrite[] = [];
  const known = new Set(contract.outputs.map((o) => o.type));
  for (const d of args.drafts) if (!known.has(d.type)) issues.push({ type: d.type, message: 'not an output of this contract' });

  for (const o of contract.outputs) {
    let drafts = args.drafts.filter((d) => d.type === o.type);
    if (o.scope === 'repo' && instanceRepo) drafts = drafts.map((d) => ({ ...d, repo: d.repo ?? instanceRepo }));
    if (drafts.length === 0) {
      if (!o.optional) issues.push({ type: o.type, message: 'output not produced' });
      continue;
    }
    if (!o.multiple && drafts.length > 1) {
      issues.push({ type: o.type, message: 'produced more than once' });
      continue;
    }
    for (const d of drafts) {
      if (o.scope === 'repo' && !d.repo) {
        issues.push({ type: o.type, message: 'repo-scoped output without a repo' });
        continue;
      }
      if (o.scope === 'repo' && instanceRepo && d.repo !== instanceRepo) {
        issues.push({ type: o.type, message: `written for repo ${d.repo}, but this instance is for ${instanceRepo}` });
        continue;
      }
      const found = validateOutput(o, d.body);
      if (found.length) {
        issues.push(...found);
        continue;
      }
      const repo = o.scope === 'repo' ? d.repo : undefined;
      const w = planOne(o, { story, repo, body: d.body, gateMode: contract.gate && o.gated ? args.gateMode : null, existing, planned: writes });
      if ('message' in w) issues.push(w);
      else writes.push(w);
    }
  }
  return { issues, writes };
}

function nextNumber(prefix: string, existing: Artifact[], planned: PlannedWrite[]): number {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  const nums = [...existing.map((a) => a.envelope.id), ...planned.map((p) => p.id), ...planned.flatMap((p) => (p.rework ? [p.rework.id] : []))]
    .map((id) => Number(re.exec(id)?.[1] ?? 0));
  return Math.max(0, ...nums) + 1;
}

function planOne(
  o: ContractOutput,
  a: { story: string; repo: string | undefined; body: string; gateMode: 'human' | 'auto' | null; existing: Artifact[]; planned: PlannedWrite[] },
): PlannedWrite | OutputIssue {
  const base = artifactId(o.type, a.story, a.repo);
  const id = o.numbered ? `${base}-${nextNumber(base, a.existing, a.planned)}` : base;
  let status = o.status;
  let rework: PlannedWrite['rework'];
  if (o.verdicts) {
    const v = readVerdict(a.body);
    const rule = v ? o.verdicts[v] : undefined;
    if (!rule) return { type: o.type, message: `missing or unknown verdict (expected one of: ${Object.keys(o.verdicts).join(', ')})` };
    status = rule.status;
    if (rule.rework) {
      const rbase = artifactId(rule.rework, a.story, a.repo);
      rework = { id: `${rbase}-${nextNumber(rbase, a.existing, a.planned)}`, type: rule.rework, ...(a.repo ? { repo: a.repo } : {}) };
    }
  }
  if (a.gateMode === 'auto' && status === 'ready') status = 'approved';
  return { id, type: o.type, status, body: a.body, ...(a.repo ? { repo: a.repo } : {}), ...(rework ? { rework } : {}) };
}
