import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { Orchestrator } from '../orchestrator.ts';
import type { Config } from '../config.ts';
import type { AuditRepo, BackupRepo, ResourceSampleRepo, StorageSampleRepo } from '../db/repos.ts';
import type { ResourceSample } from '../supervisor/types.ts';
import type { BackupManager } from '../backups/manager.ts';
import type { RestoreManager } from '../backups/restore.ts';
import type { MinioStorage } from '../storage/minio.ts';
import { getClkTck } from '../system.ts';
import { OrchestratorError, errorResponse } from './errors.ts';
import { cloudUrl, siteUrl } from '../urls.ts';
import {
  BackupConfigSchema,
  CreateInstanceSchema,
  DeleteConfirmSchema,
  InstanceNameSchema,
  LogsQuerySchema,
  RestartConfigSchema,
  RestoreSchema,
  SetDisplayNameSchema,
} from './schemas.ts';

export interface SampleWithCpu {
  takenAt: number;
  rssKb: number;
  fdCount: number;
  cpuCores: number | null;
}

// Maps a sorted-by-takenAt sample series to a same-length series enriched
// with `cpuCores`, the delta of `cpu_ticks` between consecutive rows
// divided by elapsed wall-clock seconds and CLK_TCK. The first row and any
// pair where `Δticks < 0` (backend restart reset the counter) get null,
// rendered as a gap by the UI chart.
export function deriveCpuCores(samples: ResourceSample[], clkTck: number): SampleWithCpu[] {
  const out: SampleWithCpu[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    let cpuCores: number | null = null;
    if (i > 0) {
      const prev = samples[i - 1]!;
      const dTicks = s.cpuTicks - prev.cpuTicks;
      const dSeconds = (s.takenAt - prev.takenAt) / 1000;
      if (dTicks >= 0 && dSeconds > 0) {
        cpuCores = dTicks / (dSeconds * clkTck);
      }
    }
    out.push({
      takenAt: s.takenAt,
      rssKb: s.rssKb,
      fdCount: s.fdCount,
      cpuCores,
    });
  }
  return out;
}

export interface RouteDeps {
  orchestrator: Orchestrator;
  config: Config;
  samples: ResourceSampleRepo;
  storage: StorageSampleRepo;
  audit: AuditRepo;
  backups: BackupRepo;
  backupManager: BackupManager;
  restoreManager: RestoreManager;
  minio: MinioStorage;
  ready: () => boolean;
}

export function buildRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const authEnabled = deps.config.ORCHESTRATOR_ADMIN_TOKEN.length > 0;
  const requireBearer = authEnabled
    ? bearerAuth(deps.config.ORCHESTRATOR_ADMIN_TOKEN)
    : passthrough;
  // Audit-log actor identification. When bearer auth is on the only caller
  // is "admin" (whoever holds the token), so we ignore x-forwarded-user to
  // close the audit-log spoof vector. When the API is open we trust the
  // upstream's forwarded-auth header — that is the only identity signal
  // available.
  const actorOf = authEnabled ? () => 'admin' : actorOfFromHeader;

  // Liveness probe — the orchestrator process is up and serving HTTP.
  // Used by docker healthcheck and by anything that wants the cheapest
  // possible "is this thing alive?" answer. Always 200 if we can respond.
  app.get('/health', (c) => c.json({ ok: true }));

  // Readiness probe — the boot sequence (migrations, traefik write,
  // restoreRunning) finished. 503 until then so a reverse proxy or
  // orchestrator deployment system can wait before routing traffic.
  app.get('/ready', (c) =>
    deps.ready() ? c.json({ ready: true }) : c.json({ ready: false }, 503),
  );

  // Fleet health aggregator — summarises every supervised backend. 200
  // when every instance that should be running is reachable on its
  // internal cloud port; 503 if any `running` instance fails the ping
  // or any instance sits in `error`. Operator-stopped instances
  // (`stopped`) and in-flight ones (`creating`) are not faults.
  // Used by Gatus / external monitoring; no auth because no sensitive
  // data is returned (instance names are already public DNS).
  app.get('/health/instances', async (c) => {
    const detail = await collectInstanceHealth(deps);
    const status = detail.ok ? 200 : 503;
    return c.json(detail, status);
  });
  // Unauthenticated probe so the UI can decide whether to prompt for a
  // token. Returns the active mode only, never the token itself.
  app.get('/api/auth/mode', (c) => c.json({ mode: authEnabled ? 'bearer' : 'none' }));

  app.get('/api/deployments', requireBearer, (c) => c.json(deps.orchestrator.deployments()));

  const clkTck = getClkTck();

  app.get('/api/instances', requireBearer, (c) => {
    const list = deps.orchestrator.list();
    const enriched = list.map((i) => {
      const pair = deps.samples.latestPair(i.name);
      const latestCpuCores = pair.length === 2 ? deriveCpuCores(pair, clkTck)[1]!.cpuCores : null;
      const buckets = deps.storage.latestPerBucketFor(i.name);
      const latestStorageBytes =
        buckets.length > 0 ? buckets.reduce((acc, b) => acc + b.sizeBytes, 0) : null;
      const latestBackup = deps.backups.latestFor(i.name);
      const latestComplete = deps.backups.latestCompleteFor(i.name);
      const recent = deps.backups.recentFor(i.name, 10);
      const hasStuckBackup = recent.some((b) => b.status === 'stuck');
      return {
        name: i.name,
        displayName: i.displayName,
        status: i.status,
        baseDomain: i.baseDomain,
        cloudHost: `${i.name}.${i.baseDomain}`,
        siteHost: `${i.name}-site.${i.baseDomain}`,
        cloudUrl: cloudUrl(i, deps.config),
        siteUrl: siteUrl(i, deps.config),
        cloudPort: i.cloudPort,
        sitePort: i.sitePort,
        adminKey: i.adminKey,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        lastError: i.lastError ?? null,
        latestSample: deps.samples.latestFor(i.name),
        latestCpuCores,
        latestStorageBytes,
        latestBackupAt: latestComplete?.startedAt ?? null,
        latestBackupStatus: latestBackup?.status ?? null,
        hasStuckBackup,
      };
    });
    return c.json({ instances: enriched });
  });

  // Lightweight sparkline endpoint for the list view. The list page used
  // to call /api/instances/:name per row every 10s — a full detail fetch
  // (24h samples + storage + audit + backups) just to render two
  // sparklines. With N instances that was N detail-payloads/min and
  // chronic sqlite contention. This trims the payload to ~50 KB of pure
  // {takenAt, rssKb, fdCount} points for the requested window.
  app.get('/api/instances/:name/sparkline', requireBearer, (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      deps.orchestrator.get(name);
      const hours = Math.max(1, Math.min(24, Number(c.req.query('hours') ?? '6')));
      const since = Date.now() - hours * 60 * 60_000;
      const rows = deps.samples.recentFor(name, since);
      const points = rows.map((r) => ({
        takenAt: r.takenAt,
        rssKb: r.rssKb,
        fdCount: r.fdCount,
      }));
      return c.json({ points });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/instances/:name', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const inst = deps.orchestrator.get(name);
      const since = Date.now() - 24 * 60 * 60_000;
      const rawSamples = deps.samples.recentFor(name, since);
      const samples = deriveCpuCores(rawSamples, clkTck);
      const storageSamples = deps.storage.recentFor(name, since);
      const pair = deps.samples.latestPair(name);
      const latestCpuCores = pair.length === 2 ? deriveCpuCores(pair, clkTck)[1]!.cpuCores : null;
      const buckets = deps.storage.latestPerBucketFor(name);
      const latestStorageBytes =
        buckets.length > 0 ? buckets.reduce((acc, b) => acc + b.sizeBytes, 0) : null;
      const audit = deps.audit.recentFor(name, 50);
      const latestBackup = deps.backups.latestFor(name);
      const latestComplete = deps.backups.latestCompleteFor(name);
      const recent = deps.backups.recentFor(name, 10);
      const hasStuckBackup = recent.some((b) => b.status === 'stuck');
      return c.json({
        instance: {
          name: inst.name,
          displayName: inst.displayName,
          status: inst.status,
          baseDomain: inst.baseDomain,
          cloudHost: `${inst.name}.${inst.baseDomain}`,
          siteHost: `${inst.name}-site.${inst.baseDomain}`,
          cloudPort: inst.cloudPort,
          sitePort: inst.sitePort,
          adminKey: inst.adminKey,
          cloudUrl: cloudUrl(inst, deps.config),
          siteUrl: siteUrl(inst, deps.config),
          createdAt: inst.createdAt,
          updatedAt: inst.updatedAt,
          lastError: inst.lastError ?? null,
          latestCpuCores,
          latestStorageBytes,
          latestBackupAt: latestComplete?.startedAt ?? null,
          latestBackupStatus: latestBackup?.status ?? null,
          hasStuckBackup,
          backupCron: inst.backupCron,
          backupRetentionDays: inst.backupRetentionDays,
          backupEnabled: inst.backupEnabled,
          backupSuspended: inst.backupSuspended,
          restartCron: inst.restartCron,
          restartEnabled: inst.restartEnabled,
        },
        samples,
        storageSamples,
        audit,
      });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances', requireBearer, async (c) => {
    try {
      const body = CreateInstanceSchema.parse(await c.req.json());
      // Empty string in the form means "no separate label set"; persist
      // null so the list view falls back to the slug.
      const displayName = body.displayName?.trim() ? body.displayName.trim() : null;
      const inst = await deps.orchestrator.create(body.name, actorOf(c), displayName);
      return c.json(
        { instance: { name: inst.name, displayName: inst.displayName, status: inst.status } },
        201,
      );
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.patch('/api/instances/:name/display-name', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const body = SetDisplayNameSchema.parse(await c.req.json());
      const displayName = body.displayName.trim() ? body.displayName.trim() : null;
      deps.orchestrator.setDisplayName(name, displayName, actorOf(c));
      return c.json({ ok: true, displayName });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances/:name/start', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      await deps.orchestrator.start(name, actorOf(c));
      return c.json({ ok: true });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances/:name/stop', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      await deps.orchestrator.stop(name, actorOf(c));
      return c.json({ ok: true });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.delete('/api/instances/:name', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const body = DeleteConfirmSchema.parse(await c.req.json());
      if (body.confirmName !== name) {
        throw new OrchestratorError(
          400,
          'CONFIRMATION_MISMATCH',
          'confirmName must equal the instance name',
        );
      }
      await deps.orchestrator.delete(name, actorOf(c));
      return c.json({ ok: true });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/instances/:name/backups', requireBearer, (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      deps.orchestrator.get(name);
      const list = deps.backups.recentFor(name, 200);
      return c.json({ backups: list });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances/:name/backup', requireBearer, (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const inst = deps.orchestrator.get(name);
      const id = deps.backupManager.enqueueManual(inst, actorOf(c));
      return c.json({ ok: true, backupId: id }, 202);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.delete('/api/instances/:name/backups/:id', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const id = c.req.param('id');
      const inst = deps.orchestrator.get(name);
      const b = deps.backups.get(id ?? '');
      if (!b || b.instanceName !== name) {
        throw new OrchestratorError(404, 'NOT_FOUND', `backup ${id} not found`);
      }
      if (b.targetKey) {
        await deps.minio.deleteBackup(inst.bucketPrefix, b.targetKey);
      }
      deps.backups.delete(b.id);
      deps.audit.record({
        at: Date.now(),
        actor: actorOf(c),
        action: 'backup_deleted_manual',
        instanceName: name,
        details: `id=${b.id} source=${b.source}`,
      });
      return c.json({ ok: true });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/instances/:name/backups/:id/download', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const id = c.req.param('id') ?? '';
      const inst = deps.orchestrator.get(name);
      const b = deps.backups.get(id);
      if (!b || b.instanceName !== name || !b.targetKey || b.status !== 'complete') {
        throw new OrchestratorError(404, 'NOT_FOUND', `backup ${id} not downloadable`);
      }
      const s = await deps.minio.getBackupStream(inst.bucketPrefix, b.targetKey);
      const isoStamp = new Date(b.startedAt).toISOString().replace(/[:.]/g, '-');
      const filename = `${name}_${isoStamp}.zip`;
      c.header('content-type', 'application/zip');
      c.header('content-disposition', `attachment; filename="${filename}"`);
      if (b.sizeBytes != null) c.header('content-length', String(b.sizeBytes));
      return stream(c, async (out) => {
        const web = Readable.toWeb(s) as ReadableStream<Uint8Array>;
        const reader = web.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) await out.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances/:name/restore', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const body = RestoreSchema.parse(await c.req.json());
      if (body.confirmName !== name) {
        throw new OrchestratorError(
          400,
          'CONFIRMATION_MISMATCH',
          'confirmName must equal the instance name',
        );
      }
      const id = deps.restoreManager.startRestoreFromBackup(name, body.backupId, actorOf(c));
      return c.json({ jobId: id }, 202);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances/:name/restore-from-upload', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      deps.orchestrator.get(name);
      const confirm = c.req.header('x-confirm-name');
      if (confirm !== name) {
        throw new OrchestratorError(
          400,
          'CONFIRMATION_MISMATCH',
          'x-confirm-name header must equal the instance name',
        );
      }
      const body = c.req.raw.body;
      if (!body) throw new OrchestratorError(400, 'EMPTY_BODY', 'no request body');
      const cap = deps.config.MAX_RESTORE_UPLOAD_BYTES;
      // Up-front Content-Length check rejects obviously-too-big uploads
      // without writing a byte to disk. Clients without Content-Length
      // (chunked transfer) fall through to the streaming counter below.
      const declared = Number(c.req.header('content-length') ?? '');
      if (Number.isFinite(declared) && declared > cap) {
        throw new OrchestratorError(
          413,
          'UPLOAD_TOO_LARGE',
          `upload exceeds MAX_RESTORE_UPLOAD_BYTES (${cap} B)`,
        );
      }
      await mkdir(deps.config.BACKUP_WORK_DIR, { recursive: true });
      const tmpPath = join(deps.config.BACKUP_WORK_DIR, `upload_${randomUUID()}.zip`);
      const tmpStream = createWriteStream(tmpPath);
      const counter = byteCountingTransform(cap);
      try {
        // Readable.fromWeb, not the web stream directly: bun's pipeline()
        // falls back to async iteration on a raw web stream and dies with
        // "undefined is not a function" (bun 1.3.14, verified against the
        // real upload route).
        await pipeline(
          Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>),
          counter,
          tmpStream,
        );
        const jobId = await deps.restoreManager.startRestoreFromUpload(name, tmpPath, actorOf(c));
        return c.json({ jobId }, 202);
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        if (err instanceof Error && err.message === '__UPLOAD_TOO_LARGE__') {
          throw new OrchestratorError(
            413,
            'UPLOAD_TOO_LARGE',
            `upload exceeds MAX_RESTORE_UPLOAD_BYTES (${cap} B)`,
          );
        }
        throw err;
      }
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/instances/:name/restore-jobs/:id', requireBearer, (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const id = c.req.param('id') ?? '';
      deps.orchestrator.get(name);
      const job = deps.restoreManager.getJob(id);
      if (!job || job.instanceName !== name) {
        throw new OrchestratorError(404, 'NOT_FOUND', `restore job ${id} not found`);
      }
      return c.json({ job });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.put('/api/instances/:name/backup-config', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      const inst = deps.orchestrator.get(name);
      const body = BackupConfigSchema.parse(await c.req.json());
      // Validate cron if present (manager also re-validates but failing the
      // 400 early gives the UI a clearer error).
      if (typeof body.cron === 'string') await assertValidCron(body.cron);
      void inst;
      const update: {
        cron?: string | null;
        retentionDays?: number | null;
        enabled?: boolean | null;
        suspended?: boolean;
      } = {};
      if (body.cron !== undefined) update.cron = body.cron;
      if (body.retentionDays !== undefined) update.retentionDays = body.retentionDays;
      if (body.enabled !== undefined) update.enabled = body.enabled;
      // Enabling clears any suspension.
      if (body.enabled === true) update.suspended = false;
      deps.orchestrator.updateBackupConfig(name, update);
      deps.audit.record({
        at: Date.now(),
        actor: actorOf(c),
        action: 'backup_config_updated',
        instanceName: name,
        details: JSON.stringify(update),
      });
      const refreshed = deps.orchestrator.get(name);
      return c.json({
        backupCron: refreshed.backupCron,
        backupRetentionDays: refreshed.backupRetentionDays,
        backupEnabled: refreshed.backupEnabled,
        backupSuspended: refreshed.backupSuspended,
      });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.put('/api/instances/:name/restart-config', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      deps.orchestrator.get(name);
      const body = RestartConfigSchema.parse(await c.req.json());
      // Validate cron early for a clear 400 (the scheduler also re-validates
      // on its next tick).
      if (typeof body.cron === 'string') await assertValidCron(body.cron);
      const update: { cron?: string | null; enabled?: boolean | null } = {};
      if (body.cron !== undefined) update.cron = body.cron;
      if (body.enabled !== undefined) update.enabled = body.enabled;
      deps.orchestrator.updateRestartConfig(name, update);
      deps.audit.record({
        at: Date.now(),
        actor: actorOf(c),
        action: 'restart_config_updated',
        instanceName: name,
        details: JSON.stringify(update),
      });
      const refreshed = deps.orchestrator.get(name);
      return c.json({
        restartCron: refreshed.restartCron,
        restartEnabled: refreshed.restartEnabled,
      });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/instances/:name/force-restart-backend', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      await deps.orchestrator.forceRestartBackend(name, actorOf(c));
      return c.json({ ok: true });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/instances/:name/logs', requireBearer, async (c) => {
    try {
      const name = InstanceNameSchema.parse(c.req.param('name'));
      deps.orchestrator.get(name);
      const { stream: which, tail } = LogsQuerySchema.parse({
        stream: c.req.query('stream'),
        tail: c.req.query('tail'),
      });
      const file = join(deps.config.LOG_DIR, name, `${which}.log`);
      const followFlag = c.req.query('follow');
      if (followFlag === '1' || followFlag === 'true') {
        return streamLog(c, file);
      }
      const text = await readTail(file, tail);
      return c.text(text);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  });

  return app;
}

function actorOfFromHeader(c: Context): string {
  return c.req.header('x-forwarded-user') ?? 'admin';
}

// Reject an invalid cron with a 400 (parseCron throws a plain Error, which
// would otherwise fall through to a 500). Shared by the backup-config and
// restart-config routes.
async function assertValidCron(raw: string): Promise<void> {
  const { parseCron } = await import('../scheduling/cron.ts');
  try {
    parseCron(raw);
  } catch (err: unknown) {
    throw new OrchestratorError(
      400,
      'INVALID_CRON',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface InstanceHealth {
  name: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  backendReachable: boolean | null;
}

export interface FleetHealth {
  ok: boolean;
  summary: {
    total: number;
    running: number;
    unhealthy: number;
    stopped: number;
    error: number;
    creating: number;
  };
  instances: InstanceHealth[];
}

// Internal cloud-port reachability probe. 0.0.0.0 binding (docker
// network) is reached on 127.0.0.1 from inside the orchestrator
// container. 2s timeout — Convex /version is sub-ms when healthy.
async function probeBackend(host: string, port: number): Promise<boolean> {
  const target = host === '0.0.0.0' ? '127.0.0.1' : host;
  try {
    const res = await fetch(`http://${target}:${port}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function collectInstanceHealth(deps: RouteDeps): Promise<FleetHealth> {
  const bindAddress = deps.config.CONVEX_BIND_ADDRESS;
  const list = deps.orchestrator.list();

  const instances: InstanceHealth[] = await Promise.all(
    list.map(async (i) => {
      const status = i.status as InstanceHealth['status'];
      const backendReachable =
        status === 'running' ? await probeBackend(bindAddress, i.cloudPort) : null;
      return { name: i.name, status, backendReachable };
    }),
  );

  const summary = {
    total: instances.length,
    running: 0,
    unhealthy: 0,
    stopped: 0,
    error: 0,
    creating: 0,
  };
  for (const i of instances) {
    if (i.status === 'running') summary.running += 1;
    else if (i.status === 'stopped') summary.stopped += 1;
    else if (i.status === 'error') summary.error += 1;
    else if (i.status === 'creating') summary.creating += 1;
    if (i.status === 'running' && i.backendReachable === false) summary.unhealthy += 1;
  }

  // Healthy: no running-but-unreachable instances AND no `error` rows.
  // Operator-stopped and in-flight (`creating`) instances do not flip the
  // overall status to false.
  const ok = summary.unhealthy === 0 && summary.error === 0;
  return { ok, summary, instances };
}

function bearerAuth(token: string) {
  // Compute the expected header once. timingSafeEqual prevents byte-by-byte
  // timing oracles on the comparison; the length-check guard avoids
  // throwing on mismatched-size Buffers (which timingSafeEqual requires).
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const headerStr = c.req.header('authorization') ?? '';
    const got = Buffer.from(headerStr, 'utf8');
    const ok = got.length === expected.length && timingSafeEqual(got, expected);
    if (!ok) {
      return c.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    await next();
  };
}

async function passthrough(_c: Context, next: () => Promise<void>): Promise<void> {
  await next();
}

function byteCountingTransform(cap: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > cap) {
        // pipeline() unwinds and the route's catch surfaces this as 413.
        cb(new Error('__UPLOAD_TOO_LARGE__'));
        return;
      }
      cb(null, chunk);
    },
  });
}

async function readTail(file: string, tailLines: number): Promise<string> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return '';
  }
  const chunkSize = Math.min(size, 64 * 1024);
  if (chunkSize === 0) return '';
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(chunkSize);
    await fh.read(buf, 0, chunkSize, size - chunkSize);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // When the read started mid-file the first split element is almost
    // certainly a partial line. Drop it so the UI never renders a
    // truncated leading line as if it were real log output.
    const usable = size > chunkSize ? lines.slice(1) : lines;
    return usable.slice(-tailLines).join('\n');
  } finally {
    await fh.close();
  }
}

function streamLog(c: Context, file: string): Response {
  const BACKLOG_BYTES = 4096;
  // Tolerate transient fs hiccups (rotation in flight, brief lock) but
  // give up and tell the client when something is genuinely wrong —
  // without this the loop used to spin forever on a permanent error
  // (file unlinked, permissions changed) while the UI kept showing
  // "live" indefinitely.
  const MAX_CONSECUTIVE_ERRORS = 5;
  return stream(c, async (s) => {
    s.onAbort(() => {
      /* client gone */
    });
    let position = 0;
    try {
      const size = (await stat(file)).size;
      // Start by sending the last BACKLOG_BYTES so the UI has context, then
      // stream new bytes as they arrive.
      position = Math.max(0, size - BACKLOG_BYTES);
    } catch {
      /* file may not exist yet */
    }
    let consecutiveErrors = 0;
    while (!s.aborted) {
      try {
        const sz = (await stat(file)).size;
        if (sz > position) {
          const fh = await open(file, 'r');
          try {
            const buf = Buffer.alloc(sz - position);
            await fh.read(buf, 0, buf.byteLength, position);
            await s.write(buf.toString('utf8'));
            position = sz;
          } finally {
            await fh.close();
          }
        } else if (sz < position) {
          position = 0;
        }
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          // Surface the failure to the client as a sentinel line and
          // exit — the LogTail component will flip its badge to
          // "disconnected" instead of pulsing "live" forever.
          const msg = err instanceof Error ? err.message : String(err);
          await s.write(`\n[orchestrator] log stream stopped: ${msg}\n`);
          return;
        }
      }
      await s.sleep(1000);
    }
  });
}
