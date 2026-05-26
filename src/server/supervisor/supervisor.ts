import { spawnConvex, type SpawnHandle } from './spawn.ts';
import { decideRestart, type BackoffState } from './watcher.ts';
import { gracefulStop, stopAll } from './shutdown.ts';
import { ResourceSampler, type ResourceSink } from './resources.ts';
import type { Instance } from './types.ts';

export interface SupervisorDeps {
  binaryPath: string;
  logDir: string;
  databaseUrl: (instance: Instance) => string;
  s3: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    region: string;
  };
  externalScheme: 'http' | 'https';
  externalPortSuffix: string;
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
    const t = this.tracked.get(name);
    if (!t) return;
    t.stopRequested = true;
    await gracefulStop(t.handle.proc);
    this.tracked.delete(name);
    this.deps.onStatusChange(name, 'stopped');
  }

  async stopAllForShutdown(): Promise<void> {
    const procs = Array.from(this.tracked.values()).map((t) => {
      t.stopRequested = true;
      return t.handle.proc;
    });
    await stopAll(procs);
    this.tracked.clear();
  }

  private async spawn(instance: Instance, backoff: BackoffState): Promise<void> {
    const handle = await spawnConvex({
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

    setTimeout(() => {
      void this.spawn(instance, decision.nextState).catch((err: unknown) => {
        this.deps.onStatusChange(
          instance.name,
          'error',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, decision.delayMs);
  }
}
