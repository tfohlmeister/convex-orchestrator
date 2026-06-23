import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Supervisor, type SupervisorDeps } from './supervisor.ts';
import type { SpawnHandle } from './spawn.ts';
import type { Instance, ResourceSample, SpawnConfig } from './types.ts';
import type { Logger } from '../logger.ts';

// -------------------------- harness --------------------------

function makeInstance(name = 'inst-a'): Instance {
  return {
    name,
    displayName: null,
    status: 'stopped',
    baseDomain: 'test.local',
    cloudPort: 13210,
    sitePort: 13211,
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
  };
}

interface FakeHandle extends SpawnHandle {
  exitNow: (code: number | null) => void;
  signals: NodeJS.Signals[];
}

function fakeSpawnHandle(pid = 9999): FakeHandle {
  const signals: NodeJS.Signals[] = [];
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const proc = {
    pid,
    exited,
    kill(sig: NodeJS.Signals) {
      signals.push(sig);
      // Most fake procs in tests should exit promptly on SIGTERM so
      // gracefulStop's await proc.exited completes. Tests that want to
      // exercise the SIGKILL escalation override this.
      resolveExit(0);
      return true;
    },
  };
  return {
    proc: proc as unknown as Bun.Subprocess,
    pid,
    // The supervisor only uses these in the spawnConvex closure; tests
    // don't exercise log rotation.
    stdoutLog: { close: () => Promise.resolve() } as never,
    stderrLog: { close: () => Promise.resolve() } as never,
    exitNow: resolveExit,
    signals,
  };
}

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

interface Harness {
  supervisor: Supervisor;
  spawnCalls: SpawnConfig[];
  handles: FakeHandle[];
  statusChanges: { name: string; status: string; lastError?: string }[];
  resourceSamples: ResourceSample[];
  killedPids: number[];
}

function setupHarness(opts?: { spawnFails?: boolean; descendants?: number[] }): Harness {
  const handles: FakeHandle[] = [];
  const spawnCalls: SpawnConfig[] = [];
  const statusChanges: Harness['statusChanges'] = [];
  const resourceSamples: ResourceSample[] = [];
  const killedPids: number[] = [];

  const spawnFn = async (cfg: SpawnConfig): Promise<SpawnHandle> => {
    spawnCalls.push(cfg);
    if (opts?.spawnFails) throw new Error('spawn failed');
    const h = fakeSpawnHandle(1000 + handles.length);
    handles.push(h);
    return h;
  };

  const deps: SupervisorDeps = {
    binaryPath: '/dev/null',
    logDir: '/tmp',
    logger: silentLogger(),
    databaseUrl: () => 'postgres://x@y',
    s3: { endpoint: 's3', accessKey: 'a', secretKey: 'b', region: 'us' },
    externalScheme: 'http',
    externalPortSuffix: '',
    bindAddress: '127.0.0.1',
    resourceSink: {
      insert: (s) => resourceSamples.push(s),
      pruneOlderThan: () => undefined,
    },
    onStatusChange: (name, status, lastError) => {
      statusChanges.push({ name, status, ...(lastError !== undefined ? { lastError } : {}) });
    },
    spawn: spawnFn,
    // Simulate the backend's executor subtree (e.g. the Node action runner)
    // so the reaping path is exercised without a real process tree.
    listDescendants: () => Promise.resolve(opts?.descendants ?? []),
    killProcess: (pid) => killedPids.push(pid),
  };

  return {
    supervisor: new Supervisor(deps),
    spawnCalls,
    handles,
    statusChanges,
    resourceSamples,
    killedPids,
  };
}

// Tiny scheduler-yield so any awaited microtasks (proc.exited.then(handleExit))
// run before the next assertion.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// -------------------------- tests --------------------------

let h: Harness;

beforeEach(() => {
  h = setupHarness();
});

afterEach(async () => {
  await h.supervisor.stopAllForShutdown();
});

describe('Supervisor.start', () => {
  test('spawns the process and emits onStatusChange("running")', async () => {
    await h.supervisor.start(makeInstance('a'));
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.instance.name).toBe('a');
    expect(h.statusChanges).toEqual([{ name: 'a', status: 'running' }]);
    expect(h.supervisor.isRunning('a')).toBe(true);
    expect(h.supervisor.pidOf('a')).toBe(1000);
  });

  test('start is a no-op when the instance is already tracked', async () => {
    const inst = makeInstance('a');
    await h.supervisor.start(inst);
    await h.supervisor.start(inst);
    expect(h.spawnCalls).toHaveLength(1);
  });
});

describe('Supervisor.stop', () => {
  test('SIGTERMs the running process, deletes the tracked entry, and emits stopped', async () => {
    await h.supervisor.start(makeInstance('a'));
    await h.supervisor.stop('a');
    expect(h.handles[0]!.signals).toEqual(['SIGTERM']);
    expect(h.supervisor.isRunning('a')).toBe(false);
    expect(h.statusChanges.at(-1)).toEqual({ name: 'a', status: 'stopped' });
  });

  test('stop on an unknown instance is a no-op', async () => {
    await h.supervisor.stop('never-started');
    expect(h.statusChanges).toEqual([]);
  });

  test('reaps the backend descendant processes (executor leak fix)', async () => {
    // The backend's Node executor does not exit with its parent; without
    // reaping it would leak its (multi-GB) heap on every stop/restart.
    const reaper = setupHarness({ descendants: [4242, 4243] });
    await reaper.supervisor.start(makeInstance('a'));
    await reaper.supervisor.stop('a');
    expect(reaper.killedPids).toEqual([4242, 4243]);
    await reaper.supervisor.stopAllForShutdown();
  });
});

describe('Supervisor.handleExit', () => {
  test('unexpected exit schedules a respawn that re-spawns and re-emits running', async () => {
    await h.supervisor.start(makeInstance('a'));
    // Process crashes (exit code 1, NOT via stop()).
    h.handles[0]!.exitNow(1);
    // Allow the proc.exited.then(handleExit) microtask to schedule the
    // setTimeout, then flush the timer (0 ms backoff for first attempt).
    await flush();
    // First respawn delay is RESTART_DELAYS_MS[0] = 1000ms; wait a hair
    // beyond it.
    await new Promise((r) => setTimeout(r, 1100));
    expect(h.spawnCalls.length).toBeGreaterThanOrEqual(2);
    expect(h.statusChanges.filter((s) => s.status === 'running').length).toBeGreaterThanOrEqual(2);
  });

  test('stop() during the respawn backoff cancels the pending respawn — the supervisor.stop race fix', async () => {
    await h.supervisor.start(makeInstance('a'));
    // Capture the first handle, then simulate a crash.
    const firstHandle = h.handles[0]!;
    firstHandle.exitNow(1);
    // Wait for the proc.exited.then(handleExit) microtask to run AND
    // schedule its setTimeout — but call stop BEFORE the timer fires.
    await flush();
    // At this point tracked is empty (handleExit deleted it) but a
    // setTimeout is pending. stop() must cancel it AND emit 'stopped'.
    const spawnsBefore = h.spawnCalls.length;
    await h.supervisor.stop('a');
    // Now wait longer than any possible backoff to make sure no respawn
    // sneaks in.
    await new Promise((r) => setTimeout(r, 100));
    expect(h.spawnCalls.length).toBe(spawnsBefore);
    expect(h.statusChanges.at(-1)).toEqual({ name: 'a', status: 'stopped' });
  });
});

describe('Supervisor.stopAllForShutdown', () => {
  test('SIGTERMs every running process and clears tracked', async () => {
    await h.supervisor.start(makeInstance('a'));
    await h.supervisor.start(makeInstance('b'));
    await h.supervisor.stopAllForShutdown();
    expect(h.handles[0]!.signals).toEqual(['SIGTERM']);
    expect(h.handles[1]!.signals).toEqual(['SIGTERM']);
    expect(h.supervisor.isRunning('a')).toBe(false);
    expect(h.supervisor.isRunning('b')).toBe(false);
  });

  test('also cancels any pending respawn timers so a crash during shutdown does not bounce back', async () => {
    await h.supervisor.start(makeInstance('a'));
    h.handles[0]!.exitNow(1);
    await flush();
    const spawnsBefore = h.spawnCalls.length;
    await h.supervisor.stopAllForShutdown();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.spawnCalls.length).toBe(spawnsBefore);
  });
});
