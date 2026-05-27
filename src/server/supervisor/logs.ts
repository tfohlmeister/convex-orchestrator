import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';

const ROTATE_BYTES = 10 * 1024 * 1024;
const KEEP_GENERATIONS = 3;

export class RotatingLog {
  private stream: WriteStream | null = null;
  private bytesWritten = 0;
  private readyPromise: Promise<void>;
  // Sticky error from the underlying WriteStream. Without this an EIO
  // / ENOSPC on the stream would emit an uncaught 'error' event and
  // (depending on Bun/Node version) crash the orchestrator. We capture
  // it and surface it to the next write() call so the caller's
  // onPipeError fires and the log pipeline tears down cleanly.
  private streamError: Error | null = null;

  constructor(private readonly path: string) {
    this.readyPromise = this.init();
  }

  private attachStreamErrorHandler(s: WriteStream): void {
    s.on('error', (err: Error) => {
      this.streamError = err;
    });
  }

  private async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const s = await stat(this.path);
      this.bytesWritten = s.size;
    } catch {
      this.bytesWritten = 0;
    }
    this.stream = createWriteStream(this.path, { flags: 'a' });
    this.attachStreamErrorHandler(this.stream);
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async write(chunk: Buffer | string): Promise<void> {
    await this.ready();
    if (this.streamError) throw this.streamError;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (this.bytesWritten + buf.byteLength > ROTATE_BYTES) {
      await this.rotate();
    }
    this.stream!.write(buf);
    this.bytesWritten += buf.byteLength;
  }

  private async rotate(): Promise<void> {
    if (this.stream) {
      await new Promise<void>((resolve) => this.stream!.end(resolve));
      this.stream = null;
    }
    for (let i = KEEP_GENERATIONS; i >= 1; i--) {
      const src = i === 1 ? this.path : `${this.path}.${i - 1}`;
      const dst = `${this.path}.${i}`;
      try {
        await stat(src);
        if (i === KEEP_GENERATIONS) {
          try {
            await unlink(dst);
          } catch {
            /* not present */
          }
        }
        await rename(src, dst);
      } catch {
        /* source missing */
      }
    }
    this.stream = createWriteStream(this.path, { flags: 'a' });
    this.attachStreamErrorHandler(this.stream);
    this.bytesWritten = 0;
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    this.stream = null;
  }
}

export function logPaths(logDir: string, instanceName: string): { stdout: string; stderr: string } {
  return {
    stdout: join(logDir, instanceName, 'stdout.log'),
    stderr: join(logDir, instanceName, 'stderr.log'),
  };
}
