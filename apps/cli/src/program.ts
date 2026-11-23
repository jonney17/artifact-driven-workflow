import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Command, Option } from 'commander';
import { stringify } from 'yaml';
import {
  activity,
  artifact,
  board,
  type ContextApis,
  createContext,
  inbox,
  loadLocalConfig,
  questionsFor,
  runDemo,
  type SdlcContext,
  sdlcHome,
  storyView,
} from '@sdlc/app';
import { writeAgentFiles } from '@sdlc/hostgen';
import { TAKEOVER_REASONS, type HandbackAt, type TakeoverReason, type TakeoverStep } from '@sdlc/orchestrator';

const exec = promisify(execFile);

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injected in tests/demo; real clients otherwise. */
  apis?: ContextApis;
}

/** Which role may pass which gate (plan §2 "Gates", role-checked against `members`). */
export const GATE_ROLES: Record<string, string[]> = {
  proposal_approval: ['dev'],
  scenario_approval: ['qe'],
  story_acceptance: ['po'],
};

export function program(io: CliIO = { out: console.log, err: console.error }): Command {
  const p = new Command('sdlc').description('Artifact-driven agentic SDLC engine (Phase 1, local mode)').showHelpAfterError();
  const ctx = async (dryRun = false): Promise<SdlcContext> => createContext(await loadLocalConfig(), { ...(io.apis ? { apis: io.apis } : {}), dryRun });
  const json = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  /** Persist a CLI change to the workspace repo right away (the loop does the same each pass). */
  const push = async (c: SdlcContext, key: string, what: string) => {
    if (!c.dryRun) await c.ws.commitAndPush(`sdlc: ${what} (${c.local.user})`, [`.sdlc/work/stories/${key}`]);
  };
  const role = (c: SdlcContext) => c.team.members[c.local.user] ?? [];

  p.command('init')
    .description('write ~/.sdlc/config.yaml for this machine')
    .requiredOption('--workspace <path>', 'local clone of the <team>-sdlc-workspace repo')
    .requiredOption('--user <email>', 'your email, as in team.yaml members and Jira')
    .option('--allowance <n>', 'your monthly AI credits', (v) => Number(v))
    .option('--repo <name=path...>', 'local clone of a product repo (repeatable)')
    .action(async (o: { workspace: string; user: string; allowance?: number; repo?: string[] }) => {
      const file = process.env.SDLC_CONFIG ?? join(sdlcHome(), 'config.yaml');
      const repos = Object.fromEntries((o.repo ?? []).map((r) => r.split('=') as [string, string]));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, stringify({ workspace: o.workspace, user: o.user, ...(o.allowance ? { monthly_allowance: o.allowance } : {}), repos }), 'utf8');
      io.out(`wrote ${file}`);
    });

  p.command('doctor')
    .description('check config, team.yaml, credentials and tools')
    .action(async () => {
      const checks: [string, () => Promise<string>][] = [
        ['local config', async () => (await loadLocalConfig()).workspace],
        ['team.yaml + pack', async () => {
          const c = await ctx(true);
          return `${c.workflow.overlay.team} on ${c.pack.name}@${c.pack.major}, ${c.workflow.contracts.length} contracts`;
        }],
        ['git', async () => (await exec('git', ['--version'])).stdout.trim()],
        ['Jira credentials (engine only)', async () => (process.env.JIRA_PAT || (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) ? 'set' : Promise.reject(new Error('set JIRA_EMAIL + JIRA_API_TOKEN, or JIRA_PAT')))],
        ['docker (QE local stack)', async () => (await exec('docker', ['--version'])).stdout.trim()],
        ['Copilot SDK', async () => {
          await import(/* @vite-ignore */ '@github/copilot-sdk' as string);
          return 'installed';
        }],
      ];
      let failed = 0;
      for (const [name, check] of checks) {
        try {
          io.out(`✔ ${name}: ${await check()}`);
        } catch (e) {
          failed++;
          io.out(`✘ ${name}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      if (failed) process.exitCode = 1;
    });

  p.command('build')
    .description('generate .github/agents/sdlc-*.agent.md in the workspace repo from the pack and overlay')
    .action(async () => {
      const c = await ctx(true);
      for (const f of await writeAgentFiles(c.local.workspace, c.agentFiles)) io.out(`wrote ${f}`);
    });

  p.command('run')
    .description('run the engine loop: Jira intake, agents, GitLab and Jira sync')
    .option('--once', 'one pass, then exit')
    .option('--dry-run', 'read real Jira/GitLab, write nothing outbound; artifacts in a scratch folder')
    .option('--interval <seconds>', 'seconds between passes', (v) => Number(v))
    .action(async (o: { once?: boolean; dryRun?: boolean; interval?: number }) => {
      const c = await ctx(!!o.dryRun);
      const interval = (o.interval ?? c.workflow.overlay.runtime.poll.jira_seconds) * 1000;
      if (o.dryRun) io.out(`dry run: artifacts in ${c.workRoot}`);
      for (;;) {
        const r = await c.loop.once();
        const ran = Object.entries(r.ticks).flatMap(([k, t]) => t.dispatched.map((d) => `${k} ${d.instance}#${d.attempt}:${d.result}`));
        io.out(`[${new Date().toISOString()}] owned ${r.owned.join(', ') || 'none'}${r.skipped.length ? `; skipped ${r.skipped.map((s) => s.key).join(', ')}` : ''}${ran.length ? `; ran ${ran.join(', ')}` : ''}`);
        if (o.once) return;
        await new Promise((res) => setTimeout(res, interval));
      }
    });

  p.command('status [key]')
    .description('the Board, or one story')
    .option('--json')
    .action(async (key: string | undefined, o: { json?: boolean }) => {
      const c = await ctx();
      if (key) {
        const v = await storyView(c, key);
        if (o.json) return json(v);
        io.out(`${v.key}  ${v.status ?? '-'}  repos: ${v.repos.join(', ') || '-'}  credits: ${v.credits.used}/${v.credits.limit}`);
        for (const i of v.instances) io.out(`  ${i.instance.padEnd(36)} ${i.state} (attempt ${i.attempt})`);
        for (const g of v.gates) io.out(`  gate ${g.gate}: ${g.artifact} v${g.version}`);
        for (const q of v.questions) io.out(`  question ${q.id} (${q.route}, ${q.status}): ${q.text}`);
        return;
      }
      const all = await board(c);
      if (o.json) return json(all);
      if (!all.length) io.out('no stories yet: run `sdlc run --once`');
      for (const v of all) io.out(`${v.key.padEnd(10)} ${(v.status ?? '-').padEnd(22)} gates ${v.gates.length}  questions ${v.questions.length}  credits ${v.credits.used}/${v.credits.limit}`);
    });

  p.command('inbox')
    .description('what needs you: gates, questions, blocked steps, budget')
    .action(async () => {
      const items = await inbox(await ctx());
      if (!items.length) io.out('inbox empty');
      for (const i of items) io.out(`${i.kind.padEnd(8)} ${i.story.padEnd(10)} ${i.id}: ${i.text}`);
    });

  p.command('show <key> <artifactId>')
    .description('print an artifact')
    .action(async (key: string, id: string) => {
      const a = await artifact(await ctx(), key, id);
      if (!a) throw new Error(`${id} not found`);
      io.out(`${a.envelope.id} (${a.envelope.type} v${a.envelope.version}, ${a.envelope.status}, by ${a.envelope.produced_by})\n\n${a.body}`);
    });

  p.command('log <key>')
    .description("a story's recent events")
    .option('-n <count>', 'how many', (v) => Number(v), 30)
    .action(async (key: string, o: { n: number }) => {
      for (const e of await activity(await ctx(), key, o.n)) io.out(`${e.ts}  ${e.type.padEnd(18)} ${e.instance ?? ''}${e.attempt ? ` #${e.attempt}` : ''}${e.data.reason ? `  ${e.data.reason}` : ''}`);
    });

  const gateOf = (c: SdlcContext, type: string) => c.workflow.contracts.find((x) => x.contract.outputs.some((o) => o.type === type && o.gated) && x.contract.gate)?.contract.gate;
  p.command('approve <key> <artifactId>')
    .description('pass a gate (role-checked)')
    .action(async (key: string, id: string) => {
      const c = await ctx();
      const a = await c.store.get(key, id);
      if (!a) throw new Error(`${id} not found`);
      const gate = gateOf(c, a.envelope.type);
      if (!gate) throw new Error(`${a.envelope.type} has no gate`);
      const need = GATE_ROLES[gate] ?? [];
      if (need.length && !role(c).some((r) => need.includes(r))) throw new Error(`${gate} needs role ${need.join(' or ')}; you have ${role(c).join(', ') || 'none'}`);
      await c.engine.passGate(key, id, c.local.user);
      await push(c, key, `approve ${id}`);
      io.out(`approved ${id} v${a.envelope.version}`);
    });

  p.command('reject <key> <artifactId>')
    .description('reject a gate; the producer gets your feedback as rework')
    .requiredOption('--reason <text>')
    .action(async (key: string, id: string, o: { reason: string }) => {
      const c = await ctx();
      await c.engine.rejectGate(key, id, c.local.user, o.reason);
      await push(c, key, `reject ${id}`);
      io.out(`rejected ${id}`);
    });

  p.command('questions')
    .description('open questions routed to you')
    .action(async () => {
      const qs = await questionsFor(await ctx());
      if (!qs.length) io.out('no open questions for you');
      for (const q of qs) io.out(`${q.story} ${q.id} (${q.route}, ${q.status}) from ${q.instance}: ${q.text}${q.options ? `  [${q.options.join(' | ')}]` : ''}`);
    });

  p.command('answer <key> <questionId> <text...>')
    .description('answer a question routed to you')
    .action(async (key: string, id: string, text: string[]) => {
      const c = await ctx();
      const r = await c.questions.answer(key, id.toUpperCase(), text.join(' '), c.local.user);
      if (r === 'rejected') throw new Error(`${id} isn't routed to ${c.local.user}`);
      await push(c, key, `answer ${id}`);
      io.out(`${id}: ${r}`);
    });

  const budget = p.command('budget').description('AI credits: per story, and your own month (shown only to you)');
  budget.action(async () => {
    const c = await ctx();
    const used = await c.budget.monthUsed();
    const allowance = c.local.monthly_allowance ?? c.team.budget.personal_reserve.monthly_allowance_default;
    io.out(`your month: ${used} / ${allowance} AI credits (reserve stop at ${Math.round(allowance * c.team.budget.personal_reserve.stop_at_share)})`);
    for (const v of await board(c)) io.out(`${v.key.padEnd(10)} ${v.credits.used} / ${v.credits.limit}`);
  });
  budget
    .command('raise <key> <amount>')
    .description('more AI credits for one story (unblocks blocked: budget)')
    .action(async (key: string, amount: string) => {
      const c = await ctx();
      await c.engine.raiseBudget(key, Number(amount), c.local.user);
      await push(c, key, `budget raise ${key}`);
      io.out(`raised ${key} by ${amount}`);
    });

  p.command('takeover <key> [repo]')
    .description('take a step away from the agents (plan §6a)')
    .addOption(new Option('--step <step>').choices(['develop', 'planner', 'qe-write', 'qe-run']).default('develop'))
    .addOption(new Option('--reason <reason>').choices([...TAKEOVER_REASONS]).makeOptionMandatory())
    .requiredOption('--note <text>')
    .action(async (key: string, repo: string | undefined, o: { step: TakeoverStep; reason: TakeoverReason; note: string }) => {
      const c = await ctx();
      const needQe = o.step === 'qe-write' || o.step === 'qe-run';
      if (needQe && !role(c).includes('qe')) throw new Error(`${o.step} takeover needs role qe`);
      const stopped = await c.takeovers.takeover({ story: key, ...(repo ? { repo } : {}), step: o.step, reason: o.reason, note: o.note, by: c.local.user });
      await push(c, key, `takeover ${key} ${o.step}`);
      io.out(`taken over: ${stopped.join(', ')}`);
    });

  p.command('handback <key> [repo]')
    .description('hand a step back to the agents at a stage')
    .addOption(new Option('--step <step>').choices(['develop', 'planner', 'qe-write', 'qe-run']).default('develop'))
    .addOption(new Option('--at <stage>').choices(['develop', 'review', 'qe', 'gate', 'qe-write', 'done', 'judge']).makeOptionMandatory())
    .option('--summary <text>')
    .action(async (key: string, repo: string | undefined, o: { step: TakeoverStep; at: HandbackAt; summary?: string }) => {
      const c = await ctx();
      await c.takeovers.handback({ story: key, ...(repo ? { repo } : {}), step: o.step, at: o.at, by: c.local.user, ...(o.summary ? { summary: o.summary } : {}) });
      await push(c, key, `handback ${key} at ${o.at}`);
      io.out(`handed back ${key}${repo ? ` ${repo}` : ''} at ${o.at}`);
    });

  p.command('demo')
    .description('run one story from Jira to Done on this machine with fake Jira/GitLab and scripted agents')
    .action(async () => {
      await runDemo(io.out);
    });

  p.command('serve')
    .description('start the local API and Web UI (only the story owner can reach it)')
    .option('--port <port>', 'port', (v) => Number(v), 4317)
    .action(async (o: { port: number }) => {
      const { startServer } = await import('./serve');
      await startServer(await ctx(), o.port, io.out);
    });

  return p;
}

export async function readVersion(): Promise<string> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
}
