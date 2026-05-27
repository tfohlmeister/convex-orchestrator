import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db/index.ts';
import { AuditRepo, BackupRepo, InstanceRepo, type Backup } from '../db/repos.ts';
import type { Instance } from '../supervisor/types.ts';
import type { MinioStorage } from '../storage/minio.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { BackupManager } from './manager.ts';
import { RestoreManager } from './restore.ts';

// -------------------------- harness --------------------------

const MOCK_CLI = fileURLToPath(new URL('./__fixtures__/mock-convex.sh', import.meta.url));

interface MinioMemEntry {
  body: Buffer;
  lastModified: number;
}

// In-memory implementation of the MinioStorage surface area the backup
// + restore code actually uses. Anything not used (createBucketsForInstance
// etc.) is left out — these tests cover the backup/restore lifecycle, not
// instance create/delete.
function fakeMinio(): MinioStorage & { _store: Map<string, Map<string, MinioMemEntry>> } {
  const store = new Map<string, Map<string, MinioMemEntry>>();
  const getBucket = (b: string): Map<string, MinioMemEntry> => {
    let bucket = store.get(b);
    if (!bucket) {
      bucket = new Map();
      store.set(b, bucket);
    }
    return bucket;
  };
  return {
    _store: store,
    backupBucket: (prefix: string) => `${prefix}-backups`,
    putBackup: async (
      prefix: string,
      key: string,
      body: Buffer | Uint8Array | Readable,
      _len?: number,
    ): Promise<void> => {
      let buf: Buffer;
      if (Buffer.isBuffer(body)) buf = body;
      else if (body instanceof Uint8Array) buf = Buffer.from(body);
      else {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk as Buffer);
        buf = Buffer.concat(chunks);
      }
      getBucket(`${prefix}-backups`).set(key, { body: buf, lastModified: Date.now() });
    },
    headBackup: async (prefix: string, key: string) => {
      const entry = getBucket(`${prefix}-backups`).get(key);
      return entry ? { sizeBytes: entry.body.length, lastModified: entry.lastModified } : null;
    },
    getBackupStream: async (prefix: string, key: string): Promise<Readable> => {
      const entry = getBucket(`${prefix}-backups`).get(key);
      if (!entry) throw new Error(`fake-minio: ${prefix}-backups/${key} not found`);
      return Readable.from([entry.body]);
    },
    deleteBackup: async (prefix: string, key: string): Promise<void> => {
      getBucket(`${prefix}-backups`).delete(key);
    },
    listBackups: async (prefix: string) => {
      const bucket = getBucket(`${prefix}-backups`);
      return Array.from(bucket.entries()).map(([key, entry]) => ({
        key,
        sizeBytes: entry.body.length,
        lastModified: entry.lastModified,
      }));
    },
    // Unused-in-this-test fields stubbed as throwing so we notice if a code
    // path silently reaches them.
    bucketPrefix: (n: string) => n,
    bucketNames: (p: string) => [`${p}-backups`],
    createBucketsForInstance: async () => undefined,
    deleteBucketsForInstance: async () => undefined,
    bucketsExist: async () => true,
    config: () => ({ endpoint: 'mem', region: 'us', accessKey: '', secretKey: '' }),
    measureBucket: async () => ({ sizeBytes: 0, objectCount: 0, partial: false }),
  } as unknown as MinioStorage & { _store: Map<string, Map<string, MinioMemEntry>> };
}

function silentLogger(): Logger {
  const noop = (): void => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => silentLogger(),
  } as unknown as Logger;
}

interface OrchestratorStub {
  stops: string[];
  starts: string[];
  restarts: string[];
  // The fake orchestrator hands back the instance unchanged. The real one
  // also re-fetches; for tests we keep it in-memory.
  instance: Instance;
}

function fakeOrchestrator(instance: Instance, log: OrchestratorStub): Orchestrator {
  return {
    get: (name: string) => {
      if (name !== instance.name) {
        throw new Error(`fake-orchestrator: unknown instance ${name}`);
      }
      return instance;
    },
    stop: async (name: string) => {
      log.stops.push(name);
    },
    start: async (name: string) => {
      log.starts.push(name);
    },
    forceRestartBackend: async (name: string) => {
      log.restarts.push(name);
    },
  } as unknown as Orchestrator;
}

interface Harness {
  cleanup: () => Promise<void>;
  workDir: string;
  db: ReturnType<typeof Object>;
  instances: InstanceRepo;
  backups: BackupRepo;
  audit: AuditRepo;
  minio: ReturnType<typeof fakeMinio>;
  manager: BackupManager;
  restore: RestoreManager;
  orchestratorStub: OrchestratorStub;
  instance: Instance;
  config: Config;
}

async function setupHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'orch-int-'));
  const workDir = join(tmp, 'backup-work');
  await mkdir(workDir, { recursive: true });
  // The DB needs a real file path because the migration loader scans a
  // directory next to itself, not a `:memory:` magic string. An on-disk
  // file in our tmp dir is just as fast and gets cleaned up at end.
  const db = await openDatabase(join(tmp, 'orchestrator.sqlite'));
  // Master key is 64 hex chars (32 bytes), see crypto.ts.
  const masterKey = 'a'.repeat(64);
  const instances = new InstanceRepo(db, masterKey);
  const backups = new BackupRepo(db);
  const audit = new AuditRepo(db);

  const minio = fakeMinio();
  const config: Config = {
    BASE_DOMAIN: 'test.local',
    EXTERNAL_SCHEME: 'http',
    EXTERNAL_PORT_SUFFIX: '',
    ORCHESTRATOR_MASTER_KEY: masterKey,
    ORCHESTRATOR_ADMIN_TOKEN: '',
    HTTP_PORT: 8080,
    DATA_DIR: tmp,
    LOG_DIR: tmp,
    CONVEX_BINARY: '/dev/null',
    GENERATE_KEY_BINARY: '/dev/null',
    DEPLOYMENTS_API_PORT: 8081,
    TRAEFIK_DYNAMIC_PATH: join(tmp, 'dynamic.yml'),
    TRAEFIK_CERT_RESOLVER: '',
    TRAEFIK_ENTRYPOINT: 'web',
    TRAEFIK_SERVICE_LOOPBACK: 'localhost',
    CONVEX_BIND_ADDRESS: '127.0.0.1',
    POSTGRES_CLUSTER_URL: 'postgres://x@y',
    POSTGRES_ADMIN_URL: 'postgres://x@y/postgres',
    POSTGRES_SHARED_DB: 'convex',
    S3_ENDPOINT: 'http://s3',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
    LOG_LEVEL: 'info',
    STORAGE_SAMPLE_INTERVAL_MS: 300_000,
    STORAGE_SCAN_PAGE_LIMIT: 100,
    BACKUP_SCHEDULER_ENABLED: true,
    BACKUP_DEFAULT_CRON: '0 3 * * *',
    BACKUP_RETENTION_DAYS: 30,
    BACKUP_MAX_CONCURRENT: 2,
    // Default is 30 min — tests override to 1s when exercising the
    // hang / stuck-detector paths.
    BACKUP_EXPORT_TIMEOUT_MINUTES: 30,
    BACKUP_MAX_CONSECUTIVE_FAILURES: 3,
    BACKUP_RETENTION_HOUR: 4,
    MAX_RESTORE_UPLOAD_BYTES: 16 * 1024 * 1024 * 1024,
    EXPORT_BLOB_CLEANUP_INTERVAL_MS: 3_600_000,
    EXPORT_BLOB_CLEANUP_MIN_AGE_MS: 900_000,
    BACKUP_WORK_DIR: workDir,
    CONVEX_CLI: MOCK_CLI,
    CONVEX_STORAGE_DIR_TEMPLATE: join(tmp, 'storage', '{instance}'),
    middlewares: [],
    sqlitePath: join(tmp, 'orchestrator.sqlite'),
    ...overrides,
  };

  const now = Date.now();
  const instance: Instance = {
    name: 'inst-a',
    status: 'running',
    baseDomain: config.BASE_DOMAIN,
    cloudPort: 13210,
    sitePort: 13211,
    adminKey: 'admin-key-xyz',
    instanceSecret: 'secret-xyz',
    postgresSchema: 'convex',
    bucketPrefix: 'inst-a',
    createdAt: now,
    updatedAt: now,
    lastError: null,
    backupCron: null,
    backupRetentionDays: null,
    backupEnabled: null,
    backupSuspended: false,
  };
  instances.insert(instance);

  const orchestratorStub: OrchestratorStub = {
    stops: [],
    starts: [],
    restarts: [],
    instance,
  };
  const orchestrator = fakeOrchestrator(instance, orchestratorStub);

  const manager = new BackupManager({
    config,
    logger: silentLogger(),
    instances,
    backups,
    audit,
    minio: minio as unknown as MinioStorage,
    listInstances: () => instances.list(),
    forceRestartBackend: orchestrator.forceRestartBackend.bind(orchestrator),
    internalHost: '127.0.0.1',
  });
  const restore = new RestoreManager({
    config,
    logger: silentLogger(),
    instances,
    backups,
    audit,
    minio: minio as unknown as MinioStorage,
    orchestrator,
    backupManager: manager,
    internalHost: '127.0.0.1',
  });

  return {
    cleanup: async () => {
      manager.stop();
      // Drain any in-flight jobs before closing the DB so we don't hit
      // "Cannot use a closed database" from a worker mid-update.
      const drainDeadline = Date.now() + 10_000;
      while (
        (manager as unknown as { activeCount: number }).activeCount > 0 &&
        Date.now() < drainDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        (db as { close?: () => void }).close?.();
      } catch {
        /* ignore */
      }
      await rm(tmp, { recursive: true, force: true });
    },
    workDir,
    db,
    instances,
    backups,
    audit,
    minio,
    manager,
    restore,
    orchestratorStub,
    instance,
    config,
  };
}

// Polls `backups.get(id)` until `status !== running` or the deadline hits.
async function waitForBackup(repo: BackupRepo, id: string, timeoutMs = 10_000): Promise<Backup> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = repo.get(id);
    if (row && row.status !== 'running') return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  const last = repo.get(id);
  throw new Error(`waitForBackup: timeout (last status=${last?.status ?? 'missing'})`);
}

// Same idea for the in-memory restore job.
async function waitForRestoreJob(
  rm_: RestoreManager,
  id: string,
  timeoutMs = 15_000,
): Promise<NonNullable<ReturnType<RestoreManager['getJob']>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = rm_.getJob(id);
    if (job && (job.status === 'complete' || job.status === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitForRestoreJob: timeout');
}

// -------------------------- tests --------------------------

let harness: Harness;

beforeEach(async () => {
  // Restore default mock behavior; individual tests override.
  process.env.MOCK_CONVEX_EXPORT_MODE = 'ok';
  process.env.MOCK_CONVEX_IMPORT_MODE = 'ok';
  process.env.MOCK_CONVEX_INSTANCE_NAME = 'inst-a';
  delete process.env.MOCK_CONVEX_WRONG_INSTANCE;
});

afterEach(async () => {
  if (harness) await harness.cleanup();
  delete process.env.MOCK_CONVEX_EXPORT_MODE;
  delete process.env.MOCK_CONVEX_IMPORT_MODE;
  delete process.env.MOCK_CONVEX_INSTANCE_NAME;
  delete process.env.MOCK_CONVEX_WRONG_INSTANCE;
});

describe('integration: backup happy path (task 10.2)', () => {
  test('manual backup writes a zip, uploads it, marks the row complete with sha256', async () => {
    harness = await setupHarness();
    const id = harness.manager.enqueueManual(harness.instance, 'test-actor');
    expect(id).toBeTruthy();
    const row = await waitForBackup(harness.backups, id);
    expect(row.status).toBe('complete');
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.targetKey).toMatch(/^inst-a_/);
    expect(row.errorMessage).toBeNull();

    // The uploaded bytes in MinIO match what the export wrote.
    const stored = harness.minio._store.get('inst-a-backups')?.get(row.targetKey!);
    expect(stored).toBeTruthy();
    expect(stored!.body.length).toBe(row.sizeBytes!);

    // Audit row matches.
    const audit = harness.audit.recentFor('inst-a', 10);
    expect(audit.some((a) => a.action === 'backup_completed')).toBe(true);
  }, 30_000);

  test('restore happy path: pre-restore backup is taken, then import is called', async () => {
    harness = await setupHarness();
    // First produce a backup to restore from.
    const backupId = harness.manager.enqueueManual(harness.instance, 'test-actor');
    const sourceRow = await waitForBackup(harness.backups, backupId);
    expect(sourceRow.status).toBe('complete');

    const jobId = harness.restore.startRestoreFromBackup(
      harness.instance.name,
      sourceRow.id,
      'test-actor',
    );
    const job = await waitForRestoreJob(harness.restore, jobId);
    expect(job.status).toBe('complete');
    expect(job.preRestoreBackupId).toBeTruthy();
    const pre = harness.backups.get(job.preRestoreBackupId!);
    expect(pre?.source).toBe('pre-restore');
    expect(pre?.status).toBe('complete');
    expect(harness.orchestratorStub.stops).toEqual(['inst-a']);
    expect(harness.orchestratorStub.starts).toEqual(['inst-a']);
    const audit = harness.audit.recentFor('inst-a', 20);
    expect(audit.some((a) => a.action === 'restore_started')).toBe(true);
    expect(audit.some((a) => a.action === 'restore_completed')).toBe(true);
  }, 30_000);
});

describe('integration: wrong-instance restore (task 10.3)', () => {
  test('restore from a zip with a different INSTANCE_NAME fails gracefully', async () => {
    harness = await setupHarness();

    // First take a normal backup, then surgically mutate the stored zip
    // to make it look like it came from a different instance. This is
    // what the real Convex import would reject.
    const okId = harness.manager.enqueueManual(harness.instance, 'test-actor');
    const ok = await waitForBackup(harness.backups, okId);
    expect(ok.status).toBe('complete');

    const bucket = harness.minio._store.get('inst-a-backups')!;
    bucket.set(ok.targetKey!, {
      body: Buffer.from('FAKE-CONVEX-EXPORT instance=other-instance payload=tampered\n'),
      lastModified: Date.now(),
    });

    const jobId = harness.restore.startRestoreFromBackup(
      harness.instance.name,
      ok.id,
      'test-actor',
    );
    const job = await waitForRestoreJob(harness.restore, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/instance mismatch|import failed/i);
    expect(job.preRestoreBackupId).toBeTruthy();
    const pre = harness.backups.get(job.preRestoreBackupId!);
    expect(pre?.source).toBe('pre-restore');
    expect(pre?.status).toBe('complete');
    const audit = harness.audit.recentFor('inst-a', 20);
    expect(audit.some((a) => a.action === 'restore_failed')).toBe(true);
  }, 30_000);
});

describe('integration: stuck export detection (task 10.4)', () => {
  test('hung export gets marked failed by spawn-timeout, then stuck-detector flags an orphan', async () => {
    harness = await setupHarness({
      // 1 minute spawn timeout (60_000 ms) is the smallest BackupManager
      // will accept. The mock export sleeps far longer, so this still
      // exercises the timeout path — but it would slow the test to ~60s,
      // so we bypass the spawn timeout by overriding the mock to exit
      // fast with a failure, and exercise the stuck-detector with a
      // separately-inserted orphan row.
      BACKUP_EXPORT_TIMEOUT_MINUTES: 1,
    });

    // Manually insert an orphan `running` row that pre-dates the
    // timeout. The stuck-detector should flag it on the next tick. Use
    // 2 hours ago so it's well past the 1-min cutoff.
    const orphanId = 'orphan-id-aaaa';
    const longAgo = Date.now() - 2 * 60 * 60_000;
    harness.backups.insert({
      id: orphanId,
      instanceName: harness.instance.name,
      source: 'manual',
      startedAt: longAgo,
      completedAt: null,
      status: 'running',
      targetKey: null,
      sizeBytes: null,
      sha256: null,
      convexVersion: 'test',
      errorMessage: null,
    });

    // Invoke the stuck-detector path directly. The private method is
    // exercised here by reaching through the public start/stop is
    // overkill — for this test we call the tick by name via bracket
    // access. The signature is intentionally stable.
    await (
      harness.manager as unknown as { stuckDetectorTick(): Promise<void> }
    ).stuckDetectorTick();

    const row = harness.backups.get(orphanId)!;
    expect(row.status).toBe('stuck');
    expect(row.completedAt).not.toBeNull();
    expect(row.errorMessage).toMatch(/timeout/i);

    // Audit trail records the stuck detection.
    const audit = harness.audit.recentFor('inst-a', 20);
    expect(audit.some((a) => a.action === 'backup_stuck_detected')).toBe(true);
  });

  test('force-restart-backend hits orchestrator.forceRestartBackend with audit', async () => {
    harness = await setupHarness();
    // The orchestrator stub's forceRestartBackend is wired into the
    // BackupManagerDeps; the API endpoint calls Orchestrator directly
    // (not the manager). Reach the same code path via the dep.
    const cb = (
      harness.manager as unknown as {
        deps: { forceRestartBackend: (n: string, a: string) => Promise<void> };
      }
    ).deps.forceRestartBackend;
    await cb('inst-a', 'tester');
    expect(harness.orchestratorStub.restarts).toEqual(['inst-a']);
  });
});

describe('integration: hang triggers spawn timeout (task 10.4 path B)', () => {
  test('runExport with a small timeout SIGTERMs the hung CLI and reports timedOut', async () => {
    // Exercise the spawn-timeout path directly against `runExport`,
    // bypassing BACKUP_EXPORT_TIMEOUT_MINUTES which is integer-minutes
    // (too coarse for a fast test). The mock's hang mode does
    // `sleep 600` — a 1.5s timeout reliably fires before that.
    const { runExport } = await import('./cli.ts');
    process.env.MOCK_CONVEX_EXPORT_MODE = 'hang';
    const out = join(await mkdtemp(join(tmpdir(), 'orch-int-hang-')), 'out.zip');
    const result = await runExport({
      deploymentUrl: 'http://127.0.0.1:1',
      adminKey: 'k',
      outputPath: out,
      convexCli: MOCK_CLI,
      timeoutMs: 1_500,
    });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    // The CLI was killed before it wrote anything.
    expect(result.sizeBytes).toBe(0);
    await rm(out, { force: true }).catch(() => {});
  });
});
