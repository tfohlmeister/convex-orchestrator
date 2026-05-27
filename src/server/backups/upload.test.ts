import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { hashFile, streamFileToBackup } from './upload.ts';
import type { MinioStorage } from '../storage/minio.ts';

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orch-upload-'));
  await mkdir(workDir, { recursive: true });
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('hashFile + streamFileToBackup', () => {
  test('hashFile matches a fresh sha256 of the bytes', async () => {
    const data = randomBytes(4096);
    const path = join(workDir, 'a.bin');
    await writeFile(path, data);
    const want = createHash('sha256').update(data).digest('hex');
    expect(await hashFile(path)).toBe(want);
  });

  test('streamFileToBackup forwards bytes and returns matching sha256+size', async () => {
    const data = randomBytes(8192);
    const path = join(workDir, 'b.bin');
    await writeFile(path, data);
    const want = createHash('sha256').update(data).digest('hex');

    let receivedBucket = '';
    let receivedKey = '';
    let receivedSize = 0;
    let receivedBytes = Buffer.alloc(0);
    const minio = {
      backupBucket: (prefix: string) => `${prefix}-backups`,
      putBackup: async (
        prefix: string,
        key: string,
        body: Readable,
        contentLength?: number,
      ): Promise<void> => {
        receivedBucket = `${prefix}-backups`;
        receivedKey = key;
        receivedSize = contentLength ?? 0;
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
          chunks.push(chunk as Buffer);
        }
        receivedBytes = Buffer.concat(chunks);
      },
    } as unknown as MinioStorage;

    const r = await streamFileToBackup(minio, 'inst-a', 'k.zip', path);
    expect(r.sizeBytes).toBe(8192);
    expect(r.sha256).toBe(want);
    expect(receivedBucket).toBe('inst-a-backups');
    expect(receivedKey).toBe('k.zip');
    expect(receivedSize).toBe(8192);
    // Bytes that went up the stream must be byte-identical to the input.
    expect(Buffer.compare(receivedBytes, data)).toBe(0);
  });
});
