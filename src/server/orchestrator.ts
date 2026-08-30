import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { AuditRepo, InstanceRepo, ResourceSampleRepo } from './db/repos.ts';
import type { PortAllocator } from './ports.ts';
import {
  DatabaseExistsError,
  DatabaseMissingError,
  type PostgresStorage,
} from './storage/postgres.ts';
import type { MinioStorage } from './storage/minio.ts';
import { generateAdminKey } from './storage/admin-key.ts';
import type { Supervisor } from './supervisor/supervisor.ts';
import type { Instance } from './supervisor/types.ts';
import type { TraefikWriter } from './traefik/writer.ts';
import type { BackupManager } from './backups/manager.ts';
import type { RestartManager } from './restarts/manager.ts';
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
  // Optional, set via attachRestartManager after both exist. Only used to
  // purge per-instance scheduler state on delete.
  restartManager?: RestartManager;
  // Optional generateAdminKey override for tests. Production wires the
  // real binary-spawning helper from ./storage/admin-key.ts; tests
  // pass a deterministic stub so create() doesn't need a real binary.
  generateAdminKey?: typeof generateAdminKey;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  // Wire the BackupManager after construction to break the circular dep
  // (BackupManager needs forceRestartBackend on Orchestrator).
  attachBackupManager(manager: BackupManager): void {
    this.deps.backupManager = manager;
  }

  // Wire the RestartManager after construction (it needs scheduledRestart on
  // Orchestrator, which needs the supervisor — same circular-dep break as the
  // BackupManager).
  attachRestartManager(manager: RestartManager): void {
    this.deps.restartManager = manager;
  }

  list(): Instance[] {
    return this.deps.instances.list();
  }

  get(name: string): Instance {
    const inst = this.deps.instances.get(name);
    if (!inst) throw new OrchestratorError(404, 'NOT_FOUND', `instance ${name} not found`);
    return inst;
  }

  async create(name: string, actor: string, displayName: string | null = null): Promise<Instance> {
    if (this.deps.instances.get(name)) {
      throw new OrchestratorError(409, 'ALREADY_EXISTS', `instance ${name} already exists`);
    }

    const now = Date.now();
    const instanceSecret = randomBytes(32).toString('hex');
    const bucketPrefix = this.deps.minio.bucketPrefix(name);

    this.deps.logger.info({ name }, 'creating instance');
    const genKey = this.deps.generateAdminKey ?? generateAdminKey;
    const adminKey = await genKey(
      { binaryPath: this.deps.config.CONVEX_BINARY },
      name,
      instanceSecret,
    );

    let postgresDatabase: string;
    try {
      postgresDatabase = await this.deps.postgres.createDatabaseForInstance(name);
    } catch (err: unknown) {
      if (err instanceof DatabaseExistsError) {
        throw new OrchestratorError(
          409,
          'DATABASE_EXISTS',
          `${err.message}; pick a different instance name`,
        );
      }
      throw err;
    }

    // Creating the database is the one non-idempotent step (MinIO's bucket
    // create swallows already-exists, the SQLite insert is keyed by name).
    // If anything between here and the insert fails, drop it again: an
    // orphaned database would answer every retry of this name with a 409.
    let instance: Instance;
    try {
      await this.deps.minio.createBucketsForInstance(bucketPrefix);

      const { cloud, site } = this.deps.ports.allocatePair(name);
      instance = {
        name,
        displayName,
        status: 'creating',
        baseDomain: this.deps.config.BASE_DOMAIN,
        cloudPort: cloud,
        sitePort: site,
        adminKey,
        instanceSecret,
        postgresDatabase,
        bucketPrefix,
        createdAt: now,
        updatedAt: now,
        lastError: null,
        backupCron: null,
        backupRetentionDays: null,
        backupEnabled: null,
        backupSuspended: false,
        restartCron: null,
        restartEnabled: null,
      };
      this.deps.instances.insert(instance);
    } catch (err: unknown) {
      await this.deps.postgres.dropDatabaseForInstance(name).catch((dropErr: unknown) => {
        this.deps.logger.error(
          { name, err: dropErr instanceof Error ? dropErr.message : String(dropErr) },
          'failed to roll back the database of a half-created instance; drop it by hand before reusing the name',
        );
      });
      this.deps.ports.release(name);
      throw err;
    }
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
    // Database first, buckets second: if the drop fails, the backups are
    // still there and the delete can be retried. The other order would take
    // the only copy of the data with it.
    await this.deps.postgres.dropDatabaseForInstance(name);
    // Past the drop there is nothing left to save, so a bucket failure must
    // not abort the delete: that would leave a listed instance whose
    // database is gone, and every start would answer "restore from a backup"
    // for an instance the operator was deleting. Log the leftovers instead.
    await this.deps.minio.deleteBucketsForInstance(inst.bucketPrefix).catch((err: unknown) => {
      this.deps.logger.error(
        {
          name,
          bucketPrefix: inst.bucketPrefix,
          err: err instanceof Error ? err.message : String(err),
        },
        'instance deleted but its MinIO buckets remain; remove them by hand',
      );
    });
    this.deps.ports.release(name);
    this.deps.instances.delete(name);
    // Purge backup-scheduler state so a same-name recreate gets a fresh
    // schedule instead of inheriting the predecessor's nextFire timestamp.
    this.deps.backupManager?.dropInstance(name);
    this.deps.restartManager?.dropInstance(name);
    this.deps.audit.record({ at: Date.now(), actor, action: 'delete', instanceName: name });
  }

  setDisplayName(name: string, displayName: string | null, actor: string): void {
    this.get(name);
    this.deps.instances.setDisplayName(name, displayName);
    this.deps.audit.record({
      at: Date.now(),
      actor,
      action: 'set_display_name',
      instanceName: name,
    });
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

  // Pass-through to InstanceRepo for the per-instance scheduled-restart
  // config. Validates the instance exists.
  updateRestartConfig(
    name: string,
    cfg: {
      cron?: string | null;
      enabled?: boolean | null;
    },
  ): void {
    this.get(name);
    this.deps.instances.updateRestartConfig(name, cfg);
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

  // Cron-triggered restart to reclaim the backend + executor memory that
  // self-hosted Convex never frees at runtime. Same stop+respawn as
  // forceRestartBackend (supervisor.stop reaps the executor subtree), but
  // audited as a scheduled action. Called by the RestartManager.
  async scheduledRestart(name: string): Promise<void> {
    const inst = this.get(name);
    this.deps.logger.info({ name }, 'scheduled-restart (memory reclamation)');
    await this.deps.supervisor.stop(name);
    await this.spawnAndRoute(inst);
    this.deps.audit.record({
      at: Date.now(),
      actor: 'restart-scheduler',
      action: 'backend_restart_scheduled',
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
    // A missing database here is data loss, not something to paper over by
    // creating an empty one: refuse to start and let the operator restore.
    try {
      await this.deps.postgres.assertDatabaseForInstance(instance.name);
    } catch (err: unknown) {
      if (err instanceof DatabaseMissingError) {
        throw new OrchestratorError(
          409,
          'DATABASE_MISSING',
          `${err.message}; restore this instance from a backup instead of starting it empty`,
        );
      }
      // The probe itself failed (admin pool unreachable, auth, timeout).
      // That must not be worse than not probing at all: the scheduled
      // restart and the boot replay both run unattended, and refusing here
      // would leave the instance down behind a log line. Spawn anyway; if
      // the cluster really is gone the backend exits at once and the
      // supervisor's backoff owns the retry.
      this.deps.logger.warn(
        { name: instance.name, err: err instanceof Error ? err.message : String(err) },
        'could not verify the instance database, spawning anyway',
      );
    }
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
