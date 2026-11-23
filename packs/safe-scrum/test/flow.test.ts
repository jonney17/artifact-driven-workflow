import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore, Engine, EventLog, loadPack, resolveWorkflow } from '@sdlc/orchestrator';
import { type AttemptRequest, type AttemptResult, StubRunner } from '@sdlc/runtimes';
import {
  FakeGitLab,
  FakeJira,
  GitLabConfigSchema,
  JiraConfigSchema,
  JiraInbound,
  JiraOutbound,
  LifecycleConfigSchema,
  MrSync,
  StorySync,
} from '@sdlc/integrations';

const PACK = resolve(import.meta.dirname, '..');

const doc = (title: string, sections: Record<string, string>, verdict?: string) =>
  [`# ${title}`, '', ...(verdict ? [`Verdict: ${verdict}`, ''] : []), ...Object.entries(sections).flatMap(([h, b]) => [`## ${h}`, '', b, ''])].join('\n');

const done = (r: AttemptRequest, sessionId: string, outputs: { type: string; repo?: string; body: string }[], changedFiles: string[] = []): AttemptResult => ({
  status: 'done',
  sessionId,
  outputs,
  changedFiles,
  aiCredits: 50,
});

describe('pack safe-scrum', () => {
  it('loads, and every contract agent has a prompt', async () => {
    const pack = await loadPack(PACK);
    expect(pack.contracts.map((c) => c.id)).toEqual(['planner', 'qe-define', 'developer', 'qe-write', 'reviewer', 'qe-run', 'qe-preprod']);
    expect(Object.keys(pack.agents!)).toEqual(['planner', 'qe', 'developer', 'reviewer', 'coach']);
  });

  it('runs one story end to end: Jira intake → plan → gates → dev + tests → MR → review rework → QE locally → PO → merge → preprod → Done', async () => {
    const pack = await loadPack(PACK);
    const overlay = {
      pack: 'safe-scrum@1',
      team: 'payments',
      repos: { api: { path: '../api', gitlab_project: 'pay/api', test_dirs: ['src/acceptance'] } },
      security: { sensitive_paths: ['**/pom.xml', '.gitlab-ci.yml'] },
      limits: { review_rounds: 2, defect_rounds: 3, concurrency: 4 },
    };
    const workflow = resolveWorkflow(pack, overlay);
    const root = await mkdtemp(join(tmpdir(), 'sdlc-flow-'));
    const store = new ArtifactStore(root);
    const events = new EventLog(root);
    const env: string[] = [];

    let reviews = 0;
    const runner = new StubRunner()
      .on('planner', (r, { sessionId }) =>
        done(r, sessionId, [
          { type: 'explore', body: doc('Explore', { 'Affected repos': '- `api`: invoice endpoint', Reuse: 'Money type', Risks: 'none' }) },
          {
            type: 'proposal',
            repo: 'api',
            body: doc('Proposal', { Summary: 'POST /invoices (PAY-1-AC1, PAY-1-AC2)', 'Interfaces & test hooks': 'POST /invoices {amount}', 'Sensitive changes': 'none', Tasks: '- [ ] endpoint (PAY-1-AC1)' }),
          },
        ]),
      )
      .on('qe-define', (r, { sessionId }) => done(r, sessionId, [{ type: 'test-scenarios', repo: 'api', body: doc('Scenarios', { Scenarios: 'S1 Given…', 'AC coverage': 'PAY-1-AC1: S1' }) }]))
      .on('developer', (r, { sessionId }) =>
        done(
          r,
          sessionId,
          [
            { type: 'code', body: doc('Code', { Summary: `attempt ${r.attempt}, rework: ${r.reworkInputs.map((a) => a.envelope.type).join(',') || 'none'}`, Changes: 'src/Invoice.java', 'Self-check': 'green' }) },
            { type: 'mr-description', body: doc('MR', { Summary: 's', 'AC covered': 'PAY-1-AC1', 'Interfaces touched': 'POST /invoices', Assumptions: 'none', 'How to test': 'mvn verify' }) },
          ],
          ['src/main/java/Invoice.java'],
        ),
      )
      .on('qe-write', (r, { sessionId }) => done(r, sessionId, [{ type: 'test-code', body: doc('Tests', { 'Tests written': 'InvoiceIT', 'Dry run': 'red: 404' }) }], ['src/acceptance/InvoiceIT.java']))
      .on('reviewer', (r, { sessionId }) =>
        ++reviews === 1
          ? done(r, sessionId, [{ type: 'review', body: doc('Review', { Findings: '- **major** `src/Invoice.java:12`: total ignores tax' }, 'changes_requested') }])
          : done(r, sessionId, [{ type: 'review', body: doc('Review', { Findings: 'none' }, 'approved') }]),
      )
      .on('qe-run', (r, { sessionId }) =>
        done(r, sessionId, [{ type: 'story-acceptance', body: doc('Acceptance', { 'AC matrix': '| PAY-1-AC1 | InvoiceIT | pass |', Evidence: 'trace.zip', Failures: 'none' }, 'pass') }]),
      )
      .on('qe-preprod', (r, { sessionId }) => done(r, sessionId, [{ type: 'preprod-check', body: doc('Preprod', { Results: 'smoke green' }, 'pass') }]));

    const envOf = (name: string) => ({
      acquire: async () => {
        env.push(`${name} up`);
        return async () => void env.push(`${name} down`);
      },
    });
    const engine = new Engine({ store, events, runner, workflow, environments: { local_stack: envOf('local_stack'), preprod: envOf('preprod') } });

    const bob = { accountId: 'u-bob', email: 'bob@corp' };
    const jira = new FakeJira(bob);
    jira.put({ key: 'PAY-1', summary: 'Create invoices', assignee: bob, acceptanceCriteria: '- invoice is created\n- total includes tax', labels: ['repo-api'] });
    const jiraCfg = JiraConfigSchema.parse({
      site: 'https://corp.atlassian.net',
      project: 'PAY',
      intake_jql: 'project = PAY AND sprint in openSprints() AND issuetype = Story',
      fields: { repos: 'labels:repo-*' },
      status_map: { refining: 'In Refinement', in_progress: 'In Progress', in_review: 'In Review', in_qa: 'In QA', ready_for_acceptance: 'Ready for Acceptance', done: 'Done' },
      gates_from_jira: { story_acceptance: { transition: 'Accepted' }, scenario_approval: { comment_command: '/sdlc approve scenarios', role: 'qe' } },
    });
    const lifecycle = LifecycleConfigSchema.parse({});
    const gl = new FakeGitLab();
    const glCfg = GitLabConfigSchema.parse({ url: 'https://gitlab.test' });
    const pushed: string[] = [];
    const sync = new StorySync({
      store,
      events,
      engine,
      inbound: new JiraInbound(jira, store, { jira: jiraCfg, lifecycle, owner: 'assignee', reposOf: async (_k, h) => h }),
      jira,
      jiraCfg,
      lifecycle,
      gitlab: gl,
      mr: new MrSync(gl, glCfg),
      outbound: new JiraOutbound(jira, jiraCfg),
      repos: { api: { path: '/repos/api', gitlabProject: 'pay/api', branch: 'main' } },
      members: { 'alice@corp': ['po'], 'bob@corp': ['dev'], 'chi@corp': ['qe'] },
      statusRules: pack.jiraStatus!,
      preprodJob: 'deploy_preprod',
      push: async (_p, b) => void pushed.push(b),
    });

    /** One engine loop pass for this story (without the workspace git, which loop.test covers). */
    const cycle = async () => {
      const [s] = await sync.assigned(['PAY-1']);
      if (!s) return [];
      await sync.syncIn(s);
      const t = await engine.tick({ key: s.key, repos: s.repos, owned: true });
      await sync.syncOut(s, t);
      return t.dispatched.map((d) => `${d.instance}#${d.attempt}:${d.result}`);
    };
    const status = () => jira.issues.get('PAY-1')!.status;
    const art = async (id: string) => (await store.get('PAY-1', id))?.envelope.status;

    // 1. planning
    expect(await cycle()).toEqual(['planner:PAY-1#1:done']);
    expect(status()).toBe('In Refinement');
    expect(await cycle()).toEqual(['qe-define:PAY-1#1:done']);
    expect(await cycle()).toEqual([]); // waiting for both gates

    // 2. gates: the responsible dev approves the proposal (CLI/UI); QE approves the scenarios in Jira
    await engine.passGate('PAY-1', 'proposal-PAY-1-api', 'bob@corp');
    jira.humanComment('PAY-1', { accountId: 'u-eve', email: 'eve@corp' }, '/sdlc approve scenarios'); // not a QE: ignored
    expect(await cycle()).toEqual([]);
    jira.humanComment('PAY-1', { accountId: 'u-chi', email: 'chi@corp' }, '/sdlc approve scenarios');
    expect((await cycle()).sort()).toEqual(['developer:PAY-1:api#1:done', 'qe-write:PAY-1:api#1:done']);
    expect(status()).toBe('In Review');

    // 3. MR: one Draft MR, red pipeline → rework, green → review
    expect(gl.mrs).toHaveLength(1);
    expect(gl.mrs[0]).toMatchObject({ draft: true, sourceBranch: 'PAY-1/api', labels: ['sdlc'] });
    expect(pushed).toContain('PAY-1/api');
    gl.pipeline('pay/api', 'PAY-1/api', 'failed', 'sha1');
    expect(await cycle()).toEqual(['developer:PAY-1:api#2:done']);
    expect((await store.get('PAY-1', 'code-PAY-1-api'))!.body).toContain('rework: pipeline-failure');
    gl.pipeline('pay/api', 'PAY-1/api', 'success', 'sha2');
    expect(await cycle()).toEqual(['reviewer:PAY-1:api#1:done']);
    expect(await art('review-PAY-1-api')).toBe('changes_requested');
    expect(gl.notes.get('pay/api!1')?.[0]?.body).toContain('total ignores tax');

    // 4. review rework → new commit → green → approved
    expect(await cycle()).toEqual(['developer:PAY-1:api#3:done']);
    gl.pipeline('pay/api', 'PAY-1/api', 'success', 'sha3');
    expect(await cycle()).toEqual(['reviewer:PAY-1:api#2:done']);
    expect(status()).toBe('In QA');

    // 5. QE (c) locally, inside the engine-started stack
    expect(await cycle()).toEqual(['qe-run:PAY-1#1:done']);
    expect(env).toEqual(['local_stack up', 'local_stack down']);
    expect(await art('story-acceptance-PAY-1')).toBe('ready');
    expect(gl.mrs[0]!.draft).toBe(false);
    expect(status()).toBe('Ready for Acceptance');

    // 6. PO accepts in Jira; humans approve and merge; CI deploys main to preprod
    await jira.transition('PAY-1', (await jira.getTransitions('PAY-1')).find((t) => t.to === 'Accepted')!.id);
    expect(await cycle()).toEqual([]);
    expect(await art('story-acceptance-PAY-1')).toBe('approved');
    gl.approve('pay/api', 1, 'eve');
    gl.approve('pay/api', 1, 'dan');
    gl.approve('pay/api', 1, 'chi');
    gl.merge('pay/api', 1, '2026-11-23T10:00:00Z');
    gl.job('pay/api', 'main', 'deploy_preprod', 'success', '2026-11-23T09:00:00Z'); // an older deploy: not yet
    expect(await cycle()).toEqual([]);
    gl.job('pay/api', 'main', 'deploy_preprod', 'success', '2026-11-23T10:05:00Z');
    expect(await cycle()).toEqual(['qe-preprod:PAY-1#1:done']);
    expect(env.slice(2)).toEqual(['preprod up', 'preprod down']);
    expect(status()).toBe('Done');

    // 7. idempotent: more cycles change nothing outside
    const before = { comments: (await jira.getComments('PAY-1')).length, calls: [...gl.calls], mrs: gl.mrs.length, links: (await jira.getRemoteLinks('PAY-1')).length };
    expect(await cycle()).toEqual([]);
    expect(await cycle()).toEqual([]);
    expect({ comments: (await jira.getComments('PAY-1')).length, calls: gl.calls, mrs: gl.mrs.length, links: (await jira.getRemoteLinks('PAY-1')).length }).toEqual(before);
    expect(before.links).toBe(1);
    expect(gl.mrs[0]!.approvedBy).toEqual(['eve', 'dan', 'chi']); // only humans approved
    expect(runner.calls.every((c) => !JSON.stringify(c).match(/token|password/i))).toBe(true);
  });
});
