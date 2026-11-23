import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Lease, LeaseSchema } from '@sdlc/contracts';
import type { GitWorkspace } from './git';

export interface EngineIdentity {
  user: string;
  host: string;
  engine_id: string;
}

export type LeaseState = 'free' | 'mine' | 'held' | 'expired';

/** Whether `me` may take or keep a lease (plan §2). A lease older than the TTL can be taken over. */
export function leaseState(existing: Lease | undefined, me: EngineIdentity, now: Date, ttlMinutes: number): LeaseState {
  if (!existing) return 'free';
  if (existing.engine_id === me.engine_id) return 'mine';
  const age = now.getTime() - Date.parse(existing.heartbeat_at);
  return age > ttlMinutes * 60_000 ? 'expired' : 'held';
}

/**
 * Story and team leases in the workspace repo: `.sdlc/work/stories/<KEY>/owner.json` and
 * `.sdlc/work/leases/<name>.json` (e.g. `preprod`, `coach`).
 */
export class LeaseManager {
  constructor(
    private readonly ws: GitWorkspace,
    private readonly me: EngineIdentity,
    private readonly ttlMinutes: number,
    private readonly workRel = '.sdlc/work',
    private readonly now: () => Date = () => new Date(),
  ) {}

  storyLeasePath(story: string): string {
    return `${this.workRel}/stories/${story}/owner.json`;
  }

  teamLeasePath(name: string): string {
    return `${this.workRel}/leases/${name}.json`;
  }

  async read(relPath: string): Promise<Lease | undefined> {
    try {
      return LeaseSchema.parse(JSON.parse(await readFile(join(this.ws.dir, relPath), 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  /** Claims or renews a lease. True only if, after the push, the lease in the repo is ours. */
  async acquire(relPath: string): Promise<boolean> {
    await this.ws.pull();
    const state = leaseState(await this.read(relPath), this.me, this.now(), this.ttlMinutes);
    if (state === 'held') return false;
    const lease: Lease = { ...this.me, heartbeat_at: this.now().toISOString() };
    const file = join(this.ws.dir, relPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(lease, null, 2) + '\n', 'utf8');
    const outcome = await this.ws.commitAndPush(`lease: ${state === 'mine' ? 'renew' : 'claim'} ${relPath} (${this.me.user})`, [relPath]);
    if (outcome === 'conflict') return false;
    return (await this.read(relPath))?.engine_id === this.me.engine_id;
  }

  /** Releases a lease we hold. A lease held by someone else is left alone. */
  async release(relPath: string): Promise<boolean> {
    await this.ws.pull();
    if ((await this.read(relPath))?.engine_id !== this.me.engine_id) return false;
    await rm(join(this.ws.dir, relPath));
    return (await this.ws.commitAndPush(`lease: release ${relPath} (${this.me.user})`, [relPath])) === 'ok';
  }

  claimStory(story: string) {
    return this.acquire(this.storyLeasePath(story));
  }

  releaseStory(story: string) {
    return this.release(this.storyLeasePath(story));
  }
}
