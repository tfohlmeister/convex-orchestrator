import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from './index.ts';
import {
  InstanceRepo,
  ResourceSampleRepo,
  StorageSampleRepo,
  type StorageSample,
} from './repos.ts';
import type { Instance } from '../supervisor/types.ts';

let tmp: string;
let db: DB;

// 64-hex master key for the InstanceRepo at-rest encryption (admin key +
// instance secret). Test-only.
const TEST_MASTER_KEY = '0'.repeat(64);

function fullInstance(name: string): Instance {
  const now = Date.now();
  return {
    name,
    displayName: null,
    status: 'running',
    baseDomain: 'test.local',
    cloudPort: 13210,
    sitePort: 13211,
    adminKey: 'admin-key',
    instanceSecret: 'instance-secret',
    postgresSchema: 'public',
    bucketPrefix: name,
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
}

// Raw SQL to satisfy the resource_samples + storage_samples FK without
// going through InstanceRepo (which encrypts the admin key etc. — far
// more than these tests need).
function seedInstance(name: string): void {
  db.prepare(
    `INSERT INTO instances (
      name, status, base_domain, cloud_port, site_port,
      admin_key_enc, instance_secret_enc, postgres_schema, bucket_prefix,
      created_at, updated_at
    ) VALUES (?, 'running', 'test.local', 13210, 13211,
              X'00', X'00', 'public', ?, ?, ?)`,
  ).run(name, name, Date.now(), Date.now());
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'orch-repos-'));
  db = await openDatabase(join(tmp, 'orchestrator.sqlite'));
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  await rm(tmp, { recursive: true, force: true });
});

describe('ResourceSampleRepo', () => {
  test('recentFor returns rows after sinceMs plus one older anchor for delta derivation', () => {
    seedInstance('foo');
    const repo = new ResourceSampleRepo(db);
    const base = 1_000_000;
    // 4 samples: one before since, three after.
    for (const t of [base, base + 30_000, base + 60_000, base + 90_000]) {
      repo.insert({
        instanceName: 'foo',
        takenAt: t,
        rssKb: 100 + t,
        cpuTicks: t,
        fdCount: 1,
      });
    }
    const out = repo.recentFor('foo', base + 30_000);
    // Older anchor (base) prepended, then base+30k, base+60k, base+90k.
    expect(out.map((s) => s.takenAt)).toEqual([base, base + 30_000, base + 60_000, base + 90_000]);
  });

  test('recentFor skips the anchor when no row exists older than sinceMs', () => {
    seedInstance('foo');
    const repo = new ResourceSampleRepo(db);
    repo.insert({ instanceName: 'foo', takenAt: 5_000, rssKb: 1, cpuTicks: 1, fdCount: 1 });
    const out = repo.recentFor('foo', 0);
    expect(out.map((s) => s.takenAt)).toEqual([5_000]);
  });

  test('latestPair returns the two most-recent samples in chronological order', () => {
    seedInstance('foo');
    const repo = new ResourceSampleRepo(db);
    repo.insert({ instanceName: 'foo', takenAt: 100, rssKb: 1, cpuTicks: 1, fdCount: 1 });
    repo.insert({ instanceName: 'foo', takenAt: 200, rssKb: 2, cpuTicks: 2, fdCount: 1 });
    repo.insert({ instanceName: 'foo', takenAt: 300, rssKb: 3, cpuTicks: 3, fdCount: 1 });
    const pair = repo.latestPair('foo');
    expect(pair.map((s) => s.takenAt)).toEqual([200, 300]);
  });

  test('latestPair returns whatever rows exist (0 or 1) without throwing', () => {
    seedInstance('foo');
    const repo = new ResourceSampleRepo(db);
    expect(repo.latestPair('foo')).toEqual([]);
    repo.insert({ instanceName: 'foo', takenAt: 100, rssKb: 1, cpuTicks: 1, fdCount: 1 });
    const one = repo.latestPair('foo');
    expect(one).toHaveLength(1);
    expect(one[0]!.takenAt).toBe(100);
  });

  test('latestFor returns null for an unseen instance', () => {
    const repo = new ResourceSampleRepo(db);
    expect(repo.latestFor('ghost')).toBeNull();
  });

  test('pruneOlderThan removes rows older than the cutoff', () => {
    seedInstance('foo');
    const repo = new ResourceSampleRepo(db);
    repo.insert({ instanceName: 'foo', takenAt: 100, rssKb: 1, cpuTicks: 1, fdCount: 1 });
    repo.insert({ instanceName: 'foo', takenAt: 200, rssKb: 2, cpuTicks: 2, fdCount: 1 });
    repo.insert({ instanceName: 'foo', takenAt: 300, rssKb: 3, cpuTicks: 3, fdCount: 1 });
    repo.pruneOlderThan(200);
    const out = repo.recentFor('foo', 0);
    expect(out.map((s) => s.takenAt)).toEqual([200, 300]);
  });

  test('per-instance isolation — recentFor / latestPair / latestFor do not bleed across instances', () => {
    seedInstance('foo');
    seedInstance('bar');
    const repo = new ResourceSampleRepo(db);
    repo.insert({ instanceName: 'foo', takenAt: 100, rssKb: 1, cpuTicks: 1, fdCount: 1 });
    repo.insert({ instanceName: 'bar', takenAt: 200, rssKb: 2, cpuTicks: 2, fdCount: 1 });
    expect(repo.latestFor('foo')?.takenAt).toBe(100);
    expect(repo.latestFor('bar')?.takenAt).toBe(200);
    expect(repo.recentFor('foo', 0).map((s) => s.takenAt)).toEqual([100]);
  });
});

describe('StorageSampleRepo', () => {
  function ss(
    name: string,
    takenAt: number,
    suffix: string,
    sizeBytes: number,
    partial = false,
  ): StorageSample {
    return {
      instanceName: name,
      takenAt,
      bucketSuffix: suffix,
      sizeBytes,
      objectCount: 1,
      partial,
    };
  }

  test('insertMany is a no-op on empty input', () => {
    const repo = new StorageSampleRepo(db);
    expect(() => repo.insertMany([])).not.toThrow();
  });

  test('latestPerBucketFor returns one row per bucket — the most recent', () => {
    seedInstance('foo');
    const repo = new StorageSampleRepo(db);
    repo.insertMany([
      ss('foo', 100, 'files', 1000),
      ss('foo', 200, 'files', 2000),
      ss('foo', 100, 'modules', 500),
    ]);
    const out = repo.latestPerBucketFor('foo');
    const byBucket = new Map(out.map((r) => [r.bucketSuffix, r.sizeBytes]));
    expect(byBucket.get('files')).toBe(2000);
    expect(byBucket.get('modules')).toBe(500);
    expect(out).toHaveLength(2);
  });

  test('latestPerBucketFor on an unseen instance returns []', () => {
    const repo = new StorageSampleRepo(db);
    expect(repo.latestPerBucketFor('ghost')).toEqual([]);
  });

  test('partial flag round-trips through sqlite integer 0/1 storage', () => {
    seedInstance('foo');
    const repo = new StorageSampleRepo(db);
    repo.insertMany([ss('foo', 100, 'files', 1, true), ss('foo', 100, 'modules', 1, false)]);
    const out = repo.latestPerBucketFor('foo');
    const files = out.find((r) => r.bucketSuffix === 'files')!;
    const modules = out.find((r) => r.bucketSuffix === 'modules')!;
    expect(files.partial).toBe(true);
    expect(modules.partial).toBe(false);
  });

  test('recentFor returns rows at or after sinceMs ordered ascending', () => {
    seedInstance('foo');
    const repo = new StorageSampleRepo(db);
    repo.insertMany([
      ss('foo', 100, 'files', 1),
      ss('foo', 200, 'files', 2),
      ss('foo', 300, 'files', 3),
    ]);
    const out = repo.recentFor('foo', 200);
    expect(out.map((s) => s.takenAt)).toEqual([200, 300]);
  });

  test('pruneOlderThan removes rows older than the cutoff', () => {
    seedInstance('foo');
    const repo = new StorageSampleRepo(db);
    repo.insertMany([
      ss('foo', 100, 'files', 1),
      ss('foo', 200, 'files', 2),
      ss('foo', 300, 'files', 3),
    ]);
    repo.pruneOlderThan(200);
    const out = repo.recentFor('foo', 0);
    expect(out.map((s) => s.takenAt)).toEqual([200, 300]);
  });
});

describe('InstanceRepo.updateRestartConfig', () => {
  test('round-trips restart cron + enabled and applies partial updates', () => {
    const repo = new InstanceRepo(db, TEST_MASTER_KEY);
    repo.insert(fullInstance('foo'));

    // Fresh instance: both null (opt-in off).
    expect(repo.get('foo')?.restartCron).toBeNull();
    expect(repo.get('foo')?.restartEnabled).toBeNull();

    // Set both.
    repo.updateRestartConfig('foo', { cron: '0 4 * * *', enabled: true });
    expect(repo.get('foo')?.restartCron).toBe('0 4 * * *');
    expect(repo.get('foo')?.restartEnabled).toBe(true);

    // Partial: flip enabled only, cron untouched.
    repo.updateRestartConfig('foo', { enabled: false });
    expect(repo.get('foo')?.restartCron).toBe('0 4 * * *');
    expect(repo.get('foo')?.restartEnabled).toBe(false);

    // Clear cron back to the orchestrator default.
    repo.updateRestartConfig('foo', { cron: null });
    expect(repo.get('foo')?.restartCron).toBeNull();
    expect(repo.get('foo')?.restartEnabled).toBe(false);
  });

  test('does not touch the backup config', () => {
    const repo = new InstanceRepo(db, TEST_MASTER_KEY);
    repo.insert(fullInstance('bar'));
    repo.updateBackupConfig('bar', { cron: '0 3 * * *', enabled: true });
    repo.updateRestartConfig('bar', { cron: '0 4 * * *', enabled: true });
    const inst = repo.get('bar');
    expect(inst?.backupCron).toBe('0 3 * * *');
    expect(inst?.backupEnabled).toBe(true);
    expect(inst?.restartCron).toBe('0 4 * * *');
    expect(inst?.restartEnabled).toBe(true);
  });
});
