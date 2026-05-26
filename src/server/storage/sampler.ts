import type { Logger } from '../logger.ts';
import type { StorageSample, StorageSampleRepo } from '../db/repos.ts';
import type { Instance } from '../supervisor/types.ts';
import { BUCKET_SUFFIXES, type MinioStorage } from './minio.ts';

export const DEFAULT_STORAGE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_STORAGE_PAGE_LIMIT = 100;
export const STORAGE_RETENTION_MS = 24 * 60 * 60_000;

export interface StorageSamplerDeps {
  minio: MinioStorage;
  repo: StorageSampleRepo;
  logger: Logger;
  // Pulled lazily on each tick so the sampler reflects the current set of
  // running instances without needing a separate restart hook.
  getRunningInstances: () => Instance[];
  intervalMs?: number;
  pageLimit?: number;
}

export class StorageSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private currentTickStartedAt = 0;

  constructor(private readonly deps: StorageSamplerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? DEFAULT_STORAGE_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.inFlight) {
      this.deps.logger.info(
        { runningSinceMs: Date.now() - this.currentTickStartedAt },
        'storage sampler: skipping tick, previous tick still running',
      );
      return;
    }
    this.inFlight = true;
    this.currentTickStartedAt = Date.now();
    try {
      const instances = this.deps.getRunningInstances();
      const pageLimit = this.deps.pageLimit ?? DEFAULT_STORAGE_PAGE_LIMIT;
      const takenAt = Date.now();
      const samples: StorageSample[] = [];
      for (const instance of instances) {
        for (const suffix of BUCKET_SUFFIXES) {
          const bucket = `${instance.bucketPrefix}-${suffix}`;
          try {
            const m = await this.deps.minio.measureBucket(bucket, pageLimit);
            if (m.partial) {
              this.deps.logger.warn(
                { instance: instance.name, bucket, pageLimit },
                'storage sampler: ListObjectsV2 cap hit',
              );
            }
            samples.push({
              instanceName: instance.name,
              takenAt,
              bucketSuffix: suffix,
              sizeBytes: m.sizeBytes,
              objectCount: m.objectCount,
              partial: m.partial,
            });
          } catch (err: unknown) {
            this.deps.logger.error(
              {
                instance: instance.name,
                bucket,
                err: err instanceof Error ? err.message : String(err),
              },
              'storage sampler: bucket measure failed',
            );
          }
        }
      }
      this.deps.repo.insertMany(samples);
      this.deps.repo.pruneOlderThan(takenAt - STORAGE_RETENTION_MS);
    } finally {
      this.inFlight = false;
    }
  }
}
