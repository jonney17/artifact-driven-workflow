import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ContractOutputSchema } from '@sdlc/contracts';
import { CopilotRunner, readOutputs } from '../src/copilot/copilot.runner';
import type { CopilotSdk, CopilotSession, CopilotSessionOptions, CopilotTurnResult } from '../src/copilot/sdk';
import { QuestionRouter } from '../src/questions';
import type { AttemptRequest } from '../src/runner';

const exec = promisify(execFile);
const tmp = (p = 'sdlc-rt-') => mkdtemp(join(tmpdir(), p));

async function gitRepo(): Promise<string> {
  const dir = await tmp('sdlc-wt-');
  await exec('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  await exec('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await exec('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(join(dir, 'App.java'), 'class App {}\n');
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['commit', '--quiet', '-m', 'init'], { cwd: dir });
  return dir;
}

/** A scripted stand-in for the Copilot SDK: each `send` runs a script that acts like the agent. */
class FakeSdk implements CopilotSdk {
  readonly created: CopilotSessionOptions[] = [];
  readonly resumed: string[] = [];
  readonly prompts: string[] = [];
  private n = 0;
  constructor(private readonly script: (o: CopilotSessionOptions, prompt: string, call: number) => Promise<CopilotTurnResult>) {}
  private session(o: CopilotSessionOptions, id: string): CopilotSession {
    let aborted = false;
    return {
      id,
      send: async (prompt) => {
        this.prompts.push(prompt);
        const r = await this.script(o, prompt, this.prompts.length);
        return aborted ? { stopReason: 'aborted' } : r;
      },
      abort: async () => void (aborted = true),
      close: async () => undefined,
    };
  }
  async createSession(o: CopilotSessionOptions) {
    this.created.push(o);
    return this.session(o, `s-${++this.n}`);
  }
  async resumeSession(id: string, o: CopilotSessionOptions) {
    this.resumed.push(id);
    return this.session(o, id);
  }
}

const outputs = {
  developer: [
    ContractOutputSchema.parse({ type: 'code', scope: 'repo', required_sections: ['Summary'] }),
    ContractOutputSchema.parse({ type: 'mr-description', scope: 'repo' }),
  ],
};

function request(workdir: string, extra: Partial<AttemptRequest> = {}): AttemptRequest {
  return {
    instance: 'developer:PAY-1:api',
    contractId: 'developer',
    agent: 'developer',
    story: 'PAY-1',
    repo: 'api',
    attempt: 1,
    workdir,
    inputs: [{ envelope: { id: 'proposal-PAY-1-api', type: 'proposal', version: 2, status: 'approved', produced_by: 'planner#1', story: 'PAY-1', repo: 'api', derived_from: [] }, body: '## Interfaces & test hooks\nPOST /invoices' }],
    reworkInputs: [],
    policy: { tools: ['read', 'edit', 'shell:build', 'ask_human'], maxTurns: 40, writeAllow: ['**'], writeDeny: ['.sdlc/**'], shellCommands: { build: 'mvn -q verify' }, model: 'm-1' },
    ...extra,
  };
}

async function router(storyRoot: string, liveWaitMs = 50) {
  return new QuestionRouter({
    storyDir: (s) => join(storyRoot, s),
    routes: { requirement: 'po', technical: 'responsible_dev', test: 'qe', environment: 'sm' },
    people: async (_s, role) => (role === 'responsible_dev' ? ['bob@corp'] : role === 'po' ? ['alice@corp'] : []),
    liveWaitMs,
  });
}

describe('Copilot runner (fake SDK)', () => {
  it('one fresh session in the worktree with the generated agent, the policy, a stripped env, and outputs from .sdlc-out', async () => {
    const wt = await gitRepo();
    const sdk = new FakeSdk(async (o) => {
      // the "agent": asks permission, edits a file, writes outputs
      expect(await o.onPermissionRequest({ kind: 'write', path: 'src/Invoice.java' })).toBe(true);
      expect(await o.onPermissionRequest({ kind: 'shell', command: 'git push' })).toBe(false);
      await mkdir(join(wt, 'src'), { recursive: true });
      await writeFile(join(wt, 'src', 'Invoice.java'), 'class Invoice {}\n');
      await writeFile(join(wt, '.sdlc-out', 'code.md'), '# Code\n\n## Summary\n\ndone\n');
      await writeFile(join(wt, '.sdlc-out', 'mr-description.md'), '## Summary\n');
      return { stopReason: 'end_turn', usage: { modelCalls: [{ model: 'm-1', count: 3 }] } };
    });
    const runner = new CopilotRunner({ sdk, questions: await router(await tmp()), outputsOf: (c) => outputs[c as 'developer'], templates: { code: '## Summary' }, creditRates: { 'm-1': 10 }, env: { PATH: '/bin', GITLAB_TOKEN: 'secret' } });
    const r = await runner.run(request(wt));
    expect(r).toMatchObject({ status: 'done', sessionId: 's-1', changedFiles: ['src/Invoice.java'], aiCredits: 30 });
    if (r.status !== 'done') return;
    expect(r.outputs.map((o) => o.type)).toEqual(['code', 'mr-description']);
    const o = sdk.created[0]!;
    expect(o).toMatchObject({ agent: 'sdlc-developer', cwd: wt, model: 'm-1' });
    expect(o.env.GITLAB_TOKEN).toBeUndefined();
    expect(o.tools.map((t) => t.name)).toEqual(['ask_human']);
    expect(sdk.prompts[0]).toContain('### proposal-PAY-1-api (proposal v2, approved)');
    expect(sdk.prompts[0]).toContain('`code` → `.sdlc-out/code.md`');
    expect(sdk.prompts[0]).not.toMatch(/session|transcript/i);
    expect(await readFile(join(wt, '.git', 'info', 'exclude'), 'utf8')).toContain('.sdlc-out/');
  });

  it('ask_human answered inside the live window continues the same session', async () => {
    const wt = await gitRepo();
    const root = await tmp();
    const q = await router(root, 5_000);
    const sdk = new FakeSdk(async (o) => {
      const pending = o.tools[0]!.handler({ question: 'ISO dates?', category: 'technical' });
      await new Promise((r) => setTimeout(r, 20));
      expect(await q.answer('PAY-1', 'Q-1', 'yes, ISO 8601', 'eve@corp')).toBe('rejected'); // not routed to eve
      expect(await q.answer('PAY-1', 'Q-1', 'yes, ISO 8601', 'bob@corp')).toBe('live');
      expect(await pending).toContain('yes, ISO 8601');
      await writeFile(join(wt, '.sdlc-out', 'code.md'), '## Summary\nx');
      await writeFile(join(wt, '.sdlc-out', 'mr-description.md'), 'x');
      return { stopReason: 'end_turn', usage: { aiCredits: 7 } };
    });
    const r = await new CopilotRunner({ sdk, questions: q, outputsOf: () => outputs.developer, templates: {} }).run(request(wt));
    expect(r).toMatchObject({ status: 'done', aiCredits: 7 });
    expect(await readFile(join(root, 'PAY-1', 'decisions.md'), 'utf8')).toContain('- Answer: yes, ISO 8601 (by bob@corp)');
  });

  it('no answer in the window: the session stops as waiting; a late answer resumes the same session id', async () => {
    const wt = await gitRepo();
    const root = await tmp();
    const late: string[] = [];
    const q = new QuestionRouter({
      storyDir: (s) => join(root, s),
      routes: { requirement: 'po', technical: 'responsible_dev', test: 'qe', environment: 'sm' },
      people: async () => ['alice@corp'],
      liveWaitMs: 20,
      onLateAnswer: async (x) => void late.push(x.id),
    });
    const sdk = new FakeSdk(async (o, prompt, call) => {
      if (call === 1) {
        const res = await o.tools[0]!.handler({ question: 'Refunds in scope?', category: 'requirement' });
        expect(res).toContain('NO_ANSWER_YET');
        return { stopReason: 'end_turn' };
      }
      expect(prompt).toContain('Refunds are out of scope');
      await writeFile(join(wt, '.sdlc-out', 'code.md'), '## Summary\nx');
      await writeFile(join(wt, '.sdlc-out', 'mr-description.md'), 'x');
      return { stopReason: 'end_turn' };
    });
    const runner = new CopilotRunner({ sdk, questions: q, outputsOf: () => outputs.developer, templates: {} });
    const r1 = await runner.run(request(wt));
    expect(r1).toEqual({ status: 'waiting', sessionId: 's-1', question: { route: 'requirement', text: 'Refunds in scope?' } });
    expect((await q.get('PAY-1', 'Q-1'))?.status).toBe('waiting');
    expect(await q.answer('PAY-1', 'Q-1', 'Refunds are out of scope', 'alice@corp')).toBe('late');
    expect(late).toEqual(['Q-1']);
    const answer = { envelope: { id: 'answer-x', type: 'answer', version: 1, status: 'open', produced_by: 'human:alice', story: 'PAY-1', derived_from: [] }, body: 'Refunds are out of scope' };
    const r2 = await runner.run(request(wt, { resumeSessionId: 's-1', reworkInputs: [answer] }));
    expect(r2.status).toBe('done');
    expect(sdk.resumed).toEqual(['s-1']);
    expect(sdk.created).toHaveLength(1);
  });

  it('non-blocking questions proceed with the recommended option, recorded as an assumption', async () => {
    const root = await tmp();
    const q = await router(root);
    expect(await q.ask({ story: 'PAY-1', instance: 'i', attempt: 1, route: 'technical', text: 'Use BigDecimal?', recommended: 'yes', blocking: false })).toEqual({ kind: 'assumed', answer: 'yes', questionId: 'Q-1' });
    expect(await readFile(join(root, 'PAY-1', 'decisions.md'), 'utf8')).toContain('- Assumption: yes');
    expect(QuestionRouter.parseAnswerCommand('/sdlc answer q-3: use ISO')).toEqual({ id: 'Q-3', text: 'use ISO' });
    expect(QuestionRouter.parseAnswerCommand('looks good')).toBeUndefined();
  });

  it('max turns and SDK errors fail the attempt; output files are parsed with repo and number', async () => {
    const wt = await gitRepo();
    const sdk = new FakeSdk(async () => ({ stopReason: 'max_turns' }));
    expect(await new CopilotRunner({ sdk, questions: await router(await tmp()), outputsOf: () => [], templates: {} }).run(request(wt))).toMatchObject({ status: 'failed', reason: 'max turns (40) reached' });
    const broken: CopilotSdk = { createSession: async () => Promise.reject(new Error('not signed in')), resumeSession: async () => Promise.reject(new Error('x')) };
    expect(await new CopilotRunner({ sdk: broken, questions: await router(await tmp()), outputsOf: () => [], templates: {} }).run(request(wt))).toMatchObject({ status: 'failed', reason: 'not signed in' });
    const out = join(await tmp(), 'o');
    await mkdir(out);
    await writeFile(join(out, 'proposal--api.md'), 'p');
    await writeFile(join(out, 'defect--web--2.md'), 'd');
    expect((await readOutputs(out)).map((o) => [o.type, o.repo])).toEqual([
      ['defect', 'web'],
      ['proposal', 'api'],
    ]);
  });
});
