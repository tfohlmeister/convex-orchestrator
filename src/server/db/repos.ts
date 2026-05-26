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
          created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  updateStatus(name: string, status: InstanceStatus, lastError: string | null = null): void {
    this.db
      .prepare('UPDATE instances SET status = ?, last_error = ?, updated_at = ? WHERE name = ?')
      .run(status, lastError, Date.now(), name);
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

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  instanceName?: string | null;
  details?: string | null;
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
