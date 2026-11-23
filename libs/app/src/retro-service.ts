import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ContractOutputSchema } from '@sdlc/contracts';
import type { GitLabApi, JiraOutbound } from '@sdlc/integrations';
import {
  buildSessions,
  compareOverlay,
  type EffectResult,
  hitRate,
  type Improvement,
  oneLine,
  readFindings,
  recurring,
  retroDir,
  runImprovement,
  runSessionRetro,
  sessionFile,
  type StoryMetrics,
  storyMetrics,
  storyRetroSignals,
  sprintRollup,
  type SessionRecord,
} from '@sdlc/retro';
import type { SdlcContext } from './context';

const exec = promisify(execFile);
const exists = (p: string) => stat(p).then(() => true, () => false);

/** Outputs of the two Coach steps, for the runner (they run outside the artifact flow, plan §7). */
export const COACH_OUTPUTS = {
  'coach-session': [ContractOutputSchema.parse({ type: 'session-retro', required_sections: ['Outcome', 'Signals', 'Root cause', 'Proposed change'] })],
  'coach-improve': [
    ContractOutputSchema.parse({ type: 'overlay-change', required_sections: ['Evidence', 'Change', 'Expected effect'] }),
    ContractOutputSchema.parse({ type: 'overlay-file', multiple: true, numbered: true }),
  ],
};

interface RetroCfg {
  storyRetro: { po_rejection?: boolean; defect_rounds_at_least?: number; over_budget?: boolean; human_wait_share_above?: number };
  recurrence: number;
  guardrails: string[];
  minEach: number;
  fallbackModels: string[];
  coachEnabled: boolean;
  jiraSummary: boolean;
}

/**
 * Session retrospective and self-improvement (plan §7), run by the engine after each story's sync.
 * No LLM call for metrics; Coach sessions only where there is a signal.
 */
export class RetroService {
  private readonly cfg: RetroCfg;

  constructor(
    private readonly ctx: SdlcContext,
    private readonly deps: { outbound: JiraOutbound; gitlab: GitLabApi; workspaceProject?: string },
  ) {
    const raw = ctx.workflow.overlay as Record<string, any>;
    this.cfg = {
      storyRetro: raw.metrics?.story_retro ?? {},
      recurrence: raw.improvement?.recurrence_threshold ?? 2,
      guardrails: raw.improvement?.effect_check?.guardrails ?? ['ai_credits_per_session', 'takeover_rate', 'defect_rounds'],
      minEach: raw.improvement?.effect_check?.min_sessions_each_side ?? 5,
      fallbackModels: Object.values(ctx.workflow.overlay.agents).flatMap((a) => (a.fallback_model ? [a.fallback_model] : [])),
      coachEnabled: ctx.workflow.overlay.agents.coach?.enabled ?? true,
      jiraSummary: (raw.metrics?.jira_summary ?? 'one_line') === 'one_line',
    };
  }

  private async overlayFiles(agent: string): Promise<Record<string, string>> {
    const dir = join(this.ctx.teamDir, 'agents', agent);
    const out: Record<string, string> = {};
    for (const f of await readdir(dir).catch(() => [] as string[])) if (f.endsWith('.md')) out[`.sdlc/team/agents/${agent}/${f}`] = await readFile(join(dir, f), 'utf8');
    return out;
  }

  /** After a story's pass: session metrics, Coach (a), and at the end story metrics + Jira summary + story retro. */
  async afterStory(key: string): Promise<{ metrics: number; retros: number; storyMetrics: boolean }> {
    const { store, events, questions, workRoot } = this.ctx;
    const [artifacts, evs] = [await store.list(key), await events.read(key)];
    const sessions = buildSessions(key, evs, artifacts);
    const dir = retroDir(workRoot, key);
    await mkdir(dir, { recursive: true });
    let metrics = 0;
    let retros = 0;
    for (const s of sessions.filter((x) => x.settled)) {
      const base = join(dir, sessionFile(s));
      if (!(await exists(`${base}.metrics.json`))) {
        await writeFile(`${base}.metrics.json`, JSON.stringify(s, null, 2) + '\n', 'utf8');
        metrics++;
      }
      if (s.signals.length && this.cfg.coachEnabled && !(await exists(`${base}.md`))) {
        const f = await runSessionRetro({ runner: this.ctx.engineRunner, workRoot, session: s, artifacts, workdir: join(this.ctx.local.worktrees, 'coach', key), overlayFiles: await this.overlayFiles(s.agent) });
        if (f) retros++;
      }
    }

    const outcome = await this.outcome(key, artifacts);
    const file = join(store.storyDir(key), `story-metrics-${key}.json`);
    if (!outcome || (await exists(file))) return { metrics, retros, storyMetrics: false };
    const jira = await readFile(join(store.storyDir(key), 'jira.json'), 'utf8').then((t) => JSON.parse(t) as { sprint?: string }, () => ({}) as { sprint?: string });
    const m = storyMetrics({ story: key, events: evs, artifacts, questions: await questions.list(key), outcome, ...(jira.sprint ? { sprint: jira.sprint } : {}), fallbackModels: this.cfg.fallbackModels });
    await writeFile(file, JSON.stringify(m, null, 2) + '\n', 'utf8');
    if (this.cfg.jiraSummary) await this.deps.outbound.comment(key, `metrics:${key}`, oneLine(m));
    const signals = storyRetroSignals(m, this.cfg.storyRetro, this.ctx.workflow.limits.ai_credits_per_story);
    if (signals.length && this.cfg.coachEnabled) await this.storyRetro(key, m, signals, sessions);
    return { metrics, retros, storyMetrics: true };
  }

  private async outcome(key: string, artifacts: { envelope: { type: string; status: string } }[]): Promise<StoryMetrics['outcome'] | undefined> {
    if (artifacts.some((a) => a.envelope.type === 'preprod-check' && a.envelope.status === 'passed')) return 'done';
    const state = await readFile(join(this.ctx.store.storyDir(key), 'jira.json'), 'utf8').then((t) => JSON.parse(t).state as string, () => undefined);
    if (state === 'cancelled') return 'cancelled';
    if (state === 'done') return 'done';
    return undefined;
  }

  /** One story retro when the story ends with a story-level signal; it links the session retros. */
  private async storyRetro(key: string, m: StoryMetrics, signals: string[], sessions: SessionRecord[]) {
    const dir = retroDir(this.ctx.workRoot, key);
    const links = (await readdir(dir)).filter((f) => f.startsWith('session-') && f.endsWith('.md'));
    const worst = [...sessions].sort((a, b) => b.signals.length - a.signals.length)[0];
    const story: SessionRecord = {
      ...(worst ?? sessions[0]!),
      instance: `story:${key}`,
      attempt: 0,
      signals: [],
      signalDetail: { story: `${signals.join(', ')}; session retros: ${links.join(', ') || 'none'}; metrics: ${oneLine(m)}` },
    };
    await runSessionRetro({ runner: this.ctx.engineRunner, workRoot: this.ctx.workRoot, session: story, artifacts: [], workdir: join(this.ctx.local.worktrees, 'coach', key), overlayFiles: worst ? await this.overlayFiles(worst.agent) : {} });
  }

  private improvementsDir = () => join(this.ctx.workRoot, 'improvements');

  async improvements(): Promise<Improvement[]> {
    const dir = this.improvementsDir();
    return Promise.all((await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Improvement));
  }

  /**
   * Coach (b) (`sdlc improve`, plan §7): recurring findings → one minimal overlay change per agent, on a
   * branch of the workspace repo, opened as an MR by the engine. Runs only while holding the `coach` lease.
   */
  async improve(): Promise<{ opened: Improvement[]; waiting: string[]; packProposals: string[] }> {
    const all = await this.improvements();
    const busy = new Set(all.filter((i) => i.status === 'open' || i.status === 'merged').map((i) => i.agent));
    const { ready, waiting, packProposals } = recurring(await readFindings(this.ctx.workRoot), this.cfg.recurrence, busy);
    const opened: Improvement[] = [];
    if (!ready.length || !this.cfg.coachEnabled) return { opened, waiting: waiting.map((w) => w.key), packProposals: packProposals.map((p) => p.key) };
    const lease = this.ctx.leases.teamLeasePath('coach');
    if (!this.ctx.dryRun && !(await this.ctx.leases.acquire(lease))) return { opened, waiting: ready.map((r) => r.key), packProposals: packProposals.map((p) => p.key) };
    try {
      for (const g of ready) {
        const change = await runImprovement({ runner: this.ctx.engineRunner, recurrence: g, overlayFiles: await this.overlayFiles(g.agent), workdir: join(this.ctx.local.worktrees, 'coach', 'improve'), story: g.findings[0]!.story });
        if (!change) continue;
        const id = `${g.agent}-${Date.now()}`;
        const imp: Improvement = { id, agent: g.agent, rootCause: g.rootCause, fixTarget: g.fixTarget, primaryMetric: change.primaryMetric, guardrails: this.cfg.guardrails, openedAt: new Date().toISOString(), status: 'open' };
        if (!this.ctx.dryRun) imp.mrUrl = await this.openOverlayMr(id, change.files, `[sdlc Coach] ${g.agent}: ${g.rootCause}`, `${change.evidence}\n\nRecurring in ${g.findings.length} retros:\n${g.findings.map((f) => `- ${f.file}`).join('\n')}`);
        await mkdir(this.improvementsDir(), { recursive: true });
        await writeFile(join(this.improvementsDir(), `${id}.json`), JSON.stringify(imp, null, 2) + '\n', 'utf8');
        opened.push(imp);
      }
    } finally {
      if (!this.ctx.dryRun) await this.ctx.leases.release(lease);
    }
    return { opened, waiting: waiting.map((w) => w.key), packProposals: packProposals.map((p) => p.key) };
  }

  /** The engine (never the Coach) pushes a branch with the overlay edit and opens the MR (plan §3a rule). */
  private async openOverlayMr(id: string, files: Record<string, string>, title: string, description: string): Promise<string | undefined> {
    const ws = this.ctx.local.workspace;
    const git = (...a: string[]) => exec('git', a, { cwd: ws, windowsHide: true });
    const branch = `sdlc/coach-${id}`;
    const { stdout: head } = await git('rev-parse', 'HEAD');
    await git('worktree', 'add', '--quiet', '-b', branch, join(this.ctx.local.worktrees, 'coach-mr', id), head.trim());
    const wt = join(this.ctx.local.worktrees, 'coach-mr', id);
    for (const [p, body] of Object.entries(files)) {
      await mkdir(join(wt, p, '..'), { recursive: true });
      await writeFile(join(wt, p), body, 'utf8');
    }
    const g2 = (...a: string[]) => exec('git', a, { cwd: wt, windowsHide: true });
    await g2('add', '--', '.sdlc/team');
    await g2('commit', '--quiet', '-m', title);
    await g2('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    if (!this.deps.workspaceProject) return undefined;
    const mr = await this.deps.gitlab.createMr({ project: this.deps.workspaceProject, sourceBranch: branch, targetBranch: 'main', title, description, draft: false, labels: ['sdlc', 'sdlc-coach'] });
    return mr.webUrl;
  }

  /** `sdlc metrics --compare-overlay <rev>` for one improvement or agent. */
  async compare(agent: string, rev: string, primary = 'rework_rounds'): Promise<EffectResult> {
    const sessions: SessionRecord[] = [];
    for (const key of await this.ctx.knownStories()) sessions.push(...buildSessions(key, await this.ctx.events.read(key), await this.ctx.store.list(key)));
    const { stdout } = await exec('git', ['log', '--format=%H', '--reverse', '--', '.sdlc/team'], { cwd: this.ctx.local.workspace, windowsHide: true }).catch(() => ({ stdout: '' }));
    const revOrder: string[] = [];
    for (const c of stdout.split('\n').filter(Boolean)) {
      const tree = await exec('git', ['rev-parse', `${c}:.sdlc/team`], { cwd: this.ctx.local.workspace, windowsHide: true }).then((r) => r.stdout.trim(), () => '');
      if (tree && !revOrder.includes(tree)) revOrder.push(tree);
    }
    return compareOverlay({ sessions, agent, rev, revOrder, primary, guardrails: this.cfg.guardrails, minEach: this.cfg.minEach, fallbackModels: this.cfg.fallbackModels });
  }

  async storyMetricsAll(): Promise<StoryMetrics[]> {
    const out: StoryMetrics[] = [];
    for (const key of await this.ctx.knownStories()) {
      const f = join(this.ctx.store.storyDir(key), `story-metrics-${key}.json`);
      if (await exists(f)) out.push(JSON.parse(await readFile(f, 'utf8')));
    }
    return out;
  }

  async sprint(id?: string) {
    return { ...sprintRollup(await this.storyMetricsAll(), id), coach: hitRate(await this.improvements()) };
  }
}
