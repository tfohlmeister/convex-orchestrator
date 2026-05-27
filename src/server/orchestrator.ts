import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { AuditRepo, InstanceRepo, ResourceSampleRepo } from './db/repos.ts';
import type { PortAllocator } from './ports.ts';
import type { PostgresStorage } from './storage/postgres.ts';
import type { MinioStorage } from './storage/minio.ts';
import { generateAdminKey } from './storage/admin-key.ts';
import type { Supervisor } from './supervisor/supervisor.ts';
import type { Instance } from './supervisor/types.ts';
import type { TraefikWriter } from './traefik/writer.ts';
import type { BackupManager } from './backups/manager.ts';
import { OrchestratorError } from './api/errors.ts';
import { cloudUrl } from './urls.ts';

export interface OrchestratorDeps {
  config: Config;
  logger: Logger;
  instances: InstanceRepo;
  audit: AuditRepo;
  samples: ResourceSampleRepo;
  ports: PortAllocator;
  postgres: PostgresStorage;
  minio: MinioStorage;
  supervisor: Supervisor;
  traefik: TraefikWriter;
  // Optional so the Orchestrator can be constructed before the
  // BackupManager (the latter currently depends on Orchestrator via
  // forceRestartBackend). Set via attachBackupManager after both exist.
  backupManager?: BackupManager;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  // Wire the BackupManager after construction to break the circular dep
  // (BackupManager needs forceRestartBackend on Orchestrator).
  attachBackupManager(manager: BackupManager): void {
    this.deps.backupManager = manager;
  }

  list(): Instance[] {
    return this.deps.instances.list();
  }

  get(name: string): Instance {
    const inst = this.deps.instances.get(name);
    if (!inst) throw new OrchestratorError(404, 'NOT_FOUND', `instance ${name} not found`);
    return inst;
  }

  async create(name: string, actor: string): Promise<Instance> {
    if (this.deps.instances.get(name)) {
      throw new OrchestratorError(409, 'ALREADY_EXISTS', `instance ${name} already exists`);
    }

    const now = Date.now();
    const instanceSecret = randomBytes(32).toString('hex');
    const bucketPrefix = this.deps.minio.bucketPrefix(name);

    this.deps.logger.info({ name }, 'creating instance');
    const adminKey = await generateAdminKey(
      { binaryPath: this.deps.config.GENERATE_KEY_BINARY },
      name,
      instanceSecret,
    );

    // Postgres in multitenant mode: nothing per-instance to create. The
    // shared db was set up at orchestrator boot; tenant rows get the
    // instance_name column when the backend writes.
    await this.deps.minio.createBucketsForInstance(bucketPrefix);

    const { cloud, site } = this.deps.ports.allocatePair(name);
    const instance: Instance = {
      name,
      status: 'creating',
      baseDomain: this.deps.config.BASE_DOMAIN,
      cloudPort: cloud,
      sitePort: site,
      adminKey,
      instanceSecret,
      postgresSchema: this.deps.postgres.sharedDatabaseName(),
      bucketPrefix,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      backupCron: null,
      backupRetentionDays: null,
      backupEnabled: null,
      backupSuspended: false,
    };
    this.deps.instances.insert(instance);
    this.deps.audit.record({ at: now, actor, action: 'create', instanceName: name });

    try {
      await this.spawnAndRoute(instance);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.instances.updateStatus(name, 'error', msg);
      throw err;
    }
    return this.get(name);
  }

  async start(name: string, actor: string): Promise<void> {
    const inst = this.get(name);
    if (this.deps.supervisor.isRunning(name)) return;
    await this.spawnAndRoute(inst);
    this.deps.audit.record({ at: Date.now(), actor, action: 'start', instanceName: name });
  }

  async stop(name: string, actor: string): Promise<void> {
    this.get(name);
    await this.deps.supervisor.stop(name);
    this.deps.traefik.remove(name);
    await this.deps.traefik.commit();
    this.deps.audit.record({ at: Date.now(), actor, action: 'stop', instanceName: name });
  }

  async delete(name: string, actor: string): Promise<void> {
    const inst = this.get(name);
    await this.deps.supervisor.stop(name);
    this.deps.traefik.remove(name);
    await this.deps.traefik.commit();
    await this.deps.minio.deleteBucketsForInstance(inst.bucketPrefix);
    // NOTE: In postgres-v5-multitenant mode there's no per-instance schema to
    // drop; tenant rows for this instance remain in the shared tables. True
    // per-tenant purge is a Phase 2 problem (manual DELETE WHERE
    // instance_name = ? against the internal schema). See spike-notes §5.
    this.deps.ports.release(name);
    this.deps.instances.delete(name);
    // Purge backup-scheduler state so a same-name recreate gets a fresh
    // schedule instead of inheriting the predecessor's nextFire timestamp.
    this.deps.backupManager?.dropInstance(name);
    this.deps.audit.record({ at: Date.now(), actor, action: 'delete', instanceName: name });
  }

  // Pass-through to InstanceRepo so route handlers don't have to know the
  // db is hiding inside `deps`. Validates the instance exists.
  updateBackupConfig(
    name: string,
    cfg: {
      cron?: string | null;
      retentionDays?: number | null;
      enabled?: boolean | null;
      suspended?: boolean;
    },
  ): void {
    this.get(name);
    this.deps.instances.updateBackupConfig(name, cfg);
  }

  // Hard-restart the backend for a stuck export. SIGTERM via supervisor.stop
  // unblocks the Convex `ExportInProgress` lock (only resolves via process
  // restart). Re-spawns immediately and re-attaches the Traefik route.
  async forceRestartBackend(name: string, actor: string): Promise<void> {
    const inst = this.get(name);
    this.deps.logger.warn({ name }, 'force-restart-backend (stuck export recovery)');
    await this.deps.supervisor.stop(name);
    await this.spawnAndRoute(inst);
    this.deps.audit.record({
      at: Date.now(),
      actor,
      action: 'backend_restart_for_stuck_export',
      instanceName: name,
    });
  }

  async restoreRunning(): Promise<void> {
    const running = this.deps.instances.listByStatus('running');
    for (const inst of running) {
      try {
        await this.spawnAndRoute(inst);
        this.deps.logger.info({ name: inst.name }, 'restored running instance');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.instances.updateStatus(inst.name, 'error', msg);
        this.deps.logger.error({ name: inst.name, err: msg }, 'failed to restore instance');
      }
    }
  }

  deployments(): { deployments: { name: string; adminKey: string; url: string }[] } {
    const running = this.deps.instances.listByStatus('running');
    return {
      deployments: running.map((i) => ({
        name: i.name,
        adminKey: i.adminKey,
        url: cloudUrl(i, this.deps.config),
      })),
    };
  }

  private async spawnAndRoute(instance: Instance): Promise<void> {
    await this.deps.supervisor.start(instance);
    this.deps.traefik.set({
      instanceName: instance.name,
      cloudHost: `${instance.name}.${instance.baseDomain}`,
      siteHost: `${instance.name}-site.${instance.baseDomain}`,
      cloudPort: instance.cloudPort,
      sitePort: instance.sitePort,
    });
    await this.deps.traefik.commit();
    this.deps.instances.updateStatus(instance.name, 'running');
  }
}
