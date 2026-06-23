import { parseCron, nextCronFire, type CronExpr } from './cron.ts';
import type { Logger } from '../logger.ts';

// Shared per-minute cron bookkeeping for the schedulers (backups, scheduled
// restart). Encapsulates the parse cache + next-fire tracking + due decision
// so the two managers can't drift on the scheduling math; each keeps its own
// loop, enable/suspend predicate, and action (enqueue vs restart).
export class CronTicker {
  // Next epoch-ms each instance is due.
  private nextFire = new Map<string, number>();
  // Per-instance cron parse cache, invalidated when the raw expression changes.
  private cronCache = new Map<string, { raw: string; expr: CronExpr }>();

  constructor(
    private readonly logger: Logger,
    // Label for the "invalid cron" log line, e.g. 'backup' or 'restart'.
    private readonly label: string,
  ) {}

  // Purge per-instance state. Used on delete (so a same-name recreate starts
  // fresh) and whenever the schedule must be re-armed from scratch (resume /
  // suspend). Re-parsing the cron on the next tick is negligible.
  dropInstance(name: string): void {
    this.nextFire.delete(name);
    this.cronCache.delete(name);
  }

  // Returns true if `name`'s cron is due at `now`, advancing the next-fire
  // bookkeeping to the following occurrence. Returns false for a not-yet-due
  // or invalid cron (the latter is logged once per parse).
  due(name: string, rawCron: string, now: number): boolean {
    let cached = this.cronCache.get(name);
    if (!cached || cached.raw !== rawCron) {
      try {
        cached = { raw: rawCron, expr: parseCron(rawCron) };
        this.cronCache.set(name, cached);
      } catch (err: unknown) {
        this.logger.error(
          { name, raw: rawCron, err: err instanceof Error ? err.message : String(err) },
          `invalid ${this.label} cron, skipping instance`,
        );
        return false;
      }
      // The expression changed (or is new): drop any next-fire computed from
      // the previous one so it's recomputed against the new schedule below,
      // instead of firing once more on the stale timestamp.
      this.nextFire.delete(name);
    }

    let next = this.nextFire.get(name);
    if (next == null || next <= now) {
      // First seen, or stale (e.g. the instance was stopped for a while) —
      // recompute from one minute ago so a cron landing on the current minute
      // still fires this tick.
      const computed = nextCronFire(cached.expr, now - 60_000);
      if (computed == null) {
        this.nextFire.delete(name);
        return false;
      }
      next = computed;
      this.nextFire.set(name, next);
    }

    if (next > now) return false;

    // Due — advance to the following fire before returning so a single minute
    // can't trigger twice.
    const after = nextCronFire(cached.expr, next);
    if (after != null) this.nextFire.set(name, after);
    else this.nextFire.delete(name);
    return true;
  }
}

// Milliseconds until the next wall-clock minute boundary. Used to align the
// first scheduler tick with cron's minute resolution.
export function msUntilNextMinute(now: number = Date.now()): number {
  return 60_000 - (now % 60_000);
}
