import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingLog } from './logs.ts';

describe('RotatingLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orch-logs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writes to file', async () => {
    const log = new RotatingLog(join(dir, 'app.log'));
    await log.write('hello\n');
    await log.close();
    const s = await stat(join(dir, 'app.log'));
    expect(s.size).toBe(6);
  });

  test('rotates at 10 MB boundary keeping .1/.2/.3', async () => {
    const log = new RotatingLog(join(dir, 'app.log'));
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    for (let i = 0; i < 35; i++) {
      await log.write(chunk);
    }
    await log.close();
    const files = (await readdir(dir)).sort();
    expect(files).toContain('app.log');
    expect(files).toContain('app.log.1');
    expect(files).toContain('app.log.2');
    expect(files).toContain('app.log.3');
    expect(files).not.toContain('app.log.4');
  });
});
