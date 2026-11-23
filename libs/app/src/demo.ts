import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FakeConfluence, FakeGitLab, FakeJira } from '@sdlc/integrations';
import { type AttemptRequest, type AttemptResult, StubRunner } from '@sdlc/runtimes';
import { withDefaults } from './config';
import { createContext, type SdlcContext } from './context';
import { board } from './views';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, windowsHide: true });

const DEMO_TEAM = `pack: safe-scrum@1
team: demo-squad
jira:
  site: https://demo.atlassian.net
  project: PAY
  intake_jql: "project = PAY AND sprint in openSprints() AND issuetype = Story"
  fields: {acceptance_criteria: "Acceptance Criteria", topic: "Epic Link", repos: "labels:repo-*"}
  status_map: {refining: "In Refinement", in_progress: "In Progress", in_review: "In Review", in_qa: "In QA", ready_for_acceptance: "Ready for Acceptance", done: "Done"}
  gates_from_jira:
    story_acceptance: {transition: "Accepted"}
    scenario_approval: {comment_command: "/sdlc approve scenarios", role: qe}
confluence: {site: https://demo.atlassian.net/wiki, prd_link: {from: epic, issue_link: "mentioned in"}}
repos:
  billing-api: {path: ../billing-api, gitlab_project: payments/billing-api, branch: main, build: "mvn -q verify", unit: "mvn test", test_dirs: [src/acceptance]}
gitlab: {url: https://gitlab.demo, token_ref: DEMO_GITLAB_TOKEN}
security:
  sensitive_paths: ["**/pom.xml", ".gitlab-ci.yml"]
  network: {mode: off}
runtime: {mode: local, owner: assignee, lease_ttl_minutes: 30, workspace_repo: payments/payments-sdlc-workspace}
improvement: {recurrence_threshold: 2}
members: {"alice@demo": [po], "bob@demo": [dev], "chi@demo": [qe], "dan@demo": [sm]}
limits: {review_rounds: 2, defect_rounds: 3, concurrency: 4, ai_credits_per_story: 4000}
questions: {live_wait_minutes: 1}
qe:
  local_env: {up: "echo stack up", down: "echo stack down", base_url: "http://localhost:8080"}
  preprod: {wait_for: {pipeline_ref: main, job: deploy_preprod}, base_url: "https://preprod.demo", lease: preprod}
`;

const doc = (title: string, sections: Record<string, string>, verdict?: string) =>
  [`# ${title}`, '', ...(verdict ? [`Verdict: ${verdict}`, ''] : []), ...Object.entries(sections).flatMap(([h, b]) => [`## ${h}`, '', b, ''])].join('\n');

/** Scripted agents that behave like the real ones would, for the demo and the app tests. */
export function demoRunner(): StubRunner {
  let reviews = 0;
  const done = (sessionId: string, outputs: { type: string; repo?: string; body: string }[], changedFiles: string[] = []): AttemptResult => ({ status: 'done', sessionId, outputs, changedFiles, aiCredits: 120 });
  return new StubRunner()
    .on('planner', (_r, { sessionId }) =>
      done(sessionId, [
        { type: 'explore', body: doc('Explore', { 'Affected repos': '- `billing-api`: new endpoint', Reuse: 'Money', Risks: 'none' }) },
        { type: 'proposal', repo: 'billing-api', body: doc('Proposal', { Summary: 'POST /invoices (PAY-12-AC1, PAY-12-AC2)', 'Interfaces & test hooks': 'POST /api/v1/invoices {amount, currency}', 'Sensitive changes': 'none', Tasks: '- [ ] endpoint (PAY-12-AC1)\n- [ ] tax (PAY-12-AC2)' }) },
      ]),
    )
    .on('qe-define', (_r, { sessionId }) => done(sessionId, [{ type: 'test-scenarios', repo: 'billing-api', body: doc('Scenarios', { Scenarios: 'S1 Given an order When invoiced Then 201', 'AC coverage': 'PAY-12-AC1: S1; PAY-12-AC2: S2' }) }]))
    .on('developer', (r: AttemptRequest, { sessionId }) =>
      done(
        sessionId,
        [
          { type: 'code', body: doc('Code', { Summary: `attempt ${r.attempt}; rework: ${r.reworkInputs.map((a) => a.envelope.type).join(', ') || 'none'}`, Changes: 'InvoiceController.java', 'Self-check': 'mvn -q verify: green' }) },
          { type: 'mr-description', body: doc('MR', { Summary: 'Invoices', 'AC covered': 'PAY-12-AC1, PAY-12-AC2', 'Interfaces touched': 'POST /api/v1/invoices', Assumptions: 'none', 'How to test': 'mvn verify' }) },
        ],
        ['src/main/java/InvoiceController.java'],
      ),
    )
    .on('qe-write', (_r, { sessionId }) => done(sessionId, [{ type: 'test-code', body: doc('Tests', { 'Tests written': 'InvoiceIT', 'Dry run': 'red for the right reason: 404' }) }], ['src/acceptance/InvoiceIT.java']))
    .on('reviewer', (_r, { sessionId }) =>
      ++reviews === 1
        ? done(sessionId, [{ type: 'review', body: doc('Review', { Findings: '- **major** `InvoiceController.java:31`: tax is not applied to discounts' }, 'changes_requested') }])
        : done(sessionId, [{ type: 'review', body: doc('Review', { Findings: 'none' }, 'approved') }]),
    )
    .on('qe-run', (_r, { sessionId }) => done(sessionId, [{ type: 'story-acceptance', body: doc('Acceptance', { 'AC matrix': '| PAY-12-AC1 | InvoiceIT.create | pass |\n| PAY-12-AC2 | InvoiceIT.tax | pass |', Evidence: 'trace-PAY-12.zip', Failures: 'none' }, 'pass') }]))
    .on('qe-preprod', (_r, { sessionId }) => done(sessionId, [{ type: 'preprod-check', body: doc('Preprod', { Results: 'smoke + regression green' }, 'pass') }]))
    .on('coach-session', (r, { sessionId }) => {
      const s = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(r.inputs[0]!.body)?.[1] ?? '{}') as { instance: string; attempt: number; agent: string; signals: string[]; signalDetail: Record<string, string> };
      const body = [
        `# Session retro: ${s.instance} attempt ${s.attempt}`,
        '',
        '## Outcome',
        '',
        `Signals: ${s.signals.join(', ') || 'story-level'}.`,
        '',
        '## Signals',
        '',
        ...Object.entries(s.signalDetail).map(([k, v]) => `- ${k}: ${v}`),
        '',
        '## Root cause',
        '',
        '- Root cause: missing-instruction',
        `- Agent: ${s.agent}`,
        `- Fix target: .sdlc/team/agents/${s.agent}/instructions.md`,
        '',
        '## Proposed change',
        '',
        'Add: "Run `mvn -q verify` and apply tax to discounted totals before finishing."',
        '',
      ].join('\n');
      return done(sessionId, [{ type: 'session-retro', body }]);
    })
    .on('coach-improve', (r, { sessionId }) => {
      const target = /- Fix target: (\S+)/.exec(r.inputs[0]!.body)?.[1] ?? '.sdlc/team/agents/developer/instructions.md';
      return done(sessionId, [
        { type: 'overlay-change', body: doc('Overlay change', { Evidence: 'Two retros: pipeline red and a review finding on tax.', Change: `Add a self-check line to ${target}.`, 'Expected effect': 'Primary metric: rework_rounds. Guardrails: AI credits, takeovers, defects.' }) },
        { type: 'overlay-file', body: `path: ${target}\n\n- Before finishing, run \`mvn -q verify\` and check that tax applies to discounted totals.\n` },
      ]);
    });
}

export interface Demo {
  ctx: SdlcContext;
  jira: FakeJira;
  gitlab: FakeGitLab;
  dir: string;
  /** One engine loop pass; returns what was dispatched. */
  cycle(): Promise<string[]>;
}

/** Sets up a demo: a real git workspace repo, fake Jira/Confluence/GitLab, scripted agents. */
export async function setupDemo(dir?: string): Promise<Demo> {
  const base = dir ?? (await mkdtemp(join(tmpdir(), 'sdlc-demo-')));
  const remote = join(base, 'workspace.git');
  const workspace = join(base, 'workspace');
  await exec('git', ['init', '--bare', '--quiet', '-b', 'main', remote]);
  await exec('git', ['clone', '--quiet', remote, workspace]);
  for (const [k, v] of [['user.email', 'bob@demo'], ['user.name', 'Bob'], ['core.autocrlf', 'false']]) await git(workspace, 'config', k!, v!);
  await mkdir(join(workspace, '.sdlc', 'team'), { recursive: true });
  await writeFile(join(workspace, '.sdlc', 'team', 'team.yaml'), DEMO_TEAM);
  await git(workspace, 'add', '-A');
  await git(workspace, 'commit', '--quiet', '-m', 'team overlay');
  await git(workspace, 'push', '--quiet', 'origin', 'HEAD:main');

  const bob = { accountId: 'u-bob', email: 'bob@demo', displayName: 'Bob' };
  const jira = new FakeJira(bob);
  jira.put({ key: 'PAY-12', summary: 'Create invoices', assignee: bob, epicKey: 'PAY-1', labels: ['repo-billing-api'], acceptanceCriteria: '- an invoice is created for an order\n- the total includes tax' });
  const confluence = new FakeConfluence();
  confluence.put('4242', 'Invoicing PRD', '<h1>Goals</h1><p>FR1 invoices for every order</p><h2>Tax</h2><p>FR2 totals include tax</p>');
  await jira.upsertRemoteLink('PAY-1', { globalId: 'prd', url: 'https://demo.atlassian.net/wiki/pages/viewpage.action?pageId=4242', title: 'PRD', relationship: 'mentioned in' });
  const gitlab = new FakeGitLab();

  process.env.SDLC_HOME ??= join(base, 'home');
  const local = withDefaults({ workspace, user: 'bob@demo', repos: {}, worktrees: join(base, 'worktrees') });
  const ctx = await createContext(local, {
    apis: {
      jira,
      confluence,
      gitlab,
      runner: demoRunner(),
      worktrees: { prepare: async ({ instance, attempt }) => join(base, 'worktrees', instance.replace(/:/g, '_'), `a${attempt}`) },
      push: async () => undefined,
    },
  });
  return {
    ctx,
    jira,
    gitlab,
    dir: base,
    cycle: async () => {
      const r = await ctx.loop.once();
      return Object.values(r.ticks).flatMap((t) => t.dispatched.map((d) => `${d.instance} #${d.attempt} ${d.result}`));
    },
  };
}

/** `sdlc demo`: one story from Jira to Done, printing each step. Humans and CI are played by the script. */
export async function runDemo(log: (line: string) => void = console.log): Promise<Demo> {
  const d = await setupDemo();
  const { ctx, jira, gitlab } = d;
  const status = () => jira.issues.get('PAY-12')!.status;
  const step = async (what: string) => {
    const ran = await d.cycle();
    log(`${what.padEnd(46)} → ${ran.length ? ran.join(', ') : 'nothing to run'}  [Jira: ${status()}]`);
  };
  log(`demo workspace: ${d.dir}`);
  await step('1. intake + Planner');
  await step('2. QE defines scenarios');
  await ctx.engine.passGate('PAY-12', 'proposal-PAY-12-billing-api', 'bob@demo');
  jira.humanComment('PAY-12', { accountId: 'u-chi', email: 'chi@demo' }, '/sdlc approve scenarios');
  await step('3. gates passed (dev in CLI, QE in Jira)');
  gitlab.pipeline('payments/billing-api', 'PAY-12/billing-api', 'failed', 'a1');
  await step('4. MR pipeline red');
  gitlab.pipeline('payments/billing-api', 'PAY-12/billing-api', 'success', 'a2');
  await step('5. pipeline green → review');
  await step('6. review findings → Developer');
  gitlab.pipeline('payments/billing-api', 'PAY-12/billing-api', 'success', 'a3');
  await step('7. green again → re-review');
  await step('8. QE runs locally (engine starts the stack)');
  await jira.transition('PAY-12', (await jira.getTransitions('PAY-12')).find((t) => t.to === 'Accepted')!.id);
  await step('9. PO accepts in Jira');
  for (const u of ['eve', 'dan', 'chi']) gitlab.approve('payments/billing-api', 1, u);
  gitlab.merge('payments/billing-api', 1);
  gitlab.job('payments/billing-api', 'main', 'deploy_preprod', 'success', new Date(Date.now() + 1000).toISOString());
  await step('10. merged + deployed → preprod check');
  log('');
  for (const v of await board(ctx)) log(`${v.key}: ${v.status} · ${v.credits.used}/${v.credits.limit} AI credits · MR ${gitlab.mrs[0]?.webUrl}`);
  return d;
}
