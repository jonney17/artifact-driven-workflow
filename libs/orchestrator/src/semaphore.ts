/** Limits concurrent agent sessions on one machine (`limits.concurrency`, plan §2), across all stories. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(readonly size: number) {
    if (size < 1) throw new Error('semaphore size must be at least 1');
  }

  get inUse(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
