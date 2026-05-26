import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraefikWriter } from './writer.ts';

describe('TraefikWriter', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orch-traefik-'));
    path = join(dir, 'orchestrator.yml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('renders router+service for two instances deterministically', async () => {
    const writer = new TraefikWriter({
      outputPath: path,
      certResolver: 'le',
      entryPoint: 'websecure',
      serviceLoopback: '127.0.0.1',
    });
    writer.set({
      instanceName: 'beta',
      cloudHost: 'beta.cvx.local',
      siteHost: 'beta-site.cvx.local',
      cloudPort: 13210,
      sitePort: 13211,
    });
    writer.set({
      instanceName: 'alpha',
      cloudHost: 'alpha.cvx.local',
      siteHost: 'alpha-site.cvx.local',
      cloudPort: 13212,
      sitePort: 13213,
    });
    const first = writer.render();
    expect(first).not.toBeNull();
    expect(first).toContain('alpha-cloud');
    expect(first).toContain('beta-cloud');
    expect(first!.indexOf('alpha-cloud')).toBeLessThan(first!.indexOf('beta-cloud'));
    expect(first).toContain('certResolver: le');
    expect(first).toContain('http://127.0.0.1:13210');
  });

  test('commit writes the file atomically', async () => {
    const writer = new TraefikWriter({
      outputPath: path,
      certResolver: 'le',
      entryPoint: 'websecure',
      serviceLoopback: '127.0.0.1',
    });
    writer.set({
      instanceName: 'foo',
      cloudHost: 'foo.cvx.local',
      siteHost: 'foo-site.cvx.local',
      cloudPort: 13210,
      sitePort: 13211,
    });
    await writer.commit();
    const content = await readFile(path, 'utf8');
    expect(content).toContain('foo-cloud');
  });

  test('serializes concurrent commits without partial writes', async () => {
    const writer = new TraefikWriter({
      outputPath: path,
      certResolver: 'le',
      entryPoint: 'websecure',
      serviceLoopback: '127.0.0.1',
    });
    for (let i = 0; i < 10; i++) {
      writer.set({
        instanceName: `i${i}`,
        cloudHost: `i${i}.cvx.local`,
        siteHost: `i${i}-site.cvx.local`,
        cloudPort: 13210 + i * 2,
        sitePort: 13211 + i * 2,
      });
    }
    await Promise.all(Array.from({ length: 5 }, () => writer.commit()));
    const content = await readFile(path, 'utf8');
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`i${i}-cloud`);
    }
  });

  test('remove drops an instance from output', async () => {
    const writer = new TraefikWriter({
      outputPath: path,
      certResolver: 'le',
      entryPoint: 'websecure',
      serviceLoopback: '127.0.0.1',
    });
    writer.set({
      instanceName: 'foo',
      cloudHost: 'foo.cvx.local',
      siteHost: 'foo-site.cvx.local',
      cloudPort: 13210,
      sitePort: 13211,
    });
    writer.set({
      instanceName: 'bar',
      cloudHost: 'bar.cvx.local',
      siteHost: 'bar-site.cvx.local',
      cloudPort: 13212,
      sitePort: 13213,
    });
    writer.remove('foo');
    const out = writer.render();
    expect(out).not.toBeNull();
    expect(out).not.toContain('foo-cloud');
    expect(out).toContain('bar-cloud');
  });

  test('returns null and unlinks output file when no routes are registered', async () => {
    const writer = new TraefikWriter({
      outputPath: path,
      certResolver: 'le',
      entryPoint: 'websecure',
      serviceLoopback: '127.0.0.1',
    });
    writer.set({
      instanceName: 'foo',
      cloudHost: 'foo.cvx.local',
      siteHost: 'foo-site.cvx.local',
      cloudPort: 13210,
      sitePort: 13211,
    });
    await writer.commit();
    expect(await readFile(path, 'utf8')).toContain('foo-cloud');

    writer.remove('foo');
    expect(writer.render()).toBeNull();
    await writer.commit();
    let existed = true;
    try {
      await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') existed = false;
      else throw err;
    }
    expect(existed).toBe(false);
  });
});
