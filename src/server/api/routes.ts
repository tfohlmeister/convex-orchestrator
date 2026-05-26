import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Orchestrator } from '../orchestrator.ts';
import type { Config } from '../config.ts';
import type { AuditRepo, ResourceSampleRepo, StorageSampleRepo } from '../db/repos.ts';
import type { ResourceSample } from '../supervisor/types.ts';
import { getClkTck } from '../system.ts';
import { OrchestratorError, errorResponse } from './errors.ts';
import {
  CreateInstanceSchema,
  DeleteConfirmSchema,
  InstanceNameSchema,
  LogsQuerySchema,
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
  ready: () => boolean;
}

export function buildRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const requireBearer = bearerAuth(deps.config.ORCHESTRATOR_ADMIN_TOKEN);

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) =>
    deps.ready() ? c.json({ ready: true }) : c.json({ ready: false }, 503),
  );

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
      return {
        name: i.name,
        status: i.status,
        baseDomain: i.baseDomain,
        cloudHost: `${i.name}.${i.baseDomain}`,
        siteHost: `${i.name}-site.${i.baseDomain}`,
        cloudUrl: `${deps.config.EXTERNAL_SCHEME}://${i.name}.${i.baseDomain}${deps.config.EXTERNAL_PORT_SUFFIX}`,
        cloudPort: i.cloudPort,
        sitePort: i.sitePort,
        adminKey: i.adminKey,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        lastError: i.lastError ?? null,
        latestSample: deps.samples.latestFor(i.name),
        latestCpuCores,
        latestStorageBytes,
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
          createdAt: inst.createdAt,
          updatedAt: inst.updatedAt,
          lastError: inst.lastError ?? null,
          latestCpuCores,
          latestStorageBytes,
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

function actorOf(c: Context): string {
  return c.req.header('x-forwarded-user') ?? 'admin';
}

function bearerAuth(token: string) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const header = c.req.header('authorization') ?? '';
    if (header !== `Bearer ${token}`) {
      return c.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    await next();
  };
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
