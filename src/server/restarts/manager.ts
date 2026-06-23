import type { Logger } from '../logger.ts';
import type { Instance } from '../supervisor/types.ts';
import { CronTicker, msUntilNextMinute } from '../scheduling/cron-ticker.ts';

export interface RestartManagerDeps {
  logger: Logger;
  // Master switch (config.RESTART_SCHEDULER_ENABLED). When false start() is a
  // no-op so the per-minute tick never runs.
  enabled: boolean;
  // Cron used when an instance is restart-enabled but has no own restartCron.
  defaultCron: string;
  // Enumerate current instances each tick (same source as the supervisor).
  listInstances: () => Instance[];
  // The actual restart action — wired to Orchestrator.scheduledRestart, which
  // stops the backend (reaping its executor) and respawns it.
  restartBackend: (name: string) => Promise<void>;
}

// Per-instance scheduled restart. A once-a-minute tick fires the restart for
// each restart-enabled running instance when its cron is due (the due/next-fire
// math lives in the shared CronTicker). Restarting reclaims the executor memory
// that self-hosted Convex never frees at runtime.
export class RestartManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticker: CronTicker;
  // Instances with a restart currently in flight, so a slow restart that
  // outlasts a minute isn't fired again on the next tick.
  private inflight = new Set<string>();

  constructor(private readonly deps: RestartManagerDeps) {
    this.ticker = new CronTicker(deps.logger, 'restart');
  }

  // Purge per-instance scheduler state on delete so a same-name recreate
  // starts from a clean schedule.
  dropInstance(name: string): void {
    this.ticker.dropInstance(name);
  }

  start(): void {
    if (!this.deps.enabled) {
      this.deps.logger.warn(
        'RESTART_SCHEDULER_ENABLED=false — scheduled restarts disabled. Manual restart still works.',
      );
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    // Align the first tick to the next 0-second boundary so it matches cron
    // minute resolution.
    setTimeout(() => void this.tick(), msUntilNextMinute());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Public for tests so the per-minute decision can be driven with an injected
  // clock instead of a real interval. Production calls it from the setInterval
  // in start().
  async tick(now: number = Date.now()): Promise<void> {
    for (const inst of this.deps.listInstances()) {
      if (inst.status !== 'running') continue;
      if (!(inst.restartEnabled ?? false)) continue;

      const raw = inst.restartCron ?? this.deps.defaultCron;
      if (!this.ticker.due(inst.name, raw, now)) continue;

      if (this.inflight.has(inst.name)) continue;
      this.inflight.add(inst.name);
      this.deps.logger.info({ name: inst.name, cron: raw }, 'scheduled restart firing');
      void this.deps
        .restartBackend(inst.name)
        .catch((err: unknown) =>
          this.deps.logger.error(
            { name: inst.name, err: err instanceof Error ? err.message : String(err) },
            'scheduled restart failed',
          ),
        )
        .finally(() => this.inflight.delete(inst.name));
    }
  }
}
