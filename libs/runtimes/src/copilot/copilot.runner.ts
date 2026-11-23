import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ContractOutput } from '@sdlc/contracts';
import { decidePermission, sessionEnv } from '../policy';
import type { QuestionRoute, QuestionRouter } from '../questions';
import type { AttemptRequest, AttemptResult, OutputDraft, Runner } from '../runner';
import { buildPrompt, OUT_DIR } from './prompt';
import type { CopilotSdk, CopilotSession, CopilotSessionOptions, CopilotTool } from './sdk';

const exec = promisify(execFile);

export interface CopilotRunnerOptions {
  sdk: CopilotSdk | (() => Promise<CopilotSdk>);
  questions: QuestionRouter;
  /** The contract outputs for a contract id (from the resolved pack). */
  outputsOf: (contractId: string) => ContractOutput[];
  /** Output templates by artifact type (pack `templates/<type>.md`). */
  templates: Record<string, string>;
  /** `decisions.md` of a story (Q&A so far), passed to every later session. */
  decisions?: (story: string) => Promise<string>;
  /** Installs the generated agent file and that agent's skills into the worktree (hostgen). */
  installAgent?: (agent: string, workdir: string) => Promise<void>;
  /** Starts the per-session allowlisting proxy; returns its URL and a stop function. */
  proxy?: (allow: string[]) => Promise<{ url: string; stop: () => Promise<void> }>;
  /** `budget.credit_rates`: AI credits per model call, used only if Copilot doesn't report credits. */
  creditRates?: Record<string, number>;
  /** Permission decisions are logged here (plan §5b: every tool call is logged). */
  onPermission?: (instance: string, req: unknown, allowed: boolean, reason: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs one attempt in one Copilot SDK session (plan §2, §5): a fresh session in the attempt's
 * worktree, the generated custom agent, the engine's tool policy on every permission request, a
 * stripped environment, the in-process `ask_human` tool, and outputs read from `.sdlc-out/`.
 */
export class CopilotRunner implements Runner {
  readonly name = 'copilot-sdk';
  private sdkPromise?: Promise<CopilotSdk>;

  constructor(private readonly o: CopilotRunnerOptions) {}

  private sdk(): Promise<CopilotSdk> {
    this.sdkPromise ??= typeof this.o.sdk === 'function' ? this.o.sdk() : Promise.resolve(this.o.sdk);
    return this.sdkPromise;
  }

  async run(req: AttemptRequest): Promise<AttemptResult> {
    const outDir = join(req.workdir, OUT_DIR);
    if (!req.resumeSessionId) await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await this.o.installAgent?.(req.agent, req.workdir);
    await excludeFromGit(req.workdir, [`${OUT_DIR}/`, '.github/agents/sdlc-*', '.github/skills/']);
    const startHead = await gitHead(req.workdir);
    const proxy = this.o.proxy ? await this.o.proxy(req.policy.networkAllow ?? []) : undefined;

    let waiting: { route: string; text: string } | undefined;
    let session: CopilotSession | undefined;
    const ask = async (route: QuestionRoute, text: string, options?: string[], recommended?: string, blocking = true) => {
      const r = await this.o.questions.ask({ story: req.story, instance: req.instance, attempt: req.attempt, route, text, ...(options ? { options } : {}), ...(recommended ? { recommended } : {}), blocking });
      if (r.kind === 'answer') return `Answer (${r.questionId}, from ${r.by}): ${r.answer}`;
      if (r.kind === 'assumed') return `No blocking answer needed (${r.questionId}). Proceed with the assumption: ${r.answer}. It is recorded and will be checked.`;
      waiting = { route, text };
      setTimeout(() => void session?.abort(), 0);
      return `NO_ANSWER_YET (${r.questionId}). Stop now without further changes; this session resumes when the answer arrives.`;
    };
    const tools: CopilotTool[] = [
      {
        name: 'ask_human',
        description: 'Ask the team a question. Use it instead of guessing requirements. category: requirement (PO), technical (responsible dev), test (QE), environment (SM).',
        parameters: {
          type: 'object',
          required: ['question', 'category'],
          properties: {
            question: { type: 'string' },
            category: { enum: ['requirement', 'technical', 'test', 'environment'] },
            options: { type: 'array', items: { type: 'string' } },
            recommended: { type: 'string' },
            blocking: { type: 'boolean', default: true },
          },
        },
        handler: async (a) => ask(a.category as QuestionRoute, String(a.question), a.options as string[] | undefined, a.recommended as string | undefined, a.blocking !== false),
      },
    ];
    const opts: CopilotSessionOptions = {
      agent: `sdlc-${req.agent}`,
      cwd: req.workdir,
      ...(req.policy.model ? { model: req.policy.model } : {}),
      env: sessionEnv(this.o.env ?? process.env, proxy ? { proxyUrl: proxy.url } : {}),
      tools,
      onPermissionRequest: async (p) => {
        const d = decidePermission(p, req.policy, req.workdir);
        this.o.onPermission?.(req.instance, p, d.allow, d.reason);
        return d.allow;
      },
      onUserInputRequest: async (u) => ask('technical', u.question, u.choices),
    };

    try {
      const sdk = await this.sdk();
      let prompt: string;
      if (req.resumeSessionId) {
        const answer = req.reworkInputs.find((a) => a.envelope.type === 'answer');
        try {
          session = await sdk.resumeSession(req.resumeSessionId, opts);
          prompt = `The answer to your question arrived: ${answer?.body.trim() ?? '(see decisions)'}\n\nContinue the step and produce the outputs.`;
        } catch {
          // plan §6: if resume fails, a fresh session starts with the Q&A and the worktree state
          session = await sdk.createSession(opts);
          prompt = await this.prompt(req);
        }
      } else {
        session = await sdk.createSession(opts);
        prompt = await this.prompt(req);
      }
      const turn = await session.send(prompt, { maxTurns: req.policy.maxTurns });
      const credits = turn.usage?.aiCredits ?? estimateCredits(turn.usage?.modelCalls, this.o.creditRates);
      if (waiting) return { status: 'waiting', sessionId: session.id, question: waiting };
      if (turn.stopReason === 'error' || turn.stopReason === 'aborted') return { status: 'failed', sessionId: session.id, reason: turn.error ?? turn.stopReason };
      if (turn.stopReason === 'max_turns') return { status: 'failed', sessionId: session.id, reason: `max turns (${req.policy.maxTurns}) reached` };
      return {
        status: 'done',
        sessionId: session.id,
        outputs: await readOutputs(outDir),
        changedFiles: await changedSince(req.workdir, startHead),
        ...(credits !== undefined ? { aiCredits: credits } : {}),
      };
    } catch (e) {
      return { status: 'failed', sessionId: session?.id ?? 'none', reason: (e as Error).message };
    } finally {
      if (!waiting) await session?.close().catch(() => undefined);
      await proxy?.stop();
    }
  }

  private async prompt(req: AttemptRequest) {
    const decisions = await this.o.decisions?.(req.story).catch(() => '');
    return buildPrompt(req, this.o.outputsOf(req.contractId), { templates: this.o.templates, ...(decisions ? { decisions } : {}) });
  }
}

export function estimateCredits(calls: { model: string; count: number }[] | undefined, rates: Record<string, number> | undefined): number | undefined {
  if (!calls?.length || !rates) return undefined;
  return calls.reduce((sum, c) => sum + c.count * (rates[c.model] ?? 0), 0);
}

/** Reads `.sdlc-out/<type>.md`, `<type>--<repo>.md` and `<type>--<repo>--<n>.md`. */
export async function readOutputs(outDir: string): Promise<OutputDraft[]> {
  let files: string[];
  try {
    files = (await readdir(outDir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (f) => {
      const [type, repo] = f.replace(/\.md$/, '').split('--');
      return { type: type!, ...(repo ? { repo } : {}), body: await readFile(join(outDir, f), 'utf8') };
    }),
  );
}

async function gitHead(dir: string): Promise<string | undefined> {
  try {
    return (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir, windowsHide: true })).stdout.trim();
  } catch {
    return undefined;
  }
}

/** Files changed in the worktree since the attempt started: new commits plus uncommitted changes. */
export async function changedSince(dir: string, startHead: string | undefined): Promise<string[]> {
  if (!startHead) return [];
  const run = async (...args: string[]) => (await exec('git', args, { cwd: dir, windowsHide: true })).stdout;
  const files = new Set((await run('diff', '--name-only', `${startHead}..HEAD`)).split('\n').filter(Boolean));
  for (const line of (await run('status', '--porcelain', '--untracked-files=all')).split('\n').filter(Boolean)) files.add(line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
  return [...files].filter((f) => !f.startsWith(`${OUT_DIR}/`)).sort();
}

/** Keeps runner-installed files (agent file, skills, outputs) out of git, so they never count as agent writes. */
async function excludeFromGit(dir: string, patterns: string[]): Promise<void> {
  let gitDir: string;
  try {
    gitDir = (await exec('git', ['rev-parse', '--git-common-dir'], { cwd: dir, windowsHide: true })).stdout.trim();
  } catch {
    return;
  }
  const file = join(gitDir.match(/^([a-z]:)?[\\/]/i) ? gitDir : join(dir, gitDir), 'info', 'exclude');
  let cur = '';
  try {
    cur = await readFile(file, 'utf8');
  } catch {
    await mkdir(join(file, '..'), { recursive: true });
  }
  const missing = patterns.filter((p) => !cur.split(/\r?\n/).includes(p));
  if (missing.length) await appendFile(file, (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n', 'utf8');
}
