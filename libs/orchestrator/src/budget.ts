import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EngineEvent } from '@sdlc/contracts';

export interface BudgetOptions {
  /** `limits.ai_credits_per_story`. */
  perStory: number;
  /** `budget.warn_at_share` (0.8). */
  warnAt: number;
  /** The developer's monthly allowance (`~/.sdlc/config.yaml`, team default `budget.personal_reserve.monthly_allowance_default`). */
  monthlyAllowance: number;
  /** `budget.personal_reserve.stop_at_share` (0.7). */
  reserveShare: number;
  /** This developer's local usage file, e.g. `~/.sdlc/usage.json`. Never pushed: only the developer sees it. */
  usageFile: string;
  now?: () => Date;
}

export type BudgetCheck =
  | { ok: true; warn?: 'story' | 'reserve' }
  | { ok: false; reason: 'story budget' | 'personal reserve' };

/** AI credits used by a story, from its events (attempt.finished / attempt.failed carry `ai_credits`). */
export function storyCredits(events: EngineEvent[]): number {
  return events.reduce((sum, e) => sum + (typeof e.data.ai_credits === 'number' ? e.data.ai_credits : 0), 0);
}

/** The story's limit: the default plus every `sdlc budget raise` (event `budget.raised`). */
export function storyLimit(events: EngineEvent[], perStory: number): number {
  return events.filter((e) => e.type === 'budget.raised').reduce((sum, e) => sum + Number(e.data.amount ?? 0), perStory);
}

/**
 * Budget guard (plan §5a). Limits apply when a new session starts; running sessions are never cut off.
 * At 100% of the story budget the story goes `blocked: budget`; at the personal reserve no new
 * sessions start on this machine. At `warnAt` the owner is warned.
 */
export class BudgetGuard {
  private readonly now: () => Date;

  constructor(private readonly o: BudgetOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private month = () => this.now().toISOString().slice(0, 7);

  async monthUsed(): Promise<number> {
    try {
      const u = JSON.parse(await readFile(this.o.usageFile, 'utf8')) as Record<string, number>;
      return u[this.month()] ?? 0;
    } catch {
      return 0;
    }
  }

  async record(credits: number): Promise<void> {
    if (!credits) return;
    let u: Record<string, number> = {};
    try {
      u = JSON.parse(await readFile(this.o.usageFile, 'utf8'));
    } catch {
      /* first use */
    }
    u[this.month()] = (u[this.month()] ?? 0) + credits;
    await mkdir(dirname(this.o.usageFile), { recursive: true });
    await writeFile(this.o.usageFile, JSON.stringify(u, null, 2) + '\n', 'utf8');
  }

  async check(storyEvents: EngineEvent[]): Promise<BudgetCheck> {
    const used = storyCredits(storyEvents);
    const limit = storyLimit(storyEvents, this.o.perStory);
    const reserve = this.o.monthlyAllowance * this.o.reserveShare;
    const month = await this.monthUsed();
    if (used >= limit) return { ok: false, reason: 'story budget' };
    if (month >= reserve) return { ok: false, reason: 'personal reserve' };
    if (used >= limit * this.o.warnAt) return { ok: true, warn: 'story' };
    if (month >= reserve * this.o.warnAt) return { ok: true, warn: 'reserve' };
    return { ok: true };
  }
}
