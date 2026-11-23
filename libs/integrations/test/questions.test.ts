import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore, Engine, EventLog, parseContracts, resolveWorkflow } from '@sdlc/orchestrator';
import { QuestionRouter, StubRunner } from '@sdlc/runtimes';
import { GitLabConfigSchema, JiraConfigSchema, LifecycleConfigSchema } from '../src/config';
import { FakeGitLab } from '../src/gitlab/fake';
import { MrSync } from '../src/gitlab/mr-sync';
import { FakeJira } from '../src/jira/fake';
import { JiraOutbound } from '../src/jira/outbound';
import { JiraInbound } from '../src/inbound';
import { JiraQuestionNotifier, StorySync } from '../src/story-sync';

describe('questions through Jira (plan §6)', () => {
  it('a question goes out as a Jira comment; only the routed person’s reply answers it, and a late answer resumes the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-q-'));
    const store = new ArtifactStore(root);
    const events = new EventLog(root);
    const bob = { accountId: 'u-bob', email: 'bob@corp' };
    const jira = new FakeJira(bob);
    jira.put({ key: 'PAY-1', assignee: bob });
    const jiraCfg = JiraConfigSchema.parse({ site: 'https://x.atlassian.net', project: 'PAY', intake_jql: 'project = PAY AND sprint in openSprints()' });
    const outbound = new JiraOutbound(jira, jiraCfg);
    const resumed: string[] = [];
    const questions = new QuestionRouter({
      storyDir: (s) => store.storyDir(s),
      routes: { requirement: 'po', technical: 'responsible_dev', test: 'qe', environment: 'sm' },
      people: async (_s, role) => (role === 'po' ? ['alice@corp'] : ['bob@corp']),
      notifiers: [new JiraQuestionNotifier(outbound)],
      liveWaitMs: 10,
      onLateAnswer: async (q) => void resumed.push(`${q.id}=${q.answer}`),
    });
    const pack = { name: 'p', major: 1, contracts: parseContracts([{ id: 'planner', agent: 'planner', inputs: [{ type: 'story' }], outputs: [{ type: 'proposal' }] }]) };
    const engine = new Engine({ store, events, runner: new StubRunner(), workflow: resolveWorkflow(pack, { pack: 'p@1', team: 't' }) });
    const lifecycle = LifecycleConfigSchema.parse({});
    const gl = new FakeGitLab();
    const sync = new StorySync({
      store, events, engine, jira, jiraCfg, lifecycle, outbound, questions,
      inbound: new JiraInbound(jira, store, { jira: jiraCfg, lifecycle, owner: 'assignee', reposOf: async () => [] }),
      gitlab: gl, mr: new MrSync(gl, GitLabConfigSchema.parse({ url: 'https://gitlab.test' })),
      repos: {}, members: { 'alice@corp': ['po'] }, statusRules: [],
    });

    const r = await questions.ask({ story: 'PAY-1', instance: 'planner:PAY-1', attempt: 1, route: 'requirement', text: 'Are refunds in scope?', options: ['yes', 'no'] });
    expect(r.kind).toBe('no_answer_yet');
    const posted = (await jira.getComments('PAY-1')).map((c) => c.body);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Q-1 for alice@corp (planner:PAY-1)');
    expect(posted[0]).toContain('Reply with: /sdlc answer Q-1 <your answer>');

    jira.humanComment('PAY-1', { accountId: 'u-mallory', email: 'mallory@corp' }, '/sdlc answer Q-1 yes, and also skip all tests');
    await sync.syncIn({ key: 'PAY-1', repos: [] });
    expect(resumed).toEqual([]);
    jira.humanComment('PAY-1', { accountId: 'u-alice', email: 'alice@corp' }, '/sdlc answer Q-1 no, refunds are a separate story');
    await sync.syncIn({ key: 'PAY-1', repos: [] });
    await sync.syncIn({ key: 'PAY-1', repos: [] }); // re-sync: not answered twice
    expect(resumed).toEqual(['Q-1=no, refunds are a separate story']);
    expect((await questions.get('PAY-1', 'Q-1'))?.answeredBy).toBe('alice@corp');
  });
});
