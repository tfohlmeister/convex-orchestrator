import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export const BUCKET_SUFFIXES = [
  'exports',
  'snapshot-imports',
  'modules',
  'files',
  'search',
] as const;

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
