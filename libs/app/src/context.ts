import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  ArtifactStore,
  BudgetGuard,
  Engine,
  EngineLoop,
  EventLog,
  GitWorkspace,
  GitWorktreeProvider,
  LeaseManager,
  loadPack,
  type Pack,
  resolveWorkflow,
  type ResolvedWorkflow,
  Semaphore,
  Takeovers,
  type WorktreeProvider,
} from '@sdlc/orchestrator';
import { AllowlistProxy, CopilotRunner, loadCopilotSdk, type CopilotSdk, type Notifier, QuestionRouter, type Runner, WebhookNotifier } from '@sdlc/runtimes';
import {
  type ConfluenceApi,
  ConfluenceConfigSchema,
  ConfluenceRestClient,
  type GitLabApi,
  GitLabConfigSchema,
  GitLabGraphqlClient,
  type JiraApi,
  JiraConfigSchema,
  JiraInbound,
  JiraOutbound,
  JiraQuestionNotifier,
  JiraRestClient,
  LifecycleConfigSchema,
  MembersSchema,
  MrSync,
  StorySync,
} from '@sdlc/integrations';
import { type AgentFile, buildAgentFiles, installAgent } from '@sdlc/hostgen';
import { expandEnv, type LocalConfig } from './config';
import { LocalStackEnvironment, PreprodEnvironment } from './environments';

/** Team-level settings read by the app layer (the rest of team.yaml is validated by each lib). */
const AppTeamSchema = z
  .object({
    questions: z
      .object({
        routes: z.record(z.string(), z.string()).default({ requirement: 'po', technical: 'responsible_dev', test: 'qe', environment: 'sm' }),
        live_wait_minutes: z.number().default(20),
        notify: z.object({ webhook: z.string().optional() }).default({}),
      })
      .default({ routes: { requirement: 'po', technical: 'responsible_dev', test: 'qe', environment: 'sm' }, live_wait_minutes: 20, notify: {} }),
    budget: z
      .object({
        personal_reserve: z.object({ stop_at_share: z.number().default(0.7), monthly_allowance_default: z.number().default(50000) }).default({ stop_at_share: 0.7, monthly_allowance_default: 50000 }),
        warn_at_share: z.number().default(0.8),
        credit_rates: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
      })
      .default({ personal_reserve: { stop_at_share: 0.7, monthly_allowance_default: 50000 }, warn_at_share: 0.8, credit_rates: {} }),
    qe: z
      .object({
        local_env: z.object({ up: z.string(), down: z.string(), base_url: z.string() }).optional(),
        preprod: z.object({ wait_for: z.object({ pipeline_ref: z.string(), job: z.string() }).optional(), base_url: z.string(), lease: z.string().default('preprod') }).optional(),
      })
      .default({}),
    members: MembersSchema.default({}),
  })
  .passthrough();

export interface ContextApis {
  jira?: JiraApi;
  confluence?: ConfluenceApi;
  gitlab?: GitLabApi;
  copilot?: CopilotSdk;
  /** Replace the Copilot runner entirely (tests, demo). */
  runner?: Runner;
  worktrees?: WorktreeProvider;
  /** Replace branch pushes (tests, demo). */
  push?: (repoPath: string, branch: string) => Promise<void>;
}

export interface SdlcContext {
  local: LocalConfig;
  pack: Pack;
  workflow: ResolvedWorkflow;
  team: z.infer<typeof AppTeamSchema>;
  teamDir: string;
  workRoot: string;
  store: ArtifactStore;
  events: EventLog;
  engine: Engine;
  takeovers: Takeovers;
  questions: QuestionRouter;
  budget: BudgetGuard;
  leases: LeaseManager;
  ws: GitWorkspace;
  sync: StorySync;
  loop: EngineLoop;
  agentFiles: AgentFile[];
  dryRun: boolean;
  /** Story keys this engine has local state for. */
  knownStories(): Promise<string[]>;
}

const env = (name: string) => process.env[name];

function jiraFromEnv(site: string, fieldNames: { acceptanceCriteria: string; topic: string; sprint: string }): JiraApi {
  const pat = env('JIRA_PAT');
  const email = env('JIRA_EMAIL');
  const token = env('JIRA_API_TOKEN');
  if (!pat && !(email && token)) throw new Error('Jira credentials missing: set JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Data Center) for the engine');
  return new JiraRestClient({ site, auth: pat ? { bearer: pat } : { email: email!, token: token! }, fieldNames });
}

/**
 * Wires one engine from `~/.sdlc/config.yaml` and the workspace repo's `.sdlc/team/team.yaml` (plan §1, §2, §9).
 * Real Jira/Confluence/GitLab clients and the Copilot SDK are used unless `apis` replaces them.
 * `dryRun` (plan §2 "Dry run"): reads real systems, writes nothing outbound, artifacts in a scratch folder.
 */
export async function createContext(local: LocalConfig, opts: { apis?: ContextApis; dryRun?: boolean; packsDir?: string } = {}): Promise<SdlcContext> {
  const apis = opts.apis ?? {};
  const dryRun = !!opts.dryRun;
  const teamDir = join(local.workspace, '.sdlc', 'team');
  const rawTeam = parse(await readFile(join(teamDir, 'team.yaml'), 'utf8')) as Record<string, unknown>;
  const packsDir = opts.packsDir ?? local.packs_dir ?? resolve(import.meta.dirname, '../../../packs');
  const packName = String(rawTeam.pack ?? '').split('@')[0]!;
  const pack = await loadPack(join(packsDir, packName));
  const workflow = resolveWorkflow(pack, rawTeam);
  const team = AppTeamSchema.parse(rawTeam);
  const overlay = workflow.overlay;

  const workRoot = dryRun ? await mkdtemp(join(tmpdir(), 'sdlc-dry-run-')) : join(local.workspace, '.sdlc', 'work');
  await mkdir(workRoot, { recursive: true });
  const store = new ArtifactStore(workRoot);
  const events = new EventLog(workRoot);
  const ws = new GitWorkspace(local.workspace);
  const leases = new LeaseManager(ws, { user: local.user, host: local.engine_id.split('-')[0] ?? 'host', engine_id: local.engine_id }, overlay.runtime.lease_ttl_minutes);

  const jiraCfg = JiraConfigSchema.parse(rawTeam.jira);
  const lifecycle = LifecycleConfigSchema.parse(rawTeam.lifecycle ?? {});
  const glCfg = GitLabConfigSchema.parse(rawTeam.gitlab);
  const confCfg = rawTeam.confluence ? ConfluenceConfigSchema.parse(rawTeam.confluence) : undefined;
  const fieldNames = { acceptanceCriteria: jiraCfg.fields.acceptance_criteria, topic: jiraCfg.fields.topic, sprint: jiraCfg.fields.sprint };
  const jira = apis.jira ?? jiraFromEnv(jiraCfg.site, fieldNames);
  const confluence =
    apis.confluence ??
    (confCfg && (env('JIRA_PAT') || env('JIRA_API_TOKEN'))
      ? new ConfluenceRestClient({ site: confCfg.site, auth: env('JIRA_PAT') ? { bearer: env('JIRA_PAT')! } : { email: env('JIRA_EMAIL')!, token: env('JIRA_API_TOKEN')! } })
      : undefined);
  const gitlab =
    apis.gitlab ??
    (() => {
      const token = env(glCfg.token_ref);
      if (!token) throw new Error(`GitLab token missing: set ${glCfg.token_ref} for the engine (never for agents)`);
      return new GitLabGraphqlClient({ url: glCfg.url, token });
    })();
  const outbound = new JiraOutbound(jira, jiraCfg, { jiraDevPanel: glCfg.mr.jira_dev_panel, dryRun });

  // who answers what: responsible_dev → the story's assignee; other roles → members with that role
  const assigneeEmail = new Map<string, string>();
  const questions = new QuestionRouter({
    storyDir: (s) => store.storyDir(s),
    routes: team.questions.routes as Record<'requirement' | 'technical' | 'test' | 'environment', string>,
    people: async (story, role) => {
      if (role === 'responsible_dev') {
        const cached = assigneeEmail.get(story) ?? (await jira.getIssue(story))?.assignee?.email;
        return cached ? [cached] : [local.user];
      }
      return Object.entries(team.members).filter(([, roles]) => roles.includes(role as never)).map(([m]) => m);
    },
    notifiers: [
      ...(team.questions.notify.webhook && expandEnv(team.questions.notify.webhook) && !dryRun ? [new WebhookNotifier(expandEnv(team.questions.notify.webhook))] : []),
      ...(jiraCfg.post_questions_as_comments ? [new JiraQuestionNotifier(outbound) as Notifier] : []),
    ],
    liveWaitMs: team.questions.live_wait_minutes * 60_000,
    onLateAnswer: async (q) => engine.answer(q.story, q.instance, q.answer ?? '', q.answeredBy ?? 'unknown'),
  });

  const budget = new BudgetGuard({
    perStory: overlay.limits.ai_credits_per_story,
    warnAt: team.budget.warn_at_share,
    monthlyAllowance: local.monthly_allowance ?? team.budget.personal_reserve.monthly_allowance_default,
    reserveShare: team.budget.personal_reserve.stop_at_share,
    usageFile: join(local.home, 'usage.json'),
  });

  const agentFiles = await buildAgentFiles(pack, workflow, teamDir);
  const templates: Record<string, string> = {};
  for (const f of await readdir(join(pack.dir!, 'templates')).catch(() => [] as string[])) {
    if (f.endsWith('.md')) templates[f.replace(/\.md$/, '')] = await readFile(join(pack.dir!, 'templates', f), 'utf8');
  }
  const rates = Object.fromEntries(Object.entries(team.budget.credit_rates).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  const runner =
    apis.runner ??
    new CopilotRunner({
      sdk: apis.copilot ?? loadCopilotSdk,
      questions,
      outputsOf: (id) => workflow.contracts.find((c) => c.contract.id === id)?.contract.outputs ?? [],
      templates,
      decisions: async (story) => readFile(join(store.storyDir(story), 'decisions.md'), 'utf8').catch(() => ''),
      installAgent: (agent, workdir) => installAgent(agentFiles, teamDir, agent, workdir),
      proxy: overlay.security.network.mode === 'allowlist' ? async (allow) => {
        const p = new AllowlistProxy(allow);
        return { url: await p.start(), stop: () => p.stop() };
      } : undefined,
      creditRates: rates,
    });

  const repoPaths = Object.fromEntries(Object.entries(overlay.repos).map(([name, r]) => [name, { path: resolve(local.repos[name] ?? join(local.workspace, r.path)), branch: r.branch }]));
  const environments = {
    ...(team.qe.local_env ? { local_stack: new LocalStackEnvironment({ ...team.qe.local_env, cwd: local.workspace }) } : {}),
    ...(team.qe.preprod ? { preprod: new PreprodEnvironment(leases, { base_url: team.qe.preprod.base_url, lease: team.qe.preprod.lease }) } : {}),
  };
  const engine = new Engine({
    store,
    events,
    runner,
    workflow,
    worktrees: apis.worktrees ?? new GitWorktreeProvider({ repos: repoPaths, root: local.worktrees }),
    slots: new Semaphore(overlay.limits.concurrency),
    environments,
    budget,
  });

  const inbound = new JiraInbound(
    jira,
    store,
    { jira: jiraCfg, lifecycle, ...(confCfg ? { confluence: confCfg } : {}), owner: overlay.runtime.owner, reposOf: async (_k, h) => h, idPatterns: { requirement: String((rawTeam.ids as Record<string, unknown> | undefined)?.requirement ?? 'FR\\d+') } },
    confluence,
  );
  const sync = new StorySync({
    store,
    events,
    engine,
    inbound,
    jira,
    jiraCfg,
    lifecycle,
    gitlab,
    mr: new MrSync(gitlab, glCfg, { dryRun }),
    outbound,
    repos: Object.fromEntries(Object.entries(overlay.repos).map(([name, r]) => [name, { path: repoPaths[name]!.path, gitlabProject: r.gitlab_project ?? name, branch: r.branch }])),
    members: team.members,
    statusRules: pack.jiraStatus ?? [],
    ...(team.qe.preprod?.wait_for ? { preprodJob: team.qe.preprod.wait_for.job } : {}),
    questions,
    ...(apis.push ? { push: apis.push } : {}),
    dryRun,
  });

  const knownStories = async () => (await readdir(join(workRoot, 'stories')).catch(() => [] as string[])).sort();
  const loop = new EngineLoop({
    ws: dryRun ? dryWorkspace(ws) : ws,
    leases: dryRun ? dryLeases() : leases,
    engine,
    hooks: {
      assigned: async () => {
        const items = await sync.assigned(await knownStories());
        return items;
      },
      syncIn: (s) => sync.syncIn(s),
      syncOut: (s, r) => sync.syncOut(s, r),
    },
  });

  return { local, pack, workflow, team, teamDir, workRoot, store, events, engine, takeovers: new Takeovers(store, events), questions, budget, leases, ws, sync, loop, agentFiles, dryRun, knownStories };
}

/** In a dry run the workspace repo is only read: pulls happen, pushes don't. */
function dryWorkspace(ws: GitWorkspace): GitWorkspace {
  return Object.assign(Object.create(Object.getPrototypeOf(ws)), ws, { commitAndPush: async () => 'ok' as const });
}

function dryLeases(): LeaseManager {
  return { claimStory: async () => true, releaseStory: async () => true, acquire: async () => true, release: async () => true, teamLeasePath: (n: string) => n, storyLeasePath: (k: string) => k } as unknown as LeaseManager;
}
