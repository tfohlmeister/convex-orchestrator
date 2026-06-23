import { spawnConvex, type SpawnHandle } from './spawn.ts';
import { decideRestart, type BackoffState } from './watcher.ts';
import { gracefulStop, stopAll } from './shutdown.ts';
import { ResourceSampler, type ResourceSink } from './resources.ts';
import { listDescendants, killAll } from './reap.ts';
import type { Instance } from './types.ts';
import type { Logger } from '../logger.ts';

export interface SupervisorDeps {
  binaryPath: string;
  logDir: string;
  logger: Logger;
  databaseUrl: (instance: Instance) => string;
  s3: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    region: string;
  };
  externalScheme: 'http' | 'https';
  externalPortSuffix: string;
  // Optional spawn override for tests. Production wires spawnConvex
  // (the default export from ./spawn.ts); tests pass a fake that
  // resolves to a controllable SpawnHandle.
  spawn?: typeof spawnConvex;
  // Address the spawned backend listens on. 127.0.0.1 keeps the backend
  // reachable only inside the orchestrator process's network namespace
  // (correct for a single-host bare-metal install); 0.0.0.0 exposes it on
  // every interface (required when Traefik runs in a separate container
  // and reaches the orchestrator via the docker bridge network).
  bindAddress: string;
  resourceSink: ResourceSink;
  onStatusChange: (
    name: string,
    status: 'running' | 'stopped' | 'error',
    lastError?: string,
  ) => void;
  // Test override for descendant discovery + killing. Production wires the
  // /proc-walking listDescendants and process.kill (see ./reap.ts); tests
  // inject deterministic fakes so the reaping path is exercised without a
  // real process tree.
  listDescendants?: (pid: number) => Promise<number[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

interface Tracked {
  handle: SpawnHandle;
  instance: Instance;
  backoff: BackoffState;
  stopRequested: boolean;
  exitWatcher: Promise<void>;
}

export class Supervisor {
  private tracked = new Map<string, Tracked>();
  // Timers scheduled by handleExit for crash recovery. Sit in this map only
  // during the backoff window between the prior exit and the actual spawn,
  // so stop() can cancel a pending respawn the operator no longer wants.
  // Without this map, stop() during the backoff gap is a no-op (the Tracked
  // entry has already been deleted by handleExit) and the setTimeout still
  // fires, silently overriding the operator's stop.
  private pendingRespawn = new Map<string, NodeJS.Timeout>();
  private sampler: ResourceSampler;

  constructor(private readonly deps: SupervisorDeps) {
    this.sampler = new ResourceSampler(
      deps.resourceSink,
      () => new Map(Array.from(this.tracked, ([n, t]) => [n, t.handle.pid])),
    );
  }

  startBackgroundJobs(): void {
    this.sampler.start();
  }

  stopBackgroundJobs(): void {
    this.sampler.stop();
  }

  isRunning(name: string): boolean {
    return this.tracked.has(name);
  }

  pidOf(name: string): number | null {
    return this.tracked.get(name)?.handle.pid ?? null;
  }

  async start(instance: Instance): Promise<void> {
    if (this.tracked.has(instance.name)) return;
    await this.spawn(instance, { attempts: 0, windowStart: Date.now() });
  }

  async stop(name: string): Promise<void> {
    // Cancel any pending respawn first; the operator wants this instance
    // to stay down, and a fired setTimeout would override that.
    const pending = this.pendingRespawn.get(name);
    if (pending) {
      clearTimeout(pending);
      this.pendingRespawn.delete(name);
      this.deps.onStatusChange(name, 'stopped');
    }
    const t = this.tracked.get(name);
    if (!t) return;
    t.stopRequested = true;
    // Capture the backend's descendant PIDs (chiefly the Node executor that
    // runs Convex actions) BEFORE SIGTERM, while their ppid still points at
    // the backend. The executor does not exit with its parent — it gets
    // reparented to PID 1 and keeps its heap — so we SIGKILL the captured
    // set afterwards to actually free the memory.
    const descendants = await this.descendantsOf(t.handle.pid);
    await gracefulStop(t.handle.proc);
    this.reap(name, descendants);
    this.tracked.delete(name);
    this.deps.onStatusChange(name, 'stopped');
  }

  private async descendantsOf(pid: number): Promise<number[]> {
    const find = this.deps.listDescendants ?? listDescendants;
    try {
      return await find(pid);
    } catch (err: unknown) {
      this.deps.logger.warn(
        { pid, err: err instanceof Error ? err.message : String(err) },
        'descendant discovery failed; executor may leak',
      );
      return [];
    }
  }

  private reap(name: string, descendants: number[]): void {
    if (descendants.length === 0) return;
    const killed = killAll(descendants, this.deps.killProcess);
    if (killed.length > 0) {
      this.deps.logger.info({ name, pids: killed }, 'reaped backend descendant processes');
    }
  }

  async stopAllForShutdown(): Promise<void> {
    for (const timer of this.pendingRespawn.values()) clearTimeout(timer);
    this.pendingRespawn.clear();
    const procs = Array.from(this.tracked.values()).map((t) => {
      t.stopRequested = true;
      return t.handle.proc;
    });
    await stopAll(procs);
    this.tracked.clear();
  }

  private async spawn(instance: Instance, backoff: BackoffState): Promise<void> {
    const spawnFn = this.deps.spawn ?? spawnConvex;
    const handle = await spawnFn({
      instance,
      binaryPath: this.deps.binaryPath,
      logDir: this.deps.logDir,
      databaseUrl: this.deps.databaseUrl(instance),
      s3Endpoint: this.deps.s3.endpoint,
      s3AccessKey: this.deps.s3.accessKey,
      s3SecretKey: this.deps.s3.secretKey,
      s3Region: this.deps.s3.region,
      bindAddress: this.deps.bindAddress,
      externalScheme: this.deps.externalScheme,
      externalPortSuffix: this.deps.externalPortSuffix,
      // Without this hook, log-pipe failures (disk full, IO error,
      // backpressure) used to disappear as unhandled rejections; the
      // backend kept running but its stdout/stderr was no longer
      // captured. Surface them through the supervisor's logger so an
      // operator can see "logs went dark" without grepping process
      // state.
      onPipeError: (stream, err) =>
        this.deps.logger.error(
          { instance: instance.name, stream, err: err.message },
          'log pipe died',
        ),
    });

    const tracked: Tracked = {
      handle,
      instance,
      backoff,
      stopRequested: false,
      exitWatcher: Promise.resolve(),
    };
    this.tracked.set(instance.name, tracked);
    this.deps.onStatusChange(instance.name, 'running');

    tracked.exitWatcher = handle.proc.exited.then((code) => this.handleExit(instance, code));
  }

  private async handleExit(instance: Instance, code: number | null): Promise<void> {
    const t = this.tracked.get(instance.name);
    if (!t || t.stopRequested) {
      this.tracked.delete(instance.name);
      return;
    }
    this.tracked.delete(instance.name);

    const decision = decideRestart(t.backoff, Date.now());
    if (decision.action === 'give-up') {
      this.deps.onStatusChange(
        instance.name,
        'error',
        `Process exited (code=${code}) and exceeded restart budget`,
      );
      return;
    }

    const timer = setTimeout(() => {
      this.pendingRespawn.delete(instance.name);
      void this.spawn(instance, decision.nextState).catch((err: unknown) => {
        this.deps.onStatusChange(
          instance.name,
          'error',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, decision.delayMs);
    this.pendingRespawn.set(instance.name, timer);
  }
}
