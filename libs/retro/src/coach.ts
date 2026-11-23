import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '@sdlc/contracts';
import type { Runner } from '@sdlc/runtimes';
import type { SessionRecord } from './sessions';

export const ROOT_CAUSES = ['missing-instruction', 'missing-skill', 'unclear-input', 'contract-gap', 'tool/env', 'model-limit'] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export interface RetroFinding {
  file: string;
  story: string;
  instance: string;
  attempt?: number;
  rootCause: RootCause;
  agent: string;
  /** The overlay file to change, e.g. `.sdlc/team/agents/developer/instructions.md`, or `pack` for a contract gap. */
  fixTarget: string;
  proposedChange: string;
}

/** Parses the Coach's retro: `- Root cause: …`, `- Agent: …`, `- Fix target: …`, and the "Proposed change" section. */
export function parseRetro(body: string, file: string, story: string): RetroFinding | undefined {
  const field = (name: string) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'im').exec(body)?.[1]?.trim();
  const rootCause = field('Root cause')?.toLowerCase() as RootCause | undefined;
  const agent = field('Agent');
  const fixTarget = field('Fix target');
  if (!rootCause || !ROOT_CAUSES.includes(rootCause) || !agent || !fixTarget) return undefined;
  if (rootCause !== 'contract-gap' && !fixTarget.startsWith('.sdlc/team/')) return undefined; // changes only ever touch the overlay
  const change = /^#{1,6}\s+Proposed change\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(body)?.[1]?.trim() ?? '';
  const instance = /^#\s+Session retro:\s+(\S+)\s+attempt\s+(\d+)/im.exec(body);
  return { file, story, instance: instance?.[1] ?? 'story', ...(instance?.[2] ? { attempt: Number(instance[2]) } : {}), rootCause, agent, fixTarget, proposedChange: change };
}

export const retroDir = (workRoot: string, story: string) => join(workRoot, 'retro', story);
export const sessionFile = (s: { instance: string; attempt: number }) => `session-${s.instance.replace(/:/g, '_')}-${s.attempt}`;

/**
 * Coach (a) (plan §7): for a settled session with signals, one Coach session writes
 * `retro/<KEY>/session-<instance>-<attempt>.md`. Sessions without signals get metrics only.
 * Runs through the same Runner as every agent (fresh session, artifacts as inputs, no credentials).
 */
export async function runSessionRetro(a: {
  runner: Runner;
  workRoot: string;
  session: SessionRecord;
  artifacts: Artifact[];
  workdir: string;
  overlayFiles: Record<string, string>;
}): Promise<RetroFinding | undefined> {
  const { session: s } = a;
  const dir = retroDir(a.workRoot, s.story);
  const file = join(dir, `${sessionFile(s)}.md`);
  const metrics: Artifact = {
    envelope: { id: `session-metrics-${sessionFile(s)}`, type: 'session-metrics', version: 1, status: 'ready', produced_by: 'engine', story: s.story, derived_from: [] },
    body: `# Session ${s.instance} attempt ${s.attempt}\n\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`,
  };
  const related = a.artifacts.filter((x) => s.outputs.some((o) => o.id === x.envelope.id) || (s.repo ? x.envelope.repo === s.repo : true)).slice(0, 12);
  const overlay: Artifact[] = Object.entries(a.overlayFiles).map(([path, body]) => ({
    envelope: { id: `overlay-${path.replace(/[^\w]+/g, '-')}`, type: 'overlay-file', version: 1, status: 'ready', produced_by: 'team', story: s.story, derived_from: [] },
    body: `# ${path}\n\n${body}`,
  }));
  const r = await a.runner.run({
    instance: `coach-session:${s.story}:${sessionFile(s)}`,
    contractId: 'coach-session',
    agent: 'coach',
    story: s.story,
    attempt: 1,
    workdir: a.workdir,
    inputs: [metrics, ...related, ...overlay],
    reworkInputs: [],
    policy: { tools: ['read'], maxTurns: 20, writeAllow: [], writeDeny: ['**'] },
  });
  if (r.status !== 'done') return undefined;
  const body = r.outputs.find((o) => o.type === 'session-retro')?.body;
  if (!body) return undefined;
  await mkdir(dir, { recursive: true });
  await writeFile(file, body, 'utf8');
  return parseRetro(body, file, s.story);
}

/** All retro findings across stories (the workspace repo pools every developer's engine). */
export async function readFindings(workRoot: string): Promise<RetroFinding[]> {
  const out: RetroFinding[] = [];
  const stories = await readdir(join(workRoot, 'retro')).catch(() => [] as string[]);
  for (const story of stories) {
    for (const f of (await readdir(join(workRoot, 'retro', story)).catch(() => [] as string[])).filter((x) => x.endsWith('.md'))) {
      const finding = parseRetro(await readFile(join(workRoot, 'retro', story, f), 'utf8'), join('retro', story, f), story);
      if (finding) out.push(finding);
    }
  }
  return out;
}

export interface Recurrence {
  key: string;
  rootCause: RootCause;
  agent: string;
  fixTarget: string;
  findings: RetroFinding[];
}

/**
 * Coach (b) trigger: the same root cause + agent + fix target in ≥ N retros (plan §7), skipping agents
 * that already have an open Coach MR or an effect check running (one open Coach MR per agent).
 * `contract-gap` findings are routed to the pack owner instead.
 */
export function recurring(findings: RetroFinding[], threshold: number, busyAgents: Set<string>): { ready: Recurrence[]; waiting: Recurrence[]; packProposals: Recurrence[] } {
  const groups = new Map<string, Recurrence>();
  for (const f of findings) {
    const key = `${f.rootCause}|${f.agent}|${f.fixTarget}`;
    const g = groups.get(key) ?? { key, rootCause: f.rootCause, agent: f.agent, fixTarget: f.fixTarget, findings: [] };
    g.findings.push(f);
    groups.set(key, g);
  }
  const hits = [...groups.values()].filter((g) => g.findings.length >= threshold);
  return {
    packProposals: hits.filter((g) => g.rootCause === 'contract-gap'),
    ready: hits.filter((g) => g.rootCause !== 'contract-gap' && !busyAgents.has(g.agent)),
    waiting: hits.filter((g) => g.rootCause !== 'contract-gap' && busyAgents.has(g.agent)),
  };
}

export interface OverlayChange {
  agent: string;
  /** Path under `.sdlc/team/` → new content. */
  files: Record<string, string>;
  evidence: string;
  primaryMetric: string;
}

/** Coach (b) writes the minimal overlay edit. Rejects anything outside `.sdlc/team/` (invariant). */
export async function runImprovement(a: { runner: Runner; recurrence: Recurrence; overlayFiles: Record<string, string>; workdir: string; story: string }): Promise<OverlayChange | undefined> {
  const g = a.recurrence;
  const input = (id: string, body: string): Artifact => ({ envelope: { id, type: 'coach-input', version: 1, status: 'ready', produced_by: 'engine', story: a.story, derived_from: [] }, body });
  const r = await a.runner.run({
    instance: `coach-improve:${g.agent}`,
    contractId: 'coach-improve',
    agent: 'coach',
    story: a.story,
    attempt: 1,
    workdir: a.workdir,
    inputs: [
      input('recurrence', `# Recurring finding\n\n- Root cause: ${g.rootCause}\n- Agent: ${g.agent}\n- Fix target: ${g.fixTarget}\n\n${g.findings.map((f) => `## ${f.file}\n\n${f.proposedChange}`).join('\n\n')}`),
      ...Object.entries(a.overlayFiles).map(([p, b]) => input(`file-${p.replace(/[^\w]+/g, '-')}`, `# ${p}\n\n${b}`)),
    ],
    reworkInputs: [],
    policy: { tools: ['read'], maxTurns: 20, writeAllow: [], writeDeny: ['**'] },
  });
  if (r.status !== 'done') return undefined;
  const files: Record<string, string> = {};
  for (const o of r.outputs.filter((x) => x.type === 'overlay-file')) {
    const path = /^path:\s*(\S+)\s*$/m.exec(o.body)?.[1];
    if (!path || !path.startsWith('.sdlc/team/') || path.includes('..')) return undefined;
    files[path] = o.body.replace(/^path:\s*\S+\s*\n+/m, '');
  }
  const change = r.outputs.find((x) => x.type === 'overlay-change')?.body ?? '';
  if (!Object.keys(files).length) return undefined;
  return { agent: g.agent, files, evidence: change, primaryMetric: /primary metric:\s*([\w-]+)/i.exec(change)?.[1] ?? 'rework_rounds' };
}
