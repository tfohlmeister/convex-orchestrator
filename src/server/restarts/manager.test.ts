import { describe, expect, test } from 'bun:test';
import { RestartManager, type RestartManagerDeps } from './manager.ts';
import type { Instance } from '../supervisor/types.ts';
import type { Logger } from '../logger.ts';

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

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    name: 'inst-a',
    displayName: null,
    status: 'running',
    baseDomain: 'test.local',
    cloudPort: 13210,
    sitePort: 13211,
    adminKey: 'k',
    instanceSecret: 's',
    postgresDatabase: 'public',
    bucketPrefix: 'inst-a',
    createdAt: 0,
    updatedAt: 0,
    lastError: null,
    backupCron: null,
    backupRetentionDays: null,
    backupEnabled: null,
    backupSuspended: false,
    restartCron: null,
    restartEnabled: null,
    ...overrides,
  };
}

interface Harness {
  manager: RestartManager;
  restarts: string[];
}

function setup(instances: Instance[], opts?: { enabled?: boolean; defaultCron?: string }): Harness {
  const restarts: string[] = [];
  const deps: RestartManagerDeps = {
    logger: silentLogger(),
    enabled: opts?.enabled ?? true,
    defaultCron: opts?.defaultCron ?? '0 4 * * *',
    listInstances: () => instances,
    restartBackend: (name) => {
      restarts.push(name);
      return Promise.resolve();
    },
  };
  return { manager: new RestartManager(deps), restarts };
}

// 2026-06-23T04:00:00 local time, expressed in epoch-ms via Date so the test
// matches the manager's local-time cron interpretation regardless of TZ.
const at = (h: number, m: number): number => new Date(2026, 5, 23, h, m, 0, 0).getTime();

describe('RestartManager.tick', () => {
  test('fires the restart when the cron minute is due', async () => {
    const h = setup([instance({ restartEnabled: true, restartCron: '0 4 * * *' })]);
    // First tick at 03:59 arms nextFire (04:00) without firing.
    await h.manager.tick(at(3, 59));
    expect(h.restarts).toEqual([]);
    // Tick at 04:00 is due.
    await h.manager.tick(at(4, 0));
    expect(h.restarts).toEqual(['inst-a']);
  });

  test('does not fire when restartEnabled is false/null', async () => {
    const h = setup([
      instance({ name: 'off', restartEnabled: null, restartCron: '0 4 * * *' }),
      instance({ name: 'disabled', restartEnabled: false, restartCron: '0 4 * * *' }),
    ]);
    await h.manager.tick(at(3, 59));
    await h.manager.tick(at(4, 0));
    expect(h.restarts).toEqual([]);
  });

  test('skips instances that are not running', async () => {
    const h = setup([
      instance({ status: 'stopped', restartEnabled: true, restartCron: '0 4 * * *' }),
    ]);
    await h.manager.tick(at(3, 59));
    await h.manager.tick(at(4, 0));
    expect(h.restarts).toEqual([]);
  });

  test('falls back to the default cron when restartCron is null', async () => {
    const h = setup([instance({ restartEnabled: true, restartCron: null })], {
      defaultCron: '30 2 * * *',
    });
    await h.manager.tick(at(2, 29));
    expect(h.restarts).toEqual([]);
    await h.manager.tick(at(2, 30));
    expect(h.restarts).toEqual(['inst-a']);
  });

  test('does not fire twice within the same due minute', async () => {
    const h = setup([instance({ restartEnabled: true, restartCron: '0 4 * * *' })]);
    await h.manager.tick(at(3, 59));
    await h.manager.tick(at(4, 0));
    await h.manager.tick(at(4, 0));
    expect(h.restarts).toEqual(['inst-a']);
  });

  test('skips an invalid cron without throwing', async () => {
    const h = setup([instance({ restartEnabled: true, restartCron: 'not a cron' })]);
    await h.manager.tick(at(4, 0));
    expect(h.restarts).toEqual([]);
  });

  test('dropInstance clears scheduler state', async () => {
    const inst = instance({ restartEnabled: true, restartCron: '0 4 * * *' });
    const h = setup([inst]);
    await h.manager.tick(at(3, 59));
    h.manager.dropInstance('inst-a');
    // After drop, the next due tick re-arms from scratch and still fires.
    await h.manager.tick(at(4, 0));
    expect(h.restarts).toEqual(['inst-a']);
  });
});
