import { describe, expect, test } from 'bun:test';
import { buildRoutes, deriveCpuCores, type RouteDeps } from './routes.ts';
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
