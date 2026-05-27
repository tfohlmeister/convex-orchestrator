import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { Orchestrator } from '../orchestrator.ts';
import type { Config } from '../config.ts';
import type { AuditRepo, BackupRepo, ResourceSampleRepo, StorageSampleRepo } from '../db/repos.ts';
import type { ResourceSample } from '../supervisor/types.ts';
import type { BackupManager } from '../backups/manager.ts';
import type { RestoreManager } from '../backups/restore.ts';
import type { MinioStorage } from '../storage/minio.ts';
import { getClkTck } from '../system.ts';
import { OrchestratorError, errorResponse } from './errors.ts';
import {
  BackupConfigSchema,
  CreateInstanceSchema,
  DeleteConfirmSchema,
  InstanceNameSchema,
  LogsQuerySchema,
  RestoreSchema,
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

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) =>
    deps.ready() ? c.json({ ready: true }) : c.json({ ready: false }, 503),
  );
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
        status: i.status,
        baseDomain: i.baseDomain,
        cloudHost: `${i.name}.${i.baseDomain}`,
        siteHost: `${i.name}-site.${i.baseDomain}`,
        cloudUrl: `${deps.config.EXTERNAL_SCHEME}://${i.name}.${i.baseDomain}${deps.config.EXTERNAL_PORT_SUFFIX}`,
        siteUrl: `${deps.config.EXTERNAL_SCHEME}://${i.name}-site.${i.baseDomain}${deps.config.EXTERNAL_PORT_SUFFIX}`,
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
          status: inst.status,
          baseDomain: inst.baseDomain,
          cloudHost: `${inst.name}.${inst.baseDomain}`,
          siteHost: `${inst.name}-site.${inst.baseDomain}`,
          cloudPort: inst.cloudPort,
          sitePort: inst.sitePort,
          adminKey: inst.adminKey,
          cloudUrl: `${deps.config.EXTERNAL_SCHEME}://${inst.name}.${inst.baseDomain}${deps.config.EXTERNAL_PORT_SUFFIX}`,
          siteUrl: `${deps.config.EXTERNAL_SCHEME}://${inst.name}-site.${inst.baseDomain}${deps.config.EXTERNAL_PORT_SUFFIX}`,
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
      const inst = await deps.orchestrator.create(body.name, actorOf(c));
      return c.json({ instance: { name: inst.name, status: inst.status } }, 201);
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
        await pipeline(body as unknown as ReadableStream<Uint8Array>, counter, tmpStream);
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
      if (typeof body.cron === 'string') {
        const { parseCron } = await import('../backups/cron.ts');
        parseCron(body.cron);
      }
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
    return lines.slice(-tailLines).join('\n');
  } finally {
    await fh.close();
  }
}

function streamLog(c: Context, file: string): Response {
  const BACKLOG_BYTES = 4096;
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
      } catch {
        /* swallow */
      }
      await s.sleep(1000);
    }
  });
}
