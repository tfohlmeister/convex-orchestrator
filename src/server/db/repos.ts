import type { DB } from './index.ts';
import { decrypt, encrypt } from '../crypto.ts';
import type { Instance, InstanceStatus, ResourceSample } from '../supervisor/types.ts';

interface InstanceRow {
  name: string;
  status: InstanceStatus;
  base_domain: string;
  cloud_port: number;
  site_port: number;
  admin_key_enc: Buffer;
  instance_secret_enc: Buffer;
  postgres_schema: string;
  bucket_prefix: string;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  backup_cron: string | null;
  backup_retention_days: number | null;
  backup_enabled: number | null;
  backup_suspended: number;
}

export class InstanceRepo {
  constructor(
    private readonly db: DB,
    private readonly masterKey: string,
  ) {}

  insert(instance: Instance): void {
    this.db
      .prepare(
        `INSERT INTO instances (
          name, status, base_domain, cloud_port, site_port,
          admin_key_enc, instance_secret_enc,
          postgres_schema, bucket_prefix,
          created_at, updated_at, last_error,
          backup_cron, backup_retention_days, backup_enabled, backup_suspended
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instance.name,
        instance.status,
        instance.baseDomain,
        instance.cloudPort,
        instance.sitePort,
        encrypt(instance.adminKey, this.masterKey),
        encrypt(instance.instanceSecret, this.masterKey),
        instance.postgresSchema,
        instance.bucketPrefix,
        instance.createdAt,
        instance.updatedAt,
        instance.lastError ?? null,
        instance.backupCron,
        instance.backupRetentionDays,
        instance.backupEnabled === null ? null : instance.backupEnabled ? 1 : 0,
        instance.backupSuspended ? 1 : 0,
      );
  }

  updateStatus(name: string, status: InstanceStatus, lastError: string | null = null): void {
    this.db
      .prepare('UPDATE instances SET status = ?, last_error = ?, updated_at = ? WHERE name = ?')
      .run(status, lastError, Date.now(), name);
  }

  updateBackupConfig(
    name: string,
    cfg: {
      cron?: string | null;
      retentionDays?: number | null;
      enabled?: boolean | null;
      suspended?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (cfg.cron !== undefined) {
      sets.push('backup_cron = ?');
      args.push(cfg.cron);
    }
    if (cfg.retentionDays !== undefined) {
      sets.push('backup_retention_days = ?');
      args.push(cfg.retentionDays);
    }
    if (cfg.enabled !== undefined) {
      sets.push('backup_enabled = ?');
      args.push(cfg.enabled === null ? null : cfg.enabled ? 1 : 0);
    }
    if (cfg.suspended !== undefined) {
      sets.push('backup_suspended = ?');
      args.push(cfg.suspended ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(Date.now());
    args.push(name);
    this.db.prepare(`UPDATE instances SET ${sets.join(', ')} WHERE name = ?`).run(...args);
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM instances WHERE name = ?').run(name);
  }

  get(name: string): Instance | null {
    const row = this.db
      .query<InstanceRow, [string]>('SELECT * FROM instances WHERE name = ?')
      .get(name);
    return row ? this.rowToInstance(row) : null;
  }

  list(): Instance[] {
    const rows = this.db.query<InstanceRow, []>('SELECT * FROM instances ORDER BY name').all();
    return rows.map((r) => this.rowToInstance(r));
  }

  listByStatus(status: InstanceStatus): Instance[] {
    const rows = this.db
      .query<
        InstanceRow,
        [InstanceStatus]
      >('SELECT * FROM instances WHERE status = ? ORDER BY name')
      .all(status);
    return rows.map((r) => this.rowToInstance(r));
  }

  private rowToInstance(row: InstanceRow): Instance {
    return {
      name: row.name,
      status: row.status,
      baseDomain: row.base_domain,
      cloudPort: row.cloud_port,
      sitePort: row.site_port,
      adminKey: decrypt(row.admin_key_enc, this.masterKey),
      instanceSecret: decrypt(row.instance_secret_enc, this.masterKey),
      postgresSchema: row.postgres_schema,
      bucketPrefix: row.bucket_prefix,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
      backupCron: row.backup_cron,
      backupRetentionDays: row.backup_retention_days,
      backupEnabled: row.backup_enabled === null ? null : row.backup_enabled === 1,
      backupSuspended: row.backup_suspended === 1,
    };
  }
}

export class PortRepo {
  constructor(private readonly db: DB) {}

  reserve(port: number, instanceName: string, role: 'cloud' | 'site'): void {
    this.db
      .prepare(
        'INSERT INTO port_allocations (port, instance_name, role, allocated_at) VALUES (?, ?, ?, ?)',
      )
      .run(port, instanceName, role, Date.now());
  }

  isReserved(port: number): boolean {
    const row = this.db
      .query<{ c: number }, [number]>('SELECT COUNT(*) AS c FROM port_allocations WHERE port = ?')
      .get(port);
    return (row?.c ?? 0) > 0;
  }

  releaseForInstance(name: string): void {
    this.db.prepare('DELETE FROM port_allocations WHERE instance_name = ?').run(name);
  }

  allReserved(): Set<number> {
    const rows = this.db.query<{ port: number }, []>('SELECT port FROM port_allocations').all();
    return new Set(rows.map((r) => r.port));
  }
}

export class ResourceSampleRepo {
  constructor(private readonly db: DB) {}

  insert(sample: ResourceSample): void {
    this.db
      .prepare(
        'INSERT INTO resource_samples (instance_name, taken_at, rss_kb, cpu_ticks, fd_count) VALUES (?, ?, ?, ?, ?)',
      )
      .run(sample.instanceName, sample.takenAt, sample.rssKb, sample.cpuTicks, sample.fdCount);
  }

  pruneOlderThan(cutoffMs: number): void {
    this.db.prepare('DELETE FROM resource_samples WHERE taken_at < ?').run(cutoffMs);
  }

  recentFor(name: string, sinceMs: number): ResourceSample[] {
    // Pull one extra sample older than `sinceMs` so callers that derive
    // delta-based metrics (CPU%) have a starting reference point and the
    // first plotted point isn't pushed forward by one sample interval.
    const olderRow = this.db
      .query<
        {
          instance_name: string;
          taken_at: number;
          rss_kb: number;
          cpu_ticks: number;
          fd_count: number;
        },
        [string, number]
      >(
        'SELECT instance_name, taken_at, rss_kb, cpu_ticks, fd_count FROM resource_samples WHERE instance_name = ? AND taken_at < ? ORDER BY taken_at DESC LIMIT 1',
      )
      .get(name, sinceMs);

    const rows = this.db
      .query<
        {
          instance_name: string;
          taken_at: number;
          rss_kb: number;
          cpu_ticks: number;
          fd_count: number;
        },
        [string, number]
      >(
        'SELECT instance_name, taken_at, rss_kb, cpu_ticks, fd_count FROM resource_samples WHERE instance_name = ? AND taken_at >= ? ORDER BY taken_at',
      )
      .all(name, sinceMs);

    const mapped = rows.map((r) => ({
      instanceName: r.instance_name,
      takenAt: r.taken_at,
      rssKb: r.rss_kb,
      cpuTicks: r.cpu_ticks,
      fdCount: r.fd_count,
    }));
    if (olderRow) {
      mapped.unshift({
        instanceName: olderRow.instance_name,
        takenAt: olderRow.taken_at,
        rssKb: olderRow.rss_kb,
        cpuTicks: olderRow.cpu_ticks,
        fdCount: olderRow.fd_count,
      });
    }
    return mapped;
  }

  // Returns the most recent two samples for delta-based metric derivation
  // (e.g. CPU%). Order: oldest first.
  latestPair(name: string): ResourceSample[] {
    const rows = this.db
      .query<
        {
          instance_name: string;
          taken_at: number;
          rss_kb: number;
          cpu_ticks: number;
          fd_count: number;
        },
        [string]
      >(
        'SELECT instance_name, taken_at, rss_kb, cpu_ticks, fd_count FROM resource_samples WHERE instance_name = ? ORDER BY taken_at DESC LIMIT 2',
      )
      .all(name);
    return rows
      .map((r) => ({
        instanceName: r.instance_name,
        takenAt: r.taken_at,
        rssKb: r.rss_kb,
        cpuTicks: r.cpu_ticks,
        fdCount: r.fd_count,
      }))
      .reverse();
  }

  latestFor(name: string): ResourceSample | null {
    const r = this.db
      .query<
        {
          instance_name: string;
          taken_at: number;
          rss_kb: number;
          cpu_ticks: number;
          fd_count: number;
        },
        [string]
      >(
        'SELECT instance_name, taken_at, rss_kb, cpu_ticks, fd_count FROM resource_samples WHERE instance_name = ? ORDER BY taken_at DESC LIMIT 1',
      )
      .get(name);
    return r
      ? {
          instanceName: r.instance_name,
          takenAt: r.taken_at,
          rssKb: r.rss_kb,
          cpuTicks: r.cpu_ticks,
          fdCount: r.fd_count,
        }
      : null;
  }
}

export interface StorageSample {
  instanceName: string;
  takenAt: number;
  bucketSuffix: string;
  sizeBytes: number;
  objectCount: number;
  partial: boolean;
}

export class StorageSampleRepo {
  constructor(private readonly db: DB) {}

  insertMany(samples: StorageSample[]): void {
    if (samples.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT INTO storage_samples (instance_name, taken_at, bucket_suffix, size_bytes, object_count, partial) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const s of samples) {
        stmt.run(
          s.instanceName,
          s.takenAt,
          s.bucketSuffix,
          s.sizeBytes,
          s.objectCount,
          s.partial ? 1 : 0,
        );
      }
    })();
  }

  recentFor(name: string, sinceMs: number): StorageSample[] {
    const rows = this.db
      .query<
        {
          instance_name: string;
          taken_at: number;
          bucket_suffix: string;
          size_bytes: number;
          object_count: number;
          partial: number;
        },
        [string, number]
      >(
        'SELECT instance_name, taken_at, bucket_suffix, size_bytes, object_count, partial FROM storage_samples WHERE instance_name = ? AND taken_at >= ? ORDER BY taken_at',
      )
      .all(name, sinceMs);
    return rows.map((r) => ({
      instanceName: r.instance_name,
      takenAt: r.taken_at,
      bucketSuffix: r.bucket_suffix,
      sizeBytes: r.size_bytes,
      objectCount: r.object_count,
      partial: r.partial === 1,
    }));
  }

  latestPerBucketFor(name: string): StorageSample[] {
    const rows = this.db
      .query<
        {
          instance_name: string;
          taken_at: number;
          bucket_suffix: string;
          size_bytes: number;
          object_count: number;
          partial: number;
        },
        [string]
      >(
        `SELECT s.instance_name, s.taken_at, s.bucket_suffix, s.size_bytes, s.object_count, s.partial
         FROM storage_samples s
         INNER JOIN (
           SELECT bucket_suffix, MAX(taken_at) AS max_taken
           FROM storage_samples
           WHERE instance_name = ?1
           GROUP BY bucket_suffix
         ) latest
           ON s.bucket_suffix = latest.bucket_suffix
           AND s.taken_at = latest.max_taken
         WHERE s.instance_name = ?1`,
      )
      .all(name);
    return rows.map((r) => ({
      instanceName: r.instance_name,
      takenAt: r.taken_at,
      bucketSuffix: r.bucket_suffix,
      sizeBytes: r.size_bytes,
      objectCount: r.object_count,
      partial: r.partial === 1,
    }));
  }

  pruneOlderThan(cutoffMs: number): void {
    this.db.prepare('DELETE FROM storage_samples WHERE taken_at < ?').run(cutoffMs);
  }
}

export type BackupSource = 'auto' | 'manual' | 'manual-upload' | 'pre-restore';
export type BackupStatus = 'running' | 'complete' | 'failed' | 'stuck' | 'corrupt';

export interface Backup {
  id: string;
  instanceName: string;
  source: BackupSource;
  startedAt: number;
  completedAt: number | null;
  status: BackupStatus;
  targetKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  convexVersion: string | null;
  errorMessage: string | null;
}

interface BackupRow {
  id: string;
  instance_name: string;
  source: BackupSource;
  started_at: number;
  completed_at: number | null;
  status: BackupStatus;
  target_key: string | null;
  size_bytes: number | null;
  sha256: string | null;
  convex_version: string | null;
  error_message: string | null;
}

export class BackupRepo {
  constructor(private readonly db: DB) {}

  insert(b: Backup): void {
    this.db
      .prepare(
        `INSERT INTO backups (
          id, instance_name, source, started_at, completed_at,
          status, target_key, size_bytes, sha256, convex_version, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.id,
        b.instanceName,
        b.source,
        b.startedAt,
        b.completedAt,
        b.status,
        b.targetKey,
        b.sizeBytes,
        b.sha256,
        b.convexVersion,
        b.errorMessage,
      );
  }

  updateStatus(
    id: string,
    fields: {
      status?: BackupStatus;
      completedAt?: number | null;
      targetKey?: string | null;
      sizeBytes?: number | null;
      sha256?: string | null;
      convexVersion?: string | null;
      errorMessage?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (fields.status !== undefined) {
      sets.push('status = ?');
      args.push(fields.status);
    }
    if (fields.completedAt !== undefined) {
      sets.push('completed_at = ?');
      args.push(fields.completedAt);
    }
    if (fields.targetKey !== undefined) {
      sets.push('target_key = ?');
      args.push(fields.targetKey);
    }
    if (fields.sizeBytes !== undefined) {
      sets.push('size_bytes = ?');
      args.push(fields.sizeBytes);
    }
    if (fields.sha256 !== undefined) {
      sets.push('sha256 = ?');
      args.push(fields.sha256);
    }
    if (fields.convexVersion !== undefined) {
      sets.push('convex_version = ?');
      args.push(fields.convexVersion);
    }
    if (fields.errorMessage !== undefined) {
      sets.push('error_message = ?');
      args.push(fields.errorMessage);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE backups SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  get(id: string): Backup | null {
    const r = this.db.query<BackupRow, [string]>('SELECT * FROM backups WHERE id = ?').get(id);
    return r ? this.rowToBackup(r) : null;
  }

  recentFor(instanceName: string, limit = 50): Backup[] {
    const rows = this.db
      .query<
        BackupRow,
        [string, number]
      >('SELECT * FROM backups WHERE instance_name = ? ORDER BY started_at DESC LIMIT ?')
      .all(instanceName, limit);
    return rows.map((r) => this.rowToBackup(r));
  }

  // Returns automatic backups whose started_at is older than `cutoffMs`.
  // Pre-restore + manual backups are intentionally excluded — only `auto`
  // is subject to standard retention.
  listOlderThan(instanceName: string, source: BackupSource, cutoffMs: number): Backup[] {
    const rows = this.db
      .query<
        BackupRow,
        [string, BackupSource, number]
      >("SELECT * FROM backups WHERE instance_name = ? AND source = ? AND started_at < ? AND status = 'complete' ORDER BY started_at")
      .all(instanceName, source, cutoffMs);
    return rows.map((r) => this.rowToBackup(r));
  }

  latestFor(instanceName: string): Backup | null {
    const r = this.db
      .query<
        BackupRow,
        [string]
      >('SELECT * FROM backups WHERE instance_name = ? ORDER BY started_at DESC LIMIT 1')
      .get(instanceName);
    return r ? this.rowToBackup(r) : null;
  }

  latestCompleteFor(instanceName: string): Backup | null {
    const r = this.db
      .query<
        BackupRow,
        [string]
      >("SELECT * FROM backups WHERE instance_name = ? AND status = 'complete' ORDER BY started_at DESC LIMIT 1")
      .get(instanceName);
    return r ? this.rowToBackup(r) : null;
  }

  // Consecutive failed `auto` backups since the last successful one. Used by
  // the scheduler to suspend automatic backups after 3 strikes.
  consecutiveAutoFailures(instanceName: string): number {
    const rows = this.db
      .query<
        { status: BackupStatus },
        [string]
      >("SELECT status FROM backups WHERE instance_name = ? AND source = 'auto' ORDER BY started_at DESC LIMIT 10")
      .all(instanceName);
    let count = 0;
    for (const r of rows) {
      if (r.status === 'failed' || r.status === 'stuck' || r.status === 'corrupt') count += 1;
      else break;
    }
    return count;
  }

  listRunningStarted(beforeMs: number): Backup[] {
    const rows = this.db
      .query<
        BackupRow,
        [number]
      >("SELECT * FROM backups WHERE status = 'running' AND started_at < ?")
      .all(beforeMs);
    return rows.map((r) => this.rowToBackup(r));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }

  private rowToBackup(r: BackupRow): Backup {
    return {
      id: r.id,
      instanceName: r.instance_name,
      source: r.source,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      status: r.status,
      targetKey: r.target_key,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      convexVersion: r.convex_version,
      errorMessage: r.error_message,
    };
  }
}

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  instanceName?: string | null;
  details?: string | null;
}

// Persisted view of an in-progress or completed restore. RestoreManager
// writes here on every state transition so a poll after orchestrator
// restart returns the last known state instead of a misleading 404.
export type RestoreJobStatus =
  | 'queued'
  | 'pre-backup'
  | 'stopping'
  | 'starting'
  | 'importing'
  | 'complete'
  | 'failed';

export interface PersistedRestoreJob {
  id: string;
  instanceName: string;
  sourceBackupId: string;
  preRestoreBackupId: string | null;
  status: RestoreJobStatus;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

interface RestoreJobRow {
  id: string;
  instance_name: string;
  source_backup_id: string;
  pre_restore_backup_id: string | null;
  status: RestoreJobStatus;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

function rowToRestoreJob(r: RestoreJobRow): PersistedRestoreJob {
  return {
    id: r.id,
    instanceName: r.instance_name,
    sourceBackupId: r.source_backup_id,
    preRestoreBackupId: r.pre_restore_backup_id,
    status: r.status,
    error: r.error,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export class RestoreJobRepo {
  constructor(private readonly db: DB) {}

  insert(j: PersistedRestoreJob): void {
    this.db
      .prepare(
        `INSERT INTO restore_jobs (
          id, instance_name, source_backup_id, pre_restore_backup_id,
          status, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        j.id,
        j.instanceName,
        j.sourceBackupId,
        j.preRestoreBackupId,
        j.status,
        j.error,
        j.startedAt,
        j.completedAt,
      );
  }

  update(
    id: string,
    fields: {
      status?: RestoreJobStatus;
      preRestoreBackupId?: string | null;
      error?: string | null;
      completedAt?: number | null;
    },
  ): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (fields.status !== undefined) {
      sets.push('status = ?');
      args.push(fields.status);
    }
    if (fields.preRestoreBackupId !== undefined) {
      sets.push('pre_restore_backup_id = ?');
      args.push(fields.preRestoreBackupId);
    }
    if (fields.error !== undefined) {
      sets.push('error = ?');
      args.push(fields.error);
    }
    if (fields.completedAt !== undefined) {
      sets.push('completed_at = ?');
      args.push(fields.completedAt);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE restore_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  get(id: string): PersistedRestoreJob | null {
    const row = this.db
      .query<RestoreJobRow, [string]>('SELECT * FROM restore_jobs WHERE id = ?')
      .get(id);
    return row ? rowToRestoreJob(row) : null;
  }

  // Used on orchestrator boot to flip any `running` (status not in
  // {complete, failed}) jobs to `failed` with an orchestrator-restart
  // marker, so the UI shows the truth instead of a stuck "importing"
  // forever.
  markInFlightAsFailed(reason: string, at: number): number {
    const result = this.db
      .prepare(
        `UPDATE restore_jobs
         SET status = 'failed', error = ?, completed_at = ?
         WHERE status NOT IN ('complete', 'failed')`,
      )
      .run(reason, at);
    return Number(result.changes);
  }
}

export class AuditRepo {
  constructor(private readonly db: DB) {}

  record(entry: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (at, actor, action, instance_name, details) VALUES (?, ?, ?, ?, ?)',
      )
      .run(entry.at, entry.actor, entry.action, entry.instanceName ?? null, entry.details ?? null);
  }

  recentFor(name: string, limit = 100): AuditEntry[] {
    const rows = this.db
      .query<
        {
          at: number;
          actor: string;
          action: string;
          instance_name: string | null;
          details: string | null;
        },
        [string, number]
      >(
        'SELECT at, actor, action, instance_name, details FROM audit_log WHERE instance_name = ? ORDER BY at DESC LIMIT ?',
      )
      .all(name, limit);
    return rows.map((r) => ({
      at: r.at,
      actor: r.actor,
      action: r.action,
      instanceName: r.instance_name,
      details: r.details,
    }));
  }
}
