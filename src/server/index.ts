import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { openDatabase } from './db/index.ts';
import {
  AuditRepo,
  InstanceRepo,
  PortRepo,
  ResourceSampleRepo,
  StorageSampleRepo,
} from './db/repos.ts';
import { PortAllocator } from './ports.ts';
import { PostgresStorage } from './storage/postgres.ts';
import { MinioStorage } from './storage/minio.ts';
import { StorageSampler } from './storage/sampler.ts';
import { Supervisor } from './supervisor/supervisor.ts';
import { TraefikWriter } from './traefik/writer.ts';
import { Orchestrator } from './orchestrator.ts';
import { buildRoutes } from './api/routes.ts';
import { getClkTck } from './system.ts';

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  await mkdir(config.DATA_DIR, { recursive: true });
  await mkdir(config.LOG_DIR, { recursive: true });
  await mkdir(dirname(config.TRAEFIK_DYNAMIC_PATH), { recursive: true });

  const db = await openDatabase(config.sqlitePath);
  const instances = new InstanceRepo(db, config.ORCHESTRATOR_MASTER_KEY);
  const ports = new PortAllocator(new PortRepo(db));
  const samples = new ResourceSampleRepo(db);
  const storage = new StorageSampleRepo(db);
  const audit = new AuditRepo(db);
  logger.info({ clkTck: getClkTck() }, 'resolved CLK_TCK for CPU sample derivation');

  const postgres = new PostgresStorage({
    adminConnectionString: config.POSTGRES_ADMIN_URL,
    sharedDatabase: config.POSTGRES_SHARED_DB,
  });
  await postgres.ensureSharedDatabaseExists();
  const minio = new MinioStorage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
  });

  const traefik = new TraefikWriter({
    outputPath: config.TRAEFIK_DYNAMIC_PATH,
    certResolver: config.TRAEFIK_CERT_RESOLVER,
    serviceLoopback: config.TRAEFIK_SERVICE_LOOPBACK,
    entryPoint: config.TRAEFIK_ENTRYPOINT,
    ...(config.middlewares.length > 0 ? { middlewares: config.middlewares } : {}),
  });

  const supervisor = new Supervisor({
    binaryPath: config.CONVEX_BINARY,
    logDir: config.LOG_DIR,
    databaseUrl: () => postgres.databaseUrlForInstance(config.POSTGRES_CLUSTER_URL),
    s3: {
      endpoint: config.S3_ENDPOINT,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
      region: config.S3_REGION,
    },
    externalScheme: config.EXTERNAL_SCHEME,
    externalPortSuffix: config.EXTERNAL_PORT_SUFFIX,
    resourceSink: samples,
    onStatusChange: (name, status, lastError) => {
      instances.updateStatus(name, status, lastError ?? null);
      logger.info({ name, status }, 'instance status changed');
    },
  });

  const orchestrator = new Orchestrator({
    config,
    logger,
    instances,
    audit,
    samples,
    ports,
    postgres,
    minio,
    supervisor,
    traefik,
  });

  const storageSampler = new StorageSampler({
    minio,
    repo: storage,
    logger,
    getRunningInstances: () => instances.listByStatus('running'),
    intervalMs: config.STORAGE_SAMPLE_INTERVAL_MS,
    pageLimit: config.STORAGE_SCAN_PAGE_LIMIT,
  });

  // Write the static self-routes (orchestrator UI + bundled dashboard) into
  // a second YAML file the Traefik file provider picks up alongside the
  // per-instance dynamic.yml the orchestrator writes elsewhere. This lets us
  // skip the Traefik docker provider entirely, which avoids the
  // Docker-API-version mismatch with daemon 29.x.
  const selfRoutesPath = config.TRAEFIK_DYNAMIC_PATH.replace(/[^/]*$/, 'self.yml');
  await writeSelfRoutes(selfRoutesPath, config);

  let ready = false;
  supervisor.startBackgroundJobs();
  storageSampler.start();

  const existing = instances.list();
  traefik.replaceAll(
    existing
      .filter((i) => i.status === 'running')
      .map((i) => ({
        instanceName: i.name,
        cloudHost: `${i.name}.${i.baseDomain}`,
        siteHost: `${i.name}-site.${i.baseDomain}`,
        cloudPort: i.cloudPort,
        sitePort: i.sitePort,
      })),
  );
  await traefik.commit();
  await orchestrator.restoreRunning();
  ready = true;

  type Vars = { reqId: string };
  const app = new Hono<{ Variables: Vars }>();
  app.use('*', async (c, next) => {
    const reqId = c.req.header('x-request-id') ?? randomUUID();
    c.set('reqId', reqId);
    const start = Date.now();
    await next();
    logger.info(
      {
        reqId,
        method: c.req.method,
        path: c.req.path,
        host: c.req.header('host') ?? '',
        status: c.res.status,
        ms: Date.now() - start,
      },
      'request',
    );
  });

  // Host-based split: requests for dashboard.<base>/* are served from the
  // bundled Convex dashboard static export (with our setup.html helper).
  // Everything else falls through to the orchestrator API + UI.
  // See docs/spike-notes.md §6 for why we ship the dashboard ourselves rather
  // than running the official container.
  const dashboardRoot = serveStatic({ root: './dist/dashboard' });
  const dashboardIndex = serveStatic({ path: './dist/dashboard/index.html' });
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase().split(':')[0] ?? '';
    if (!host.startsWith('dashboard.')) {
      await next();
      return;
    }
    if (c.req.path === '/' || c.req.path === '') {
      const r = await dashboardIndex(c, next);
      return r ?? c.text('not found', 404);
    }
    const r = await dashboardRoot(c, next);
    return r ?? c.text('not found', 404);
  });

  const apiRoutes = buildRoutes({
    orchestrator,
    config,
    samples,
    storage,
    audit,
    ready: () => ready,
  });
  app.route('/', apiRoutes);

  const spaIndex = serveStatic({ path: './dist/web/index.html' });
  app.use('/assets/*', serveStatic({ root: './dist/web' }));
  app.get('/', spaIndex);
  app.get('/index.html', spaIndex);
  app.notFound(async (c) => {
    if (
      c.req.path.startsWith('/api') ||
      c.req.path.startsWith('/healthz') ||
      c.req.path.startsWith('/readyz')
    ) {
      return c.json({ error: 'not found', code: 'NOT_FOUND' }, 404);
    }
    const res = await spaIndex(c, async () => undefined);
    return res ?? c.text('not found', 404);
  });

  const server = Bun.serve({
    port: config.HTTP_PORT,
    fetch: app.fetch,
  });

  // Unauthenticated loopback-only listener for the dashboard switcher. The
  // official convex-dashboard hardcodes `http://127.0.0.1:<port>` with no
  // auth header, so we expose the deployments JSON at `/` on loopback and
  // rely on dashboard sharing this container's network namespace.
  // See docs/spike-notes.md §3.
  const deploymentsServer = Bun.serve({
    hostname: '127.0.0.1',
    port: config.DEPLOYMENTS_API_PORT,
    fetch: (req) => {
      const url = new URL(req.url);
      if (req.method !== 'GET' || url.pathname !== '/') {
        return new Response('not found', { status: 404 });
      }
      return Response.json(orchestrator.deployments());
    },
  });

  logger.info(
    { port: server.port, deploymentsPort: deploymentsServer.port },
    'orchestrator listening',
  );

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    supervisor.stopBackgroundJobs();
    storageSampler.stop();
    await supervisor.stopAllForShutdown();
    await server.stop();
    await deploymentsServer.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function writeSelfRoutes(
  outputPath: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const tlsBlock =
    config.TRAEFIK_ENTRYPOINT === 'web'
      ? ''
      : `        tls:${config.TRAEFIK_CERT_RESOLVER ? `\n          certResolver: ${config.TRAEFIK_CERT_RESOLVER}` : ' {}'}\n`;
  const yaml = `# Auto-generated by the orchestrator on boot. Do not edit by hand;
# it is rewritten on every startup. Holds the routes that point Traefik
# at the orchestrator's own UI + the bundled Convex dashboard. Per-instance
# routes live in the sibling dynamic.yml.
http:
  routers:
    self-orchestrator:
      rule: "Host(\`orchestrator.${config.BASE_DOMAIN}\`)"
      entryPoints:
        - ${config.TRAEFIK_ENTRYPOINT}
      service: self-orchestrator
${tlsBlock}    self-dashboard:
      rule: "Host(\`dashboard.${config.BASE_DOMAIN}\`)"
      entryPoints:
        - ${config.TRAEFIK_ENTRYPOINT}
      service: self-orchestrator
${tlsBlock}  services:
    self-orchestrator:
      loadBalancer:
        servers:
          - url: http://orchestrator:${config.HTTP_PORT}
        passHostHeader: true
`;
  await mkdir(outputPath.replace(/[^/]*$/, ''), { recursive: true });
  const tmp = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, yaml, 'utf8');
  await rename(tmp, outputPath);
}

if (import.meta.main) {
  await bootstrap();
}
