import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

export type QuestionRoute = 'requirement' | 'technical' | 'test' | 'environment';

export interface Question {
  id: string;
  story: string;
  instance: string;
  attempt: number;
  route: QuestionRoute;
  /** Role the route maps to (`questions.routes`), e.g. requirement → po. */
  role: string;
  /** Emails of the people who may answer. */
  people: string[];
  text: string;
  options?: string[];
  recommended?: string;
  blocking: boolean;
  status: 'open' | 'waiting' | 'answered' | 'assumed';
  askedAt: string;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
}

export interface AskRequest {
  story: string;
  instance: string;
  attempt: number;
  route: QuestionRoute;
  text: string;
  options?: string[];
  recommended?: string;
  blocking?: boolean;
}

export type AskResult =
  | { kind: 'answer'; answer: string; by: string; questionId: string }
  | { kind: 'assumed'; answer: string; questionId: string }
  | { kind: 'no_answer_yet'; questionId: string };

/** Sends a question to people: Teams webhook, Jira comment `@person`, Web UI inbox. */
export interface Notifier {
  notify(q: Question): Promise<void>;
}

export interface QuestionRouterOptions {
  /** `<work root>/stories/<KEY>` for a story. */
  storyDir: (story: string) => string;
  /** `questions.routes`: route → role. `responsible_dev` is resolved to the story's owner. */
  routes: Record<QuestionRoute, string>;
  /** People with a role for a story (role `responsible_dev` → the story's assignee). */
  people: (story: string, role: string) => Promise<string[]>;
  notifiers?: Notifier[];
  /** `questions.live_wait_minutes`, in ms. */
  liveWaitMs: number;
  /** A late answer (after the live window): resume the waiting session (Engine.answer). */
  onLateAnswer?: (q: Question) => Promise<void>;
  now?: () => Date;
}

/**
 * `ask_human` routing (plan §6): writes `questions/Q-<n>.md`, routes by category to a role, notifies,
 * and waits live for `liveWaitMs`. Within the window the answer goes straight back to the session;
 * after it, the session stops (`no_answer_yet`) and a late answer resumes it. Non-blocking questions
 * proceed with the recommended option, recorded as an assumption. Only the routed people may answer.
 * Every answer and assumption is appended to `decisions.md`, which later agents read.
 */
export class QuestionRouter {
  private readonly live = new Map<string, (r: { answer: string; by: string }) => void>();
  private readonly now: () => Date;

  constructor(private readonly o: QuestionRouterOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private dir = (story: string) => join(this.o.storyDir(story), 'questions');

  private async save(q: Question) {
    await mkdir(this.dir(q.story), { recursive: true });
    const { text, ...meta } = q;
    await writeFile(join(this.dir(q.story), `${q.id}.md`), `---\n${stringify(meta).trimEnd()}\n---\n${text}\n`, 'utf8');
  }

  async get(story: string, id: string): Promise<Question | undefined> {
    try {
      const raw = await readFile(join(this.dir(story), `${id}.md`), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
      return m ? ({ ...parse(m[1]!), text: m[2]!.trimEnd() } as Question) : undefined;
    } catch {
      return undefined;
    }
  }

  async list(story: string): Promise<Question[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir(story))).filter((f) => f.endsWith('.md')).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    } catch {
      return [];
    }
    return (await Promise.all(files.map((f) => this.get(story, f.replace(/\.md$/, ''))))).filter((q): q is Question => !!q);
  }

  private async record(q: Question, kind: 'Answer' | 'Assumption') {
    const line = `\n## ${q.id} (${q.route}, ${q.instance})\n\n- Question: ${q.text.replace(/\n/g, ' ')}\n- ${kind}: ${q.answer}${q.answeredBy ? ` (by ${q.answeredBy})` : ''}\n`;
    await mkdir(this.o.storyDir(q.story), { recursive: true });
    await appendFile(join(this.o.storyDir(q.story), 'decisions.md'), line, 'utf8');
  }

  async ask(req: AskRequest): Promise<AskResult> {
    const n = (await this.list(req.story)).length + 1;
    const role = this.o.routes[req.route];
    const q: Question = {
      id: `Q-${n}`,
      story: req.story,
      instance: req.instance,
      attempt: req.attempt,
      route: req.route,
      role,
      people: await this.o.people(req.story, role),
      text: req.text,
      ...(req.options ? { options: req.options } : {}),
      ...(req.recommended ? { recommended: req.recommended } : {}),
      blocking: req.blocking ?? true,
      status: 'open',
      askedAt: this.now().toISOString(),
    };
    if (!q.blocking && q.recommended) {
      Object.assign(q, { status: 'assumed', answer: q.recommended, answeredAt: q.askedAt });
      await this.save(q);
      await this.record(q, 'Assumption');
      for (const n of this.o.notifiers ?? []) await n.notify(q).catch(() => undefined);
      return { kind: 'assumed', answer: q.recommended, questionId: q.id };
    }
    await this.save(q);
    for (const notifier of this.o.notifiers ?? []) await notifier.notify(q).catch(() => undefined);

    const key = `${q.story}/${q.id}`;
    const answered = await new Promise<{ answer: string; by: string } | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.live.delete(key);
        resolve(undefined);
      }, this.o.liveWaitMs);
      this.live.set(key, (r) => {
        clearTimeout(timer);
        this.live.delete(key);
        resolve(r);
      });
    });
    if (answered) return { kind: 'answer', answer: answered.answer, by: answered.by, questionId: q.id };
    const cur = (await this.get(q.story, q.id))!;
    if (cur.status === 'open') await this.save({ ...cur, status: 'waiting' });
    return { kind: 'no_answer_yet', questionId: q.id };
  }

  /**
   * An answer from the UI, CLI, webhook or a Jira reply. Only someone the question was routed to may
   * answer. Returns `live` (the session got it now), `late` (the waiting session will be resumed),
   * or `rejected`.
   */
  async answer(story: string, id: string, text: string, by: string): Promise<'live' | 'late' | 'rejected' | 'already answered'> {
    const q = await this.get(story, id);
    if (!q) return 'rejected';
    if (q.status === 'answered' || q.status === 'assumed') return 'already answered';
    if (!q.people.map((p) => p.toLowerCase()).includes(by.toLowerCase())) return 'rejected';
    const done: Question = { ...q, status: 'answered', answer: text, answeredBy: by, answeredAt: this.now().toISOString() };
    await this.save(done);
    await this.record(done, 'Answer');
    const live = this.live.get(`${story}/${id}`);
    if (live) {
      live({ answer: text, by });
      return 'live';
    }
    await this.o.onLateAnswer?.(done);
    return 'late';
  }

  /** Parses a Jira reply `/sdlc answer Q-3 <text>` (plan §6: replies in Jira count as answers). */
  static parseAnswerCommand(body: string): { id: string; text: string } | undefined {
    const m = /^\s*\/sdlc\s+answer\s+(Q-\d+)\s*[:\-]?\s*([\s\S]+)$/i.exec(body);
    return m ? { id: m[1]!.toUpperCase(), text: m[2]!.trim() } : undefined;
  }
}

/** Microsoft Teams channel webhook (Q15). The URL comes from `questions.notify.webhook`. */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  async notify(q: Question): Promise<void> {
    const text =
      q.status === 'assumed'
        ? `[sdlc] ${q.story} ${q.id}: proceeding with an assumption (${q.answer}). Question: ${q.text}`
        : `[sdlc] ${q.story} ${q.id} for ${q.people.join(', ') || q.role}: ${q.text}\nAnswer in Jira with: /sdlc answer ${q.id} <your answer>`;
    await this.f(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  }
}
