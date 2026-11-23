import type { Engine, StoryInput, TickReport } from './engine';
import type { GitWorkspace } from './git';
import type { LeaseManager } from './lease';

/** A story assigned to this engine's user, as the intake sees it (plan §2: `assignee = currentUser()`). */
export interface AssignedStory {
  key: string;
  repos: string[];
}

/** Hooks around the tick: Jira/Confluence/GitLab sync plugs in here (plan §2 loop steps 2 and 10). */
export interface LoopHooks {
  /** Stories currently assigned to this engine's user and in scope (active sprint or carried-over in flight). */
  assigned(): Promise<AssignedStory[]>;
  /** Inbound sync for one owned story before it is evaluated (Jira, Confluence, GitLab state). */
  syncIn?(story: AssignedStory): Promise<void>;
  /** Outbound sync after the tick (Jira transitions and comments, branch pushes, MRs). */
  syncOut?(story: AssignedStory, report: TickReport): Promise<void>;
}

export interface LoopReport {
  owned: string[];
  skipped: { key: string; reason: string }[];
  released: string[];
  ticks: Record<string, TickReport>;
  pushed: 'ok' | 'conflict' | 'nothing';
}

/**
 * One pass of the engine loop (plan §2): pull the workspace repo; claim or renew leases for assigned
 * stories and release those no longer assigned; sync in; tick each owned story; sync out; commit and
 * push this engine's own paths. Stories tick in parallel; the engine's semaphore bounds sessions.
 */
export class EngineLoop {
  private readonly held = new Set<string>();

  constructor(
    private readonly o: { ws: GitWorkspace; leases: LeaseManager; engine: Engine; hooks: LoopHooks; workRel?: string },
  ) {}

  async once(): Promise<LoopReport> {
    const { ws, leases, engine, hooks } = this.o;
    const workRel = this.o.workRel ?? '.sdlc/work';
    await ws.pull();
    const assigned = await hooks.assigned();
    const report: LoopReport = { owned: [], skipped: [], released: [], ticks: {}, pushed: 'nothing' };

    // Reassigned away: release (handover, plan §2). Running sessions finish inside tick before we get here.
    for (const key of [...this.held]) {
      if (!assigned.some((s) => s.key === key)) {
        if (await leases.releaseStory(key)) report.released.push(key);
        this.held.delete(key);
      }
    }

    const owned: AssignedStory[] = [];
    for (const s of assigned) {
      if (await leases.claimStory(s.key)) {
        this.held.add(s.key);
        owned.push(s);
      } else {
        this.held.delete(s.key);
        report.skipped.push({ key: s.key, reason: 'lease held by another engine' });
      }
    }
    report.owned = owned.map((s) => s.key);

    await Promise.all(
      owned.map(async (s) => {
        await hooks.syncIn?.(s);
        const input: StoryInput = { key: s.key, repos: s.repos, owned: true };
        const tick = await engine.tick(input);
        report.ticks[s.key] = tick;
        await hooks.syncOut?.(s, tick);
      }),
    );

    if (owned.length) {
      // own stories and retros, plus topic snapshots (keyed by page version, so engines never conflict)
      const paths = [...owned.flatMap((s) => [`${workRel}/stories/${s.key}`, `${workRel}/retro/${s.key}`]), `${workRel}/topics`];
      report.pushed = await ws.commitAndPush(`sdlc: update ${report.owned.join(', ')}`, paths);
    }
    return report;
  }
}
