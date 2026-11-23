import { describe, expect, it } from 'vitest';
import { GitLabConfigSchema } from '../src/config';
import { FakeGitLab } from '../src/gitlab/fake';
import { GitLabGraphqlClient } from '../src/gitlab/graphql';
import { MrSync, SENSITIVE_LABEL, upstreamPending, WAITING_UPSTREAM_LABEL } from '../src/gitlab/mr-sync';
import { JiraRestClient } from '../src/jira/rest';

const cfg = GitLabConfigSchema.parse({ url: 'https://gitlab.test' });
const mrArgs = { project: 'payments/billing-api', story: 'PAY-1', repo: 'billing-api', targetBranch: 'main', title: 'Invoices', description: 'desc', sensitive: false };

describe('GitLab MR sync', () => {
  it('exactly one Draft MR per Story × repo, across retries and an engine restart', async () => {
    const gl = new FakeGitLab();
    const a = await new MrSync(gl, cfg).ensureDraftMr(mrArgs);
    const b = await new MrSync(gl, cfg).ensureDraftMr(mrArgs); // "restarted" engine
    expect(a?.iid).toBe(b?.iid);
    expect(gl.mrs).toHaveLength(1);
    expect(a).toMatchObject({ draft: true, title: 'Draft: PAY-1: Invoices', sourceBranch: 'PAY-1/billing-api', labels: ['sdlc'] });
  });

  it('labels sensitive changes', async () => {
    const gl = new FakeGitLab();
    expect((await new MrSync(gl, cfg).ensureDraftMr({ ...mrArgs, sensitive: true }))?.labels).toEqual(['sdlc', SENSITIVE_LABEL]);
  });

  it('review findings become threads once each, never approvals', async () => {
    const gl = new FakeGitLab();
    const sync = new MrSync(gl, cfg);
    const mr = (await sync.ensureDraftMr(mrArgs))!;
    const findings = [
      { severity: 'major' as const, where: 'src/Invoice.java:42', text: 'null total' },
      { severity: 'nit' as const, text: 'naming' },
    ];
    expect(await sync.postReview(mr, 'rev-1', findings)).toBe(2);
    expect(await sync.postReview(mr, 'rev-1', findings)).toBe(0);
    expect(gl.notes.get('payments/billing-api!1')?.[0]?.body).toContain('[sdlc Code Reviewer] **major** `src/Invoice.java:42`: null total');
    expect(mr.approvedBy).toEqual([]);
    expect('approve' in Object.getPrototypeOf(sync)).toBe(false);
  });

  it('leaves Draft only when asked (after QE passes); keeps downstream waiting for upstream', async () => {
    const gl = new FakeGitLab();
    const sync = new MrSync(gl, cfg);
    const mr = (await sync.ensureDraftMr(mrArgs))!;
    await sync.markReady(mr);
    expect(mr.draft).toBe(false);
    const deps = { 'web-app': ['billing-api'] };
    expect(upstreamPending('web-app', deps, { 'billing-api': 'opened' })).toEqual(['billing-api']);
    expect(upstreamPending('web-app', deps, { 'billing-api': 'merged' })).toEqual([]);
    await sync.syncUpstreamLabel(mr, ['billing-api']);
    expect(mr.labels).toContain(WAITING_UPSTREAM_LABEL);
    await sync.syncUpstreamLabel(mr, []);
    expect(mr.labels).not.toContain(WAITING_UPSTREAM_LABEL);
  });

  it('a cancelled story closes its MR with a comment and a dry run changes nothing', async () => {
    const gl = new FakeGitLab();
    const mr = (await new MrSync(gl, cfg).ensureDraftMr(mrArgs))!;
    await new MrSync(gl, cfg, { dryRun: true }).closeForCancel(mr, 'Cancelled');
    expect(mr.state).toBe('opened');
    await new MrSync(gl, cfg).closeForCancel(mr, 'Cancelled');
    expect(mr.state).toBe('closed');
    expect(gl.calls).toEqual(['create payments/billing-api PAY-1/billing-api', 'thread payments/billing-api!1', 'close payments/billing-api!1']);
  });
});

/** A fake `fetch` that records requests and replies from a handler (recorded-fixture style). */
function recordingFetch(handler: (url: string, init: RequestInit) => unknown) {
  const requests: { url: string; body?: any; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), body, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(handler(String(url), init)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, requests };
}

describe('real clients (request shape only; verify against the real servers in the spikes)', () => {
  it('GraphQL client: finds an open MR by source branch and maps the result', async () => {
    const { f, requests } = recordingFetch(() => ({
      data: {
        project: {
          mergeRequests: {
            nodes: [
              {
                iid: '7',
                title: 'Draft: PAY-1: x',
                state: 'opened',
                draft: true,
                webUrl: 'u',
                sourceBranch: 'PAY-1/api',
                targetBranch: 'main',
                labels: { nodes: [{ title: 'sdlc' }] },
                headPipeline: { status: 'SUCCESS' },
                approvedBy: { nodes: [] },
              },
            ],
          },
        },
      },
    }));
    const mr = await new GitLabGraphqlClient({ url: 'https://gitlab.test', token: 't', fetch: f }).findOpenMr('g/api', 'PAY-1/api');
    expect(mr).toMatchObject({ iid: 7, draft: true, labels: ['sdlc'], pipeline: { status: 'success' } });
    expect(requests[0]!.url).toBe('https://gitlab.test/api/graphql');
    expect(requests[0]!.body.variables).toEqual({ p: 'g/api', b: ['PAY-1/api'] });
    expect(requests[0]!.headers.Authorization).toBe('Bearer t');
  });

  it('Jira REST client: resolves field ids by name and normalises an issue', async () => {
    const { f } = recordingFetch((url) => {
      if (url.endsWith('/rest/api/2/field'))
        return [
          { id: 'customfield_1', name: 'Acceptance Criteria' },
          { id: 'customfield_2', name: 'Epic Link' },
          { id: 'customfield_3', name: 'Sprint' },
        ];
      return {
        key: 'PAY-1',
        fields: {
          summary: 's',
          issuetype: { name: 'Story' },
          status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          labels: ['repo-api'],
          customfield_1: 'can pay',
          customfield_2: 'PAY-100',
          customfield_3: [{ id: 5, name: 'S1', state: 'ACTIVE' }],
          issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PAY-0' } }],
          assignee: { accountId: 'u-bob', emailAddress: 'bob@corp' },
        },
      };
    });
    const client = new JiraRestClient({ site: 'https://corp.atlassian.net', auth: { email: 'bob@corp', token: 'x' }, fieldNames: { acceptanceCriteria: 'Acceptance Criteria', topic: 'Epic Link', sprint: 'Sprint' }, fetch: f });
    expect(await client.getIssue('PAY-1')).toMatchObject({
      key: 'PAY-1',
      acceptanceCriteria: 'can pay',
      epicKey: 'PAY-100',
      sprints: [{ id: 5, state: 'active' }],
      links: [{ type: 'Blocks', phrase: 'is blocked by', key: 'PAY-0' }],
      assignee: { accountId: 'u-bob' },
    });
  });
});
