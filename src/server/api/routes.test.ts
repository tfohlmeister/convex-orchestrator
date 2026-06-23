import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildRoutes, collectInstanceHealth, deriveCpuCores, type RouteDeps } from './routes.ts';
import type { ResourceSample } from '../supervisor/types.ts';
import type { Config } from '../config.ts';

function s(takenAt: number, cpuTicks: number, rssKb = 1000, fdCount = 10): ResourceSample {
  return { instanceName: 'x', takenAt, cpuTicks, rssKb, fdCount };
}

describe('deriveCpuCores', () => {
  const CLK = 100;

  test('first row gets null', () => {
    const out = deriveCpuCores([s(0, 0)], CLK);
    expect(out[0]!.cpuCores).toBeNull();
  });

  test('monotonic ticks yield positive cpuCores', () => {
    // 1000 ticks across 10 seconds at 100 Hz = 1.0 cores
    const out = deriveCpuCores([s(0, 0), s(10_000, 1000)], CLK);
    expect(out[1]!.cpuCores).toBeCloseTo(1.0, 5);
  });

  test('partial-core usage', () => {
    // 30 ticks across 1 second at 100 Hz = 0.3 cores
    const out = deriveCpuCores([s(0, 0), s(1_000, 30)], CLK);
    expect(out[1]!.cpuCores).toBeCloseTo(0.3, 5);
  });

  test('counter reset yields null', () => {
    // Second sample's cpuTicks lower than first → backend restarted
    const out = deriveCpuCores([s(0, 500), s(30_000, 100)], CLK);
    expect(out[1]!.cpuCores).toBeNull();
  });

  test('single-sample series → all null', () => {
    const out = deriveCpuCores([s(0, 0)], CLK);
    expect(out.every((p) => p.cpuCores === null)).toBe(true);
  });

  test('three-sample series produces two computed cores values', () => {
    const out = deriveCpuCores([s(0, 0), s(30_000, 300), s(60_000, 600)], CLK);
    expect(out[0]!.cpuCores).toBeNull();
    expect(out[1]!.cpuCores).toBeCloseTo(0.1, 5);
    expect(out[2]!.cpuCores).toBeCloseTo(0.1, 5);
  });

  test('zero elapsed time → null (avoid div-by-zero)', () => {
    const out = deriveCpuCores([s(0, 0), s(0, 100)], CLK);
    expect(out[1]!.cpuCores).toBeNull();
  });
});

describe('auth gating', () => {
  // Minimal deps stub — auth gating happens before any route handler
  // touches these, so the never-called methods are safe as throwers.
  const stubOrchestrator = {
    deployments: () => [],
  } as unknown as RouteDeps['orchestrator'];
  const stubRepo = {
    listForInstance: () => [],
    latestForInstance: () => null,
    latestStorageForInstance: () => null,
    listAudit: () => [],
  };

  function buildApp(token: string) {
    const config = {
      ORCHESTRATOR_ADMIN_TOKEN: token,
      EXTERNAL_SCHEME: 'http',
      EXTERNAL_PORT_SUFFIX: '',
      BASE_DOMAIN: 'cvx.lan',
    } as unknown as Config;
    return buildRoutes({
      orchestrator: stubOrchestrator,
      config,
      samples: stubRepo as unknown as RouteDeps['samples'],
      storage: stubRepo as unknown as RouteDeps['storage'],
      audit: stubRepo as unknown as RouteDeps['audit'],
      backups: stubRepo as unknown as RouteDeps['backups'],
      backupManager: {} as unknown as RouteDeps['backupManager'],
      restoreManager: {} as unknown as RouteDeps['restoreManager'],
      minio: {} as unknown as RouteDeps['minio'],
      ready: () => true,
    });
  }

  test('with empty token: /api/auth/mode returns none and /api/deployments is open', async () => {
    const app = buildApp('');
    const mode = await app.request('/api/auth/mode');
    expect(mode.status).toBe(200);
    expect(await mode.json()).toEqual({ mode: 'none' });

    const open = await app.request('/api/deployments');
    expect(open.status).toBe(200);
  });

  test('with token set: /api/auth/mode returns bearer and /api/deployments rejects unauth', async () => {
    const app = buildApp('a-very-secret-token-of-sufficient-length');
    const mode = await app.request('/api/auth/mode');
    expect(await mode.json()).toEqual({ mode: 'bearer' });

    const denied = await app.request('/api/deployments');
    expect(denied.status).toBe(401);

    const allowed = await app.request('/api/deployments', {
      headers: { authorization: 'Bearer a-very-secret-token-of-sufficient-length' },
    });
    expect(allowed.status).toBe(200);
  });
});

describe('health endpoints', () => {
  type FakeInstance = {
    name: string;
    status: 'creating' | 'running' | 'stopped' | 'error';
    cloudPort: number;
  };

  function buildHealthDeps(instances: FakeInstance[], ready = true): RouteDeps {
    const config = {
      ORCHESTRATOR_ADMIN_TOKEN: '',
      EXTERNAL_SCHEME: 'http',
      EXTERNAL_PORT_SUFFIX: '',
      BASE_DOMAIN: 'cvx.lan',
      CONVEX_BIND_ADDRESS: '127.0.0.1',
    } as unknown as Config;
    return {
      orchestrator: { list: () => instances } as unknown as RouteDeps['orchestrator'],
      config,
      samples: {} as unknown as RouteDeps['samples'],
      storage: {} as unknown as RouteDeps['storage'],
      audit: {} as unknown as RouteDeps['audit'],
      backups: {} as unknown as RouteDeps['backups'],
      backupManager: {} as unknown as RouteDeps['backupManager'],
      restoreManager: {} as unknown as RouteDeps['restoreManager'],
      minio: {} as unknown as RouteDeps['minio'],
      ready: () => ready,
    };
  }

  // Mock fetch to control reachability without spinning up real backends.
  const realFetch = globalThis.fetch;
  let reachableHosts = new Set<number>();

  beforeEach(() => {
    reachableHosts = new Set();
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const match = u.match(/:(\d+)\//);
      const port = match ? Number(match[1]) : -1;
      if (reachableHosts.has(port)) return new Response('{"version":"x"}', { status: 200 });
      throw new Error('refused');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('GET /health always returns 200', async () => {
    const app = buildRoutes(buildHealthDeps([]));
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('GET /ready returns 200 when ready, 503 otherwise', async () => {
    const app1 = buildRoutes(buildHealthDeps([], true));
    expect((await app1.request('/ready')).status).toBe(200);

    const app2 = buildRoutes(buildHealthDeps([], false));
    expect((await app2.request('/ready')).status).toBe(503);
  });

  test('empty fleet is healthy', async () => {
    const out = await collectInstanceHealth(buildHealthDeps([]));
    expect(out.ok).toBe(true);
    expect(out.summary.total).toBe(0);
    expect(out.instances).toEqual([]);
  });

  test('running + reachable counts as healthy', async () => {
    reachableHosts.add(13210);
    const out = await collectInstanceHealth(
      buildHealthDeps([{ name: 'a', status: 'running', cloudPort: 13210 }]),
    );
    expect(out.ok).toBe(true);
    expect(out.summary.running).toBe(1);
    expect(out.summary.unhealthy).toBe(0);
    expect(out.instances[0]!.backendReachable).toBe(true);
  });

  test('running + unreachable flips ok=false and bumps unhealthy', async () => {
    const out = await collectInstanceHealth(
      buildHealthDeps([{ name: 'a', status: 'running', cloudPort: 13210 }]),
    );
    expect(out.ok).toBe(false);
    expect(out.summary.unhealthy).toBe(1);
    expect(out.instances[0]!.backendReachable).toBe(false);
  });

  test('error status flips ok=false even without probe', async () => {
    const out = await collectInstanceHealth(
      buildHealthDeps([{ name: 'a', status: 'error', cloudPort: 13210 }]),
    );
    expect(out.ok).toBe(false);
    expect(out.summary.error).toBe(1);
    expect(out.instances[0]!.backendReachable).toBeNull();
  });

  test('stopped and creating do not flip ok', async () => {
    const out = await collectInstanceHealth(
      buildHealthDeps([
        { name: 'a', status: 'stopped', cloudPort: 13210 },
        { name: 'b', status: 'creating', cloudPort: 13212 },
      ]),
    );
    expect(out.ok).toBe(true);
    expect(out.summary.stopped).toBe(1);
    expect(out.summary.creating).toBe(1);
    expect(out.instances[0]!.backendReachable).toBeNull();
    expect(out.instances[1]!.backendReachable).toBeNull();
  });

  test('mixed fleet: running+OK, stopped, creating yields ok=true', async () => {
    reachableHosts.add(13210);
    const out = await collectInstanceHealth(
      buildHealthDeps([
        { name: 'a', status: 'running', cloudPort: 13210 },
        { name: 'b', status: 'stopped', cloudPort: 13212 },
        { name: 'c', status: 'creating', cloudPort: 13214 },
      ]),
    );
    expect(out.ok).toBe(true);
    expect(out.summary).toEqual({
      total: 3,
      running: 1,
      unhealthy: 0,
      stopped: 1,
      error: 0,
      creating: 1,
    });
  });

  test('GET /health/instances returns 503 when any running instance is unreachable', async () => {
    const app = buildRoutes(buildHealthDeps([{ name: 'a', status: 'running', cloudPort: 13210 }]));
    const res = await app.request('/health/instances');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test('GET /health/instances returns 200 when all running instances reachable', async () => {
    reachableHosts.add(13210);
    const app = buildRoutes(buildHealthDeps([{ name: 'a', status: 'running', cloudPort: 13210 }]));
    const res = await app.request('/health/instances');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// Security guards for the mutating endpoints: confirmName mismatch on
// restore/delete, cross-tenant guards on backup-by-id, and the
// MAX_RESTORE_UPLOAD_BYTES early reject. None of these were covered
// previously and the cross-tenant guards in particular are the kind of
// regression that lets one instance touch another's backups.
describe('mutating endpoint guards', () => {
  function buildAppWithStubs(overrides?: {
    backups?: Partial<RouteDeps['backups']>;
    orchestrator?: Partial<RouteDeps['orchestrator']>;
    restoreManager?: Partial<RouteDeps['restoreManager']>;
    maxRestoreUploadBytes?: number;
  }) {
    const orchestrator = {
      get: (name: string) =>
        ({
          name,
          baseDomain: 'cvx.lan',
          cloudPort: 13210,
          sitePort: 13211,
          adminKey: 'k',
        }) as never,
      ...(overrides?.orchestrator ?? {}),
    } as unknown as RouteDeps['orchestrator'];
    const backups = {
      get: () => null,
      ...(overrides?.backups ?? {}),
    } as unknown as RouteDeps['backups'];
    const restoreManager = {
      startRestoreFromBackup: () => 'job-id',
      ...(overrides?.restoreManager ?? {}),
    } as unknown as RouteDeps['restoreManager'];
    const config = {
      ORCHESTRATOR_ADMIN_TOKEN: '',
      EXTERNAL_SCHEME: 'http',
      EXTERNAL_PORT_SUFFIX: '',
      BASE_DOMAIN: 'cvx.lan',
      MAX_RESTORE_UPLOAD_BYTES: overrides?.maxRestoreUploadBytes ?? 16 * 1024 * 1024 * 1024,
      BACKUP_WORK_DIR: '/tmp',
    } as unknown as Config;
    return buildRoutes({
      orchestrator,
      config,
      samples: {} as unknown as RouteDeps['samples'],
      storage: {} as unknown as RouteDeps['storage'],
      audit: { record: () => undefined } as unknown as RouteDeps['audit'],
      backups,
      backupManager: {} as unknown as RouteDeps['backupManager'],
      restoreManager,
      minio: {} as unknown as RouteDeps['minio'],
      ready: () => true,
    });
  }

  test('POST /api/instances/:name/restore rejects when confirmName does not match', async () => {
    const app = buildAppWithStubs();
    const res = await app.request('/api/instances/foo/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupId: 'abc', confirmName: 'bar' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CONFIRMATION_MISMATCH');
  });

  test('DELETE /api/instances/:name rejects when confirmName does not match', async () => {
    const app = buildAppWithStubs();
    const res = await app.request('/api/instances/foo', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'bar' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CONFIRMATION_MISMATCH');
  });

  test('DELETE /api/instances/:name/backups/:id blocks cross-instance access (returns 404 to avoid info leak)', async () => {
    // backups.get returns a row whose instanceName !== the path param. The
    // route folds "not yours" into the same 404 NOT_FOUND as "never
    // existed" — that's the right behaviour (don't reveal cross-tenant
    // backup IDs by status-code timing); the test pins it down.
    const app = buildAppWithStubs({
      backups: {
        get: () =>
          ({
            id: 'bk-1',
            instanceName: 'other-tenant',
            status: 'complete',
          }) as never,
      },
    });
    const res = await app.request('/api/instances/foo/backups/bk-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  test('POST /api/instances/:name/restore-from-upload rejects Content-Length above the cap', async () => {
    const app = buildAppWithStubs({ maxRestoreUploadBytes: 1024 });
    const res = await app.request('/api/instances/foo/restore-from-upload', {
      method: 'POST',
      headers: {
        'x-confirm-name': 'foo',
        'content-length': '99999999',
        'content-type': 'application/zip',
      },
      body: 'X',
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UPLOAD_TOO_LARGE');
  });

  test('POST /api/instances/:name/restore-from-upload requires x-confirm-name', async () => {
    const app = buildAppWithStubs();
    const res = await app.request('/api/instances/foo/restore-from-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: 'X',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CONFIRMATION_MISMATCH');
  });
});

describe('display name routes', () => {
  function buildApp(overrides?: {
    onCreate?: (name: string, actor: string, displayName: string | null) => Promise<unknown>;
    onSetDisplayName?: (name: string, displayName: string | null, actor: string) => void;
  }) {
    const orchestrator = {
      create:
        overrides?.onCreate ?? (async () => ({ name: 'x', displayName: null, status: 'creating' })),
      setDisplayName: overrides?.onSetDisplayName ?? (() => undefined),
    } as unknown as RouteDeps['orchestrator'];
    const config = {
      ORCHESTRATOR_ADMIN_TOKEN: '',
      EXTERNAL_SCHEME: 'http',
      EXTERNAL_PORT_SUFFIX: '',
      BASE_DOMAIN: 'cvx.lan',
    } as unknown as Config;
    return buildRoutes({
      orchestrator,
      config,
      samples: {} as unknown as RouteDeps['samples'],
      storage: {} as unknown as RouteDeps['storage'],
      audit: { record: () => undefined } as unknown as RouteDeps['audit'],
      backups: {} as unknown as RouteDeps['backups'],
      backupManager: {} as unknown as RouteDeps['backupManager'],
      restoreManager: {} as unknown as RouteDeps['restoreManager'],
      minio: {} as unknown as RouteDeps['minio'],
      ready: () => true,
    });
  }

  test('POST /api/instances accepts displayName', async () => {
    const calls: Array<{ name: string; displayName: string | null }> = [];
    const app = buildApp({
      onCreate: async (name, _actor, displayName) => {
        calls.push({ name, displayName });
        return { name, displayName, status: 'creating' };
      },
    });
    const res = await app.request('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lucky-otter-123', displayName: 'My App' }),
    });
    expect(res.status).toBe(201);
    expect(calls).toEqual([{ name: 'lucky-otter-123', displayName: 'My App' }]);
  });

  test('POST /api/instances without displayName persists null', async () => {
    const calls: Array<{ displayName: string | null }> = [];
    const app = buildApp({
      onCreate: async (name, _actor, displayName) => {
        calls.push({ displayName });
        return { name, displayName, status: 'creating' };
      },
    });
    const res = await app.request('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lucky-otter-123' }),
    });
    expect(res.status).toBe(201);
    expect(calls).toEqual([{ displayName: null }]);
  });

  test('POST /api/instances normalises empty/whitespace displayName to null', async () => {
    const calls: Array<{ displayName: string | null }> = [];
    const app = buildApp({
      onCreate: async (name, _actor, displayName) => {
        calls.push({ displayName });
        return { name, displayName, status: 'creating' };
      },
    });
    await app.request('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lucky-otter-123', displayName: '   ' }),
    });
    expect(calls[0]?.displayName).toBeNull();
  });

  test('PATCH /api/instances/:name/display-name passes through trimmed value', async () => {
    const calls: Array<{ displayName: string | null }> = [];
    const app = buildApp({
      onSetDisplayName: (_name, displayName) => {
        calls.push({ displayName });
      },
    });
    const res = await app.request('/api/instances/lucky-otter-123/display-name', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '  My App  ' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ displayName: 'My App' }]);
  });

  test('PATCH /api/instances/:name/display-name with empty string clears to null', async () => {
    const calls: Array<{ displayName: string | null }> = [];
    const app = buildApp({
      onSetDisplayName: (_name, displayName) => {
        calls.push({ displayName });
      },
    });
    const res = await app.request('/api/instances/lucky-otter-123/display-name', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ displayName: null }]);
  });

  test('PATCH rejects displayName over 64 chars', async () => {
    const app = buildApp();
    const res = await app.request('/api/instances/lucky-otter-123/display-name', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'a'.repeat(65) }),
    });
    expect(res.status).toBe(400);
  });
});

describe('restart-config route', () => {
  // Mutable per-instance state the stub orchestrator reads/writes so the
  // route's "update then return refreshed" flow can be asserted end-to-end.
  function buildApp() {
    const state: { restartCron: string | null; restartEnabled: boolean | null } = {
      restartCron: null,
      restartEnabled: null,
    };
    const calls: Array<{ cron?: string | null; enabled?: boolean | null }> = [];
    const orchestrator = {
      get: (name: string) => ({ name, ...state }),
      updateRestartConfig: (
        _name: string,
        cfg: { cron?: string | null; enabled?: boolean | null },
      ) => {
        calls.push(cfg);
        if (cfg.cron !== undefined) state.restartCron = cfg.cron;
        if (cfg.enabled !== undefined) state.restartEnabled = cfg.enabled;
      },
    } as unknown as RouteDeps['orchestrator'];
    const config = {
      ORCHESTRATOR_ADMIN_TOKEN: '',
      EXTERNAL_SCHEME: 'http',
      EXTERNAL_PORT_SUFFIX: '',
      BASE_DOMAIN: 'cvx.lan',
    } as unknown as Config;
    const app = buildRoutes({
      orchestrator,
      config,
      samples: {} as unknown as RouteDeps['samples'],
      storage: {} as unknown as RouteDeps['storage'],
      audit: { record: () => undefined } as unknown as RouteDeps['audit'],
      backups: {} as unknown as RouteDeps['backups'],
      backupManager: {} as unknown as RouteDeps['backupManager'],
      restoreManager: {} as unknown as RouteDeps['restoreManager'],
      minio: {} as unknown as RouteDeps['minio'],
      ready: () => true,
    });
    return { app, calls };
  }

  function put(app: ReturnType<typeof buildApp>['app'], body: unknown) {
    return app.request('/api/instances/lucky-otter-123/restart-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('valid cron + enabled round-trips and returns the refreshed config', async () => {
    const { app, calls } = buildApp();
    const res = await put(app, { cron: '0 4 * * *', enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restartCron: '0 4 * * *', restartEnabled: true });
    expect(calls).toEqual([{ cron: '0 4 * * *', enabled: true }]);
  });

  test('enabled-only update leaves cron untouched', async () => {
    const { app, calls } = buildApp();
    const res = await put(app, { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restartCron: null, restartEnabled: true });
    expect(calls).toEqual([{ enabled: true }]);
  });

  test('null cron clears the override', async () => {
    const { app, calls } = buildApp();
    const res = await put(app, { cron: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restartCron: null, restartEnabled: null });
    expect(calls).toEqual([{ cron: null }]);
  });

  test('invalid cron is rejected with 400 INVALID_CRON before any write', async () => {
    const { app, calls } = buildApp();
    const res = await put(app, { cron: 'not a cron', enabled: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_CRON');
    expect(calls).toEqual([]);
  });

  test('unknown field is rejected by the strict schema', async () => {
    const { app } = buildApp();
    const res = await put(app, { retentionDays: 5 });
    expect(res.status).toBe(400);
  });
});

describe('backup-config route cron validation', () => {
  // The backup-config route shares assertValidCron with restart-config; this
  // pins its 400-on-invalid-cron path (it previously fell through to a 500).
  function buildApp() {
    const calls: Array<Record<string, unknown>> = [];
    const orchestrator = {
      get: (name: string) => ({
        name,
        backupCron: null,
        backupRetentionDays: null,
        backupEnabled: null,
        backupSuspended: false,
      }),
      updateBackupConfig: (_name: string, cfg: Record<string, unknown>) => calls.push(cfg),
    } as unknown as RouteDeps['orchestrator'];
    const config = {
      ORCHESTRATOR_ADMIN_TOKEN: '',
      EXTERNAL_SCHEME: 'http',
      EXTERNAL_PORT_SUFFIX: '',
      BASE_DOMAIN: 'cvx.lan',
    } as unknown as Config;
    const app = buildRoutes({
      orchestrator,
      config,
      samples: {} as unknown as RouteDeps['samples'],
      storage: {} as unknown as RouteDeps['storage'],
      audit: { record: () => undefined } as unknown as RouteDeps['audit'],
      backups: {} as unknown as RouteDeps['backups'],
      backupManager: {} as unknown as RouteDeps['backupManager'],
      restoreManager: {} as unknown as RouteDeps['restoreManager'],
      minio: {} as unknown as RouteDeps['minio'],
      ready: () => true,
    });
    return { app, calls };
  }

  function put(app: ReturnType<typeof buildApp>['app'], body: unknown) {
    return app.request('/api/instances/lucky-otter-123/backup-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('invalid cron is rejected with 400 INVALID_CRON before any write', async () => {
    const { app, calls } = buildApp();
    const res = await put(app, { cron: 'not a cron' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_CRON');
    expect(calls).toEqual([]);
  });

  test('valid cron is accepted', async () => {
    const { app, calls } = buildApp();
    const res = await put(app, { cron: '0 3 * * *', enabled: true });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ cron: '0 3 * * *', enabled: true, suspended: false }]);
  });
});
