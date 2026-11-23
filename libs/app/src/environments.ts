import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { type Environment, EnvironmentBusyError, type LeaseManager, Semaphore } from '@sdlc/orchestrator';

const exec = promisify(execCb);

/**
 * The local stack for QE (c) (plan §4a, Q10/Q19): the ENGINE runs `qe.local_env.up` / `down` (e.g.
 * docker compose) around the attempt; the agent never controls Docker. One local run per machine at a time.
 */
export class LocalStackEnvironment implements Environment {
  private readonly one = new Semaphore(1);
  private releaseSlot?: () => void;

  constructor(
    private readonly cfg: { up: string; down: string; base_url: string; cwd: string },
    private readonly run: (cmd: string, cwd: string) => Promise<void> = async (cmd, cwd) => void (await exec(cmd, { cwd, windowsHide: true, env: { ...process.env, SDLC_STACK: '1' } })),
  ) {}

  async acquire(ctx: { story: string }) {
    // hold the machine slot from up to down
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    void this.one.run(async () => {
      entered();
      await held;
    });
    await inside;
    try {
      await this.run(this.cfg.up.replaceAll('{story}', ctx.story), this.cfg.cwd);
    } catch (e) {
      release();
      throw new Error(`local stack failed to start: ${(e as Error).message}`);
    }
    return {
      baseUrl: this.cfg.base_url,
      release: async () => {
        try {
          await this.run(this.cfg.down.replaceAll('{story}', ctx.story), this.cfg.cwd);
        } finally {
          release();
        }
      },
    };
  }
}

/**
 * Preprod for the check after merge (Q10): shared, so a run holds the team lease
 * `.sdlc/work/leases/preprod.json`; a crashed holder's lease expires after `lease_ttl_minutes`.
 */
export class PreprodEnvironment implements Environment {
  constructor(
    private readonly leases: LeaseManager,
    private readonly cfg: { base_url: string; lease: string },
  ) {}

  async acquire() {
    const path = this.leases.teamLeasePath(this.cfg.lease);
    if (!(await this.leases.acquire(path))) throw new EnvironmentBusyError('preprod is in use by another engine (lease held)');
    return { baseUrl: this.cfg.base_url, release: async () => void (await this.leases.release(path)) };
  }
}
