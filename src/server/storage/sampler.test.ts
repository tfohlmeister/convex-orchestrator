import { describe, expect, test } from 'bun:test';
import { StorageSampler } from './sampler.ts';
import type { StorageSample, StorageSampleRepo } from '../db/repos.ts';
import type { Instance } from '../supervisor/types.ts';
import type { MinioStorage } from './minio.ts';
import type { Logger } from '../logger.ts';

function fakeInstance(name: string): Instance {
  return {
    name,
    displayName: null,
    status: 'running',
    baseDomain: 'test',
    cloudPort: 1,
    sitePort: 2,
    adminKey: 'k',
    instanceSecret: 's',
    postgresDatabase: 'p',
    bucketPrefix: name,
    createdAt: 0,
    updatedAt: 0,
    lastError: null,
    backupCron: null,
    backupRetentionDays: null,
    backupEnabled: null,
    backupSuspended: false,
    restartCron: null,
    restartEnabled: null,
  };
}

function fakeLogger(): Logger {
  const noop = (): void => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as Logger;
}

describe('StorageSampler', () => {
  test('writes one row per bucket-suffix per running instance', async () => {
    const inserted: StorageSample[] = [];
    const repo = {
      insertMany: (rows: StorageSample[]) => inserted.push(...rows),
      pruneOlderThan: () => undefined,
    } as unknown as StorageSampleRepo;

    const minio = {
      measureBucket: async () => ({ sizeBytes: 100, objectCount: 1, partial: false }),
    } as unknown as MinioStorage;

    const sampler = new StorageSampler({
      minio,
      repo,
      logger: fakeLogger(),
      getRunningInstances: () => [fakeInstance('a'), fakeInstance('b')],
    });
    await sampler.tick();

    // 2 instances × 5 buckets = 10 rows
    expect(inserted).toHaveLength(10);
    expect(inserted.every((r) => r.sizeBytes === 100)).toBe(true);
    const seen = new Set(inserted.map((r) => `${r.instanceName}:${r.bucketSuffix}`));
    expect(seen.size).toBe(10);
  });

  test('skips an overlapping tick while inFlight', async () => {
    let measureStarts = 0;
    const repo = {
      insertMany: () => undefined,
      pruneOlderThan: () => undefined,
    } as unknown as StorageSampleRepo;

    let resolveFirstMeasure: () => void = () => undefined;
    const firstMeasureGate = new Promise<void>((resolve) => {
      resolveFirstMeasure = resolve;
    });
    const minio = {
      measureBucket: async () => {
        measureStarts++;
        // First call blocks until we release it, so a second tick can race.
        if (measureStarts === 1) await firstMeasureGate;
        return { sizeBytes: 1, objectCount: 1, partial: false };
      },
    } as unknown as MinioStorage;

    const sampler = new StorageSampler({
      minio,
      repo,
      logger: fakeLogger(),
      getRunningInstances: () => [fakeInstance('a')],
    });
    const first = sampler.tick();
    // Kick off a second tick while the first is still mid-flight.
    const second = sampler.tick();
    await second;
    // Second one returned without doing work → still only 1 measureStart.
    expect(measureStarts).toBe(1);
    resolveFirstMeasure();
    await first;
    expect(measureStarts).toBe(5); // 1 instance × 5 buckets
  });

  test('partial flag propagates from measureBucket', async () => {
    const inserted: StorageSample[] = [];
    const repo = {
      insertMany: (rows: StorageSample[]) => inserted.push(...rows),
      pruneOlderThan: () => undefined,
    } as unknown as StorageSampleRepo;
    const minio = {
      measureBucket: async () => ({ sizeBytes: 7, objectCount: 3, partial: true }),
    } as unknown as MinioStorage;
    const sampler = new StorageSampler({
      minio,
      repo,
      logger: fakeLogger(),
      getRunningInstances: () => [fakeInstance('only')],
    });
    await sampler.tick();
    expect(inserted.every((r) => r.partial)).toBe(true);
  });
});
