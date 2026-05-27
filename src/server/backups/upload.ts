import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import type { MinioStorage } from '../storage/minio.ts';

// Streams `filePath` once: simultaneously feeds it into a sha256 hash and
// into the S3 PutObject body. The file is never fully buffered in RAM.
// Returns the byte count + hex sha256 the caller stores in the `backups`
// row. Throws on either upload error or hash error.
export async function streamFileToBackup(
  minio: MinioStorage,
  prefix: string,
  key: string,
  filePath: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const st = await stat(filePath);
  const sizeBytes = st.size;
  const hash = createHash('sha256');
  const source = createReadStream(filePath);
  const uploadStream = new PassThrough();

  source.on('data', (chunk: Buffer | string) => {
    hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });

  const uploadPromise = minio.putBackup(prefix, key, uploadStream, sizeBytes);
  const pipePromise = pipeline(source, uploadStream);

  await Promise.all([uploadPromise, pipePromise]);
  return { sizeBytes, sha256: hash.digest('hex') };
}

// Hash a single file's bytes with sha256, used after a download to verify
// a backup zip's integrity against the row's stored hash.
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
