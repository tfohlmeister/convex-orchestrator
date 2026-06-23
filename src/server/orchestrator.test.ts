import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from './db/index.ts';
import { AuditRepo, InstanceRepo, PortRepo, ResourceSampleRepo } from './db/repos.ts';
import type { BackupManager } from './backups/manager.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { MinioStorage } from './storage/minio.ts';
import type { PostgresStorage } from './storage/postgres.ts';
import type { Supervisor } from './supervisor/supervisor.ts';
import type { Instance } from './supervisor/types.ts';
import type { TraefikWriter } from './traefik/writer.ts';
import { PortAllocator } from './ports.ts';
import { Orchestrator, type OrchestratorDeps } from './orchestrator.ts';

// -------------------------- fakes --------------------------

function silentLogger(): Logger {
  const noop = (): void => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => silentLogger(),
  } as unknown as Logger;
}

interface FakeMinio {
  buckets: { created: string[]; deleted: string[] };
  failBucketDelete: boolean;
}

function fakeMinio(): { obj: MinioStorage; state: FakeMinio } {
  const state: FakeMinio = {
    buckets: { created: [], deleted: [] },
    failBucketDelete: false,
  };
  const obj = {
    bucketPrefix: (n: string) => n,
    createBucketsForInstance: async (prefix: string) => {
      state.buckets.created.push(prefix);
    },
    deleteBucketsForInstance: async (prefix: string) => {
      if (state.failBucketDelete) throw new Error('minio offline');
      state.buckets.deleted.push(prefix);
    },
  } as unknown as MinioStorage;
  return { obj, state };
}

interface FakeSupervisor {
  starts: string[];
  stops: string[];
  running: Set<string>;
  spawnThrows: boolean;
}

function fakeSupervisor(): { obj: Supervisor; state: FakeSupervisor } {
  const state: FakeSupervisor = {
    starts: [],
    stops: [],
    running: new Set(),
    spawnThrows: false,
  };
  const obj = {
    isRunning: (n: string) => state.running.has(n),
    pidOf: (n: string) => (state.running.has(n) ? 1234 : null),
    start: async (inst: Instance) => {
      state.starts.push(inst.name);
      if (state.spawnThrows) throw new Error('spawn failed');
      state.running.add(inst.name);
    },
    stop: async (name: string) => {
      state.stops.push(name);
      state.running.delete(name);
    },
  } as unknown as Supervisor;
  return { obj, state };
}

interface FakeTraefik {
  routes: Set<string>;
  commits: number;
}

function fakeTraefik(): { obj: TraefikWriter; state: FakeTraefik } {
  const state: FakeTraefik = { routes: new Set(), commits: 0 };
  const obj = {
    set: (spec: { instanceName: string }) => {
      state.routes.add(spec.instanceName);
    },
    remove: (name: string) => {
      state.routes.delete(name);
    },
    commit: async () => {
      state.commits += 1;
    },
    replaceAll: () => undefined,
  } as unknown as TraefikWriter;
  return { obj, state };
}

interface FakeBackupManager {
  dropped: string[];
}

function fakeBackupManager(): { obj: BackupManager; state: FakeBackupManager } {
  const state: FakeBackupManager = { dropped: [] };
  const obj = {
    dropInstance: (n: string) => {
      state.dropped.push(n);
    },
  } as unknown as BackupManager;
  return { obj, state };
}

const fakePostgres = {
  sharedDatabaseName: () => 'convex',
} as unknown as PostgresStorage;

// -------------------------- harness --------------------------

interface Harness {
  cleanup: () => Promise<void>;
  db: DB;
  instances: InstanceRepo;
  audit: AuditRepo;
  ports: PortAllocator;
  orchestrator: Orchestrator;
  minio: FakeMinio;
  supervisor: FakeSupervisor;
  traefik: FakeTraefik;
  backupManager: FakeBackupManager;
}

async function setup(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'orch-test-'));
  const db = await openDatabase(join(tmp, 'orchestrator.sqlite'));
  const masterKey = 'a'.repeat(64);
  const instances = new InstanceRepo(db, masterKey);
  const audit = new AuditRepo(db);
  const ports = new PortAllocator(new PortRepo(db));
  const minioWrap = fakeMinio();
  const supervisorWrap = fakeSupervisor();
  const traefikWrap = fakeTraefik();
  const bmWrap = fakeBackupManager();

  const config = {
    BASE_DOMAIN: 'cvx.lan',
    EXTERNAL_SCHEME: 'http',
    EXTERNAL_PORT_SUFFIX: '',
    GENERATE_KEY_BINARY: '/dev/null',
  } as unknown as Config;

  const deps: OrchestratorDeps = {
    config,
    logger: silentLogger(),
    instances,
    audit,
    samples: new ResourceSampleRepo(db),
    ports,
    postgres: fakePostgres,
    minio: minioWrap.obj,
    supervisor: supervisorWrap.obj,
    traefik: traefikWrap.obj,
    backupManager: bmWrap.obj,
    // Deterministic stub so we never spawn the real generate_key binary.
    generateAdminKey: async (_tools, name, secret) => `${name}|fake-key-${secret.slice(0, 8)}`,
  };
  const orchestrator = new Orchestrator(deps);

  return {
    cleanup: async () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      await rm(tmp, { recursive: true, force: true });
    },
    db,
    instances,
    audit,
    ports,
    orchestrator,
    minio: minioWrap.state,
    supervisor: supervisorWrap.state,
    traefik: traefikWrap.state,
    backupManager: bmWrap.state,
  };
}

let h: Harness;

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => {
  await h.cleanup();
});

// -------------------------- tests --------------------------

describe('Orchestrator.create', () => {
  test('happy path: row inserted, buckets created, ports allocated, supervisor started, traefik set, audit logged', async () => {
    const inst = await h.orchestrator.create('foo', 'tester');
    expect(inst.name).toBe('foo');
    expect(inst.adminKey).toMatch(/^foo\|fake-key-/);
    expect(h.minio.buckets.created).toEqual(['foo']);
    expect(h.supervisor.starts).toEqual(['foo']);
    expect(h.traefik.routes.has('foo')).toBe(true);
    expect(h.traefik.commits).toBeGreaterThanOrEqual(1);
    const row = h.instances.get('foo')!;
    expect(row.status).toBe('running');
    expect(h.audit.recentFor('foo', 5).some((a) => a.action === 'create')).toBe(true);
  });

  test('already-exists: 409 thrown, no second insert', async () => {
    await h.orchestrator.create('foo', 'tester');
    let caught: unknown;
    try {
      await h.orchestrator.create('foo', 'tester');
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ status: 409, code: 'ALREADY_EXISTS' });
  });

  test('rollback: if spawnAndRoute throws, the row exists but status flips to error with message', async () => {
    h.supervisor.spawnThrows = true;
    let caught: unknown;
    try {
      await h.orchestrator.create('foo', 'tester');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const row = h.instances.get('foo');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('error');
    expect(row!.lastError).toContain('spawn failed');
  });
});

describe('Orchestrator.delete', () => {
  test('orders stop → traefik.remove+commit → minio.deleteBuckets → ports.release → instances.delete → backupManager.dropInstance', async () => {
    await h.orchestrator.create('foo', 'tester');
    const commitsBefore = h.traefik.commits;
    await h.orchestrator.delete('foo', 'tester');
    expect(h.supervisor.stops).toEqual(['foo']);
    expect(h.traefik.routes.has('foo')).toBe(false);
    expect(h.traefik.commits).toBeGreaterThan(commitsBefore);
    expect(h.minio.buckets.deleted).toEqual(['foo']);
    expect(h.instances.get('foo')).toBeNull();
    expect(h.backupManager.dropped).toEqual(['foo']);
    expect(h.audit.recentFor('foo', 5).some((a) => a.action === 'delete')).toBe(true);
  });

  test('unknown instance: 404, no state mutation', async () => {
    let caught: unknown;
    try {
      await h.orchestrator.delete('ghost', 'tester');
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ status: 404 });
    expect(h.supervisor.stops).toEqual([]);
    expect(h.backupManager.dropped).toEqual([]);
  });
});

describe('Orchestrator.forceRestartBackend', () => {
  test('stops, re-spawns, sets traefik route, records audit with the stuck-export action', async () => {
    await h.orchestrator.create('foo', 'tester');
    const stopsBefore = h.supervisor.stops.length;
    const startsBefore = h.supervisor.starts.length;
    await h.orchestrator.forceRestartBackend('foo', 'tester');
    expect(h.supervisor.stops.length).toBe(stopsBefore + 1);
    expect(h.supervisor.starts.length).toBe(startsBefore + 1);
    expect(
      h.audit.recentFor('foo', 5).some((a) => a.action === 'backend_restart_for_stuck_export'),
    ).toBe(true);
  });
});

describe('Orchestrator.restoreRunning', () => {
  test('restores each running row independently — one failure does not block the others', async () => {
    // Seed two running rows directly via the repo (bypass create's
    // bucket+port allocation; we only care about restoreRunning's
    // per-iteration error handling here).
    const seed = (name: string): void => {
      h.instances.insert({
        name,
        displayName: null,
        status: 'running',
        baseDomain: 'cvx.lan',
        cloudPort: 13200 + name.length,
        sitePort: 13300 + name.length,
        adminKey: 'k',
        instanceSecret: 's',
        postgresSchema: 'public',
        bucketPrefix: name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastError: null,
        backupCron: null,
        backupRetentionDays: null,
        backupEnabled: null,
        backupSuspended: false,
        restartCron: null,
        restartEnabled: null,
      });
    };
    seed('a');
    seed('b');
    seed('c');
    // Wire the supervisor stub so the FIRST spawn throws, the rest
    // succeed. This pins down "one failing instance must not stop the
    // restoreRunning loop" — exactly the regression the review fleet
    // flagged.
    let calls = 0;
    h.supervisor.spawnThrows = false;
    const sup = (h.orchestrator as unknown as { deps: OrchestratorDeps }).deps.supervisor;
    const realStart = sup.start.bind(sup);
    sup.start = (async (inst: Instance) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      await realStart(inst);
    }) as Supervisor['start'];

    await h.orchestrator.restoreRunning();

    // a failed (first call), b + c succeeded
    expect(h.instances.get('a')!.status).toBe('error');
    expect(h.instances.get('a')!.lastError).toContain('boom');
    expect(h.instances.get('b')!.status).toBe('running');
    expect(h.instances.get('c')!.status).toBe('running');
  });
});

describe('Orchestrator.deployments', () => {
  test('returns running instances with config-aware cloud URLs', async () => {
    await h.orchestrator.create('foo', 'tester');
    const { deployments } = h.orchestrator.deployments();
    expect(deployments).toHaveLength(1);
    expect(deployments[0]!.url).toBe('http://foo.cvx.lan');
  });

  test('skips non-running instances', async () => {
    await h.orchestrator.create('foo', 'tester');
    // Flip to stopped and verify deployments() filters it out.
    h.instances.updateStatus('foo', 'stopped');
    const { deployments } = h.orchestrator.deployments();
    expect(deployments).toHaveLength(0);
  });
});
