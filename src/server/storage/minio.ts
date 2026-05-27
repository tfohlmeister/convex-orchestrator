import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export const BUCKET_SUFFIXES = [
  'exports',
  'snapshot-imports',
  'modules',
  'files',
  'search',
  'backups',
] as const;

// Buckets sampled by the storage sampler. `backups` is owned by the
// orchestrator, not the Convex backend, and is excluded from the sampler so
// backup zips don't inflate the per-instance "storage" chart.
export const SAMPLED_BUCKET_SUFFIXES = BUCKET_SUFFIXES.filter((s) => s !== 'backups');

export interface BackupListEntry {
  key: string;
  sizeBytes: number;
  lastModified: number;
}

export interface MinioConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean;
}

export class MinioStorage {
  private client: S3Client;

  constructor(private readonly cfg: MinioConfig) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: cfg.forcePathStyle ?? true,
    });
  }

  // Tear down the underlying http connections on graceful shutdown.
  // Without this, keep-alive sockets to MinIO are only closed when the
  // process exits — inconsistent with the rest of the structured close
  // sequence (server, postgres, sqlite).
  close(): void {
    this.client.destroy();
  }

  bucketPrefix(instanceName: string): string {
    return instanceName;
  }

  bucketNames(prefix: string): string[] {
    return BUCKET_SUFFIXES.map((s) => `${prefix}-${s}`);
  }

  async createBucketsForInstance(prefix: string): Promise<void> {
    for (const name of this.bucketNames(prefix)) {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: name }));
      } catch (err: unknown) {
        if (!isAlreadyExists(err)) throw err;
      }
    }
  }

  async deleteBucketsForInstance(prefix: string): Promise<void> {
    for (const name of this.bucketNames(prefix)) {
      try {
        await this.emptyBucket(name);
        await this.client.send(new DeleteBucketCommand({ Bucket: name }));
      } catch (err: unknown) {
        if (!isNotFound(err)) throw err;
      }
    }
  }

  async bucketsExist(prefix: string): Promise<boolean> {
    for (const name of this.bucketNames(prefix)) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: name }));
      } catch {
        return false;
      }
    }
    return true;
  }

  private async emptyBucket(name: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: name, ContinuationToken: continuationToken }),
      );
      const objects = list.Contents ?? [];
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: name,
            Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
          }),
        );
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  config(): MinioConfig {
    return this.cfg;
  }

  backupBucket(prefix: string): string {
    return `${prefix}-backups`;
  }

  async putBackup(
    prefix: string,
    key: string,
    body: Readable | Uint8Array | Buffer,
    contentLength?: number,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.backupBucket(prefix),
        Key: key,
        Body: body,
        ContentType: 'application/zip',
        ContentLength: contentLength,
      }),
    );
  }

  async headBackup(
    prefix: string,
    key: string,
  ): Promise<{ sizeBytes: number; lastModified: number } | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.backupBucket(prefix), Key: key }),
      );
      return {
        sizeBytes: r.ContentLength ?? 0,
        lastModified: r.LastModified ? r.LastModified.getTime() : 0,
      };
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getBackupStream(prefix: string, key: string): Promise<Readable> {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.backupBucket(prefix), Key: key }),
    );
    if (!r.Body) {
      throw new Error(`backup ${key} has empty body`);
    }
    return r.Body as Readable;
  }

  async deleteBackup(prefix: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.backupBucket(prefix), Key: key }),
    );
  }

  async listBackups(prefix: string): Promise<BackupListEntry[]> {
    const bucket = this.backupBucket(prefix);
    const out: BackupListEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: obj.Key,
          sizeBytes: obj.Size ?? 0,
          lastModified: obj.LastModified ? obj.LastModified.getTime() : 0,
        });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }

  // Walk all objects in a single bucket and sum their Size + count. Stops
  // after `pageLimit` pages of `MaxKeys` (default 1000) — the caller marks
  // the resulting sample `partial=true` if it hits the cap.
  async measureBucket(
    bucket: string,
    pageLimit: number,
  ): Promise<{ sizeBytes: number; objectCount: number; partial: boolean }> {
    let sizeBytes = 0;
    let objectCount = 0;
    let continuationToken: string | undefined;
    let pages = 0;
    while (pages < pageLimit) {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of res.Contents ?? []) {
        sizeBytes += obj.Size ?? 0;
        objectCount += 1;
      }
      pages += 1;
      if (!res.IsTruncated) {
        return { sizeBytes, objectCount, partial: false };
      }
      continuationToken = res.NextContinuationToken;
    }
    return { sizeBytes, objectCount, partial: true };
  }
}

function isAlreadyExists(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchBucket' || code === 404;
}
