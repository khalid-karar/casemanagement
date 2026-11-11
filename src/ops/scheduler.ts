import type { Repo } from '../api/repo';

export interface Job { name: string; everyMs: number; run(): Promise<unknown> }

/**
 * Minimal in-process scheduler. Each job runs on at most one server at a time (repo.withLock: a Postgres advisory lock),
 * never overlaps itself, and a failing run is logged and retried at the next tick. No external queue is needed at this scale;
 * a job is idempotent by design, so a missed or repeated run is safe.
 */
export class Scheduler {
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = new Set<string>();
  last = new Map<string, { at: string; ok: boolean; result?: unknown; error?: string }>();
  constructor(private repo: Repo, private jobs: Job[], private now: () => string = () => new Date().toISOString()) {}

  async runOnce(job: Job): Promise<boolean> {
    if (this.running.has(job.name)) return false;
    this.running.add(job.name);
    try {
      return await this.repo.withLock(`job:${job.name}`, async () => {
        try { const result = await job.run(); this.last.set(job.name, { at: this.now(), ok: true, result }); }
        catch (e) { this.last.set(job.name, { at: this.now(), ok: false, error: (e as Error).message }); console.error(JSON.stringify({ event: 'job_failed', job: job.name, error: (e as Error).message })); }
      });
    } finally { this.running.delete(job.name); }
  }
  start() {
    for (const j of this.jobs) {
      const t = setInterval(() => { void this.runOnce(j); }, j.everyMs); t.unref?.(); this.timers.push(t);
      setTimeout(() => { void this.runOnce(j); }, 5_000).unref?.(); // first run shortly after start
    }
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
}
