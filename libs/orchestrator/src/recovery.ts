import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type EngineEvent, EngineEventSchema } from '@sdlc/contracts';

export type NewEvent = Omit<EngineEvent, 'id' | 'ts' | 'data'> & { id?: string; data?: Record<string, unknown> };

/** Append-only `stories/<KEY>/events.log` (JSON Lines) under the work root. */
export class EventLog {
  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  path(story: string): string {
    return join(this.root, 'stories', story, 'events.log');
  }

  async append(e: NewEvent): Promise<EngineEvent> {
    const event = EngineEventSchema.parse({ ...e, id: e.id ?? randomUUID(), ts: this.now().toISOString(), data: e.data ?? {} });
    const file = this.path(e.story);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  async read(story: string): Promise<EngineEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path(story), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    // A crash can leave a torn last line; skip lines that don't parse instead of failing recovery.
    return text
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [EngineEventSchema.parse(JSON.parse(l))];
        } catch {
          return [];
        }
      });
  }
}

export interface InstanceState {
  instance: string;
  lastAttempt: number;
  state: 'idle' | 'running' | 'waiting' | 'blocked';
  sessionId?: string;
  failures: number;
}

export interface StoryReplay {
  instances: Map<string, InstanceState>;
  /** Attempts dispatched but never finished: re-dispatch with the same attempt number in a new session. */
  unfinished: InstanceState[];
  /** Attempts waiting for a human answer: re-attach, and resume the session when the answer arrives. */
  waiting: InstanceState[];
  takenOver: Set<string> | 'story';
  /** Event ids already recorded, for idempotent outbound writes. */
  seen: Set<string>;
}

/** Rebuilds a story's instance states from its events (plan §2, restart recovery). */
export function replay(events: EngineEvent[]): StoryReplay {
  const instances = new Map<string, InstanceState>();
  let takenOver: Set<string> | 'story' = new Set();
  const seen = new Set<string>();
  const get = (key: string) => {
    let s = instances.get(key);
    if (!s) instances.set(key, (s = { instance: key, lastAttempt: 0, state: 'idle', failures: 0 }));
    return s;
  };
  for (const e of events) {
    seen.add(e.id);
    if (e.type === 'takeover.started') {
      if (!e.instance) takenOver = 'story';
      else if (takenOver !== 'story') takenOver.add(e.instance);
      continue;
    }
    if (e.type === 'takeover.ended') {
      if (!e.instance) takenOver = new Set();
      else if (takenOver !== 'story') takenOver.delete(e.instance);
      continue;
    }
    if (!e.instance) continue;
    const s = get(e.instance);
    switch (e.type) {
      case 'attempt.dispatched':
        s.lastAttempt = e.attempt ?? s.lastAttempt + 1;
        s.state = 'running';
        if (e.session_id) s.sessionId = e.session_id;
        break;
      case 'attempt.resumed':
        s.state = 'running';
        break;
      case 'attempt.waiting':
        s.state = 'waiting';
        if (e.session_id) s.sessionId = e.session_id;
        break;
      case 'attempt.finished':
        s.state = 'idle';
        s.failures = 0;
        break;
      case 'attempt.failed':
      case 'scope.violation':
      case 'validation.failed':
        s.state = 'idle';
        s.failures += 1;
        break;
      case 'instance.blocked':
        s.state = 'blocked';
        break;
      case 'instance.unblocked':
        s.state = 'idle';
        s.failures = 0;
        break;
      default:
        break;
    }
  }
  const all = [...instances.values()];
  return {
    instances,
    unfinished: all.filter((s) => s.state === 'running'),
    waiting: all.filter((s) => s.state === 'waiting'),
    takenOver,
    seen,
  };
}
