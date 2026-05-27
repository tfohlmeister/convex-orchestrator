import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { openDatabase } from './db/index.ts';
import {
  AuditRepo,
  BackupRepo,
  InstanceRepo,
  PortRepo,
  ResourceSampleRepo,
  RestoreJobRepo,
  StorageSampleRepo,
} from './db/repos.ts';
import { BackupManager } from './backups/manager.ts';
import { RestoreManager } from './backups/restore.ts';
import { PortAllocator } from './ports.ts';
import { PostgresStorage } from './storage/postgres.ts';
import { MinioStorage } from './storage/minio.ts';
import { StorageSampler } from './storage/sampler.ts';
import { Supervisor } from './supervisor/supervisor.ts';
import { mkdir } from 'node:fs/promises';
import {
  TraefikWriter,
  buildRouter,
  renderTraefikYaml,
  writeAtomicYaml,
} from './traefik/writer.ts';
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
  const backups = new BackupRepo(db);
  const restoreJobs = new RestoreJobRepo(db);
  // Any restore job that was mid-flight at last shutdown is now
  // unreachable from RestoreManager (the in-memory cache reset). Flip
  // them to 'failed' so the UI doesn't show a stuck "importing" forever.
  const recovered = restoreJobs.markInFlightAsFailed(
    'orchestrator restarted before restore job completed; check audit log + the pre-restore backup for the rollback point',
    Date.now(),
  );
  if (recovered > 0) {
    logger.warn({ recovered }, 'marked in-flight restore jobs failed after restart');
  }
  logger.info({ clkTck: getClkTck() }, 'resolved CLK_TCK for CPU sample derivation');

  if (config.ORCHESTRATOR_ADMIN_TOKEN.length === 0) {
    logger.warn(
      'ORCHESTRATOR_ADMIN_TOKEN is unset — /api/* is OPEN. Put an auth layer (Traefik basicauth, Authelia, oauth2-proxy, …) in front, or set the token.',
    );
  }

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
    logger,
    databaseUrl: () => postgres.databaseUrlForInstance(config.POSTGRES_CLUSTER_URL),
    s3: {
      endpoint: config.S3_ENDPOINT,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
      region: config.S3_REGION,
    },
    externalScheme: config.EXTERNAL_SCHEME,
    externalPortSuffix: config.EXTERNAL_PORT_SUFFIX,
    bindAddress: config.CONVEX_BIND_ADDRESS,
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

  const backupManager = new BackupManager({
    config,
    logger,
    instances,
    backups,
    audit,
    minio,
    listInstances: () => instances.list(),
    forceRestartBackend: (name, actor) => orchestrator.forceRestartBackend(name, actor),
    internalHost: '127.0.0.1',
  });
  orchestrator.attachBackupManager(backupManager);

  const restoreManager = new RestoreManager({
    config,
    logger,
    instances,
    backups,
    restoreJobs,
    audit,
    minio,
    orchestrator,
    backupManager,
    internalHost: '127.0.0.1',
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
  backupManager.start();

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
    backups,
    backupManager,
    restoreManager,
    minio,
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

  // The dashboard-switcher listener used to live here on
  // DEPLOYMENTS_API_PORT (default 8081), unauthenticated, returning
  // plaintext admin keys for every running instance. The original
  // intent (the official convex-dashboard hardcodes
  // http://127.0.0.1:<port>) does not survive this orchestrator's
  // deployment model: the dashboard runs in the user's browser, not in
  // the orchestrator container, so the browser's 127.0.0.1 resolves to
  // the user's local machine — not container loopback. The listener
  // was therefore never actually reachable by its intended consumer,
  // while on bare-metal hosts it exposed every admin key to any
  // co-tenant process. The authenticated /api/deployments endpoint
  // remains for any caller that legitimately needs the list.
  // Found by the code-review fleet (security #23).

  logger.info({ port: server.port }, 'orchestrator listening');

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    supervisor.stopBackgroundJobs();
    storageSampler.stop();
    backupManager.stop();
    await supervisor.stopAllForShutdown();
    await server.stop();
    await postgres.close();
    minio.close();
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
  // Two host rules → one shared service (the orchestrator itself, which
  // serves its own UI on `orchestrator.*` and the bundled Convex
  // dashboard on `dashboard.*` via host-header routing). Goes through
  // the same renderer + atomic writer as the per-instance routes so any
  // change to the router schema only needs to happen in one place.
  const entryPoint = config.TRAEFIK_ENTRYPOINT;
  const certResolver = config.TRAEFIK_CERT_RESOLVER;
  const routers = {
    'self-orchestrator': buildRouter({
      rule: `Host(\`orchestrator.${config.BASE_DOMAIN}\`)`,
      entryPoint,
      service: 'self-orchestrator',
      certResolver,
    }),
    'self-dashboard': buildRouter({
      rule: `Host(\`dashboard.${config.BASE_DOMAIN}\`)`,
      entryPoint,
      service: 'self-orchestrator',
      certResolver,
    }),
  };
  const services = {
    'self-orchestrator': {
      loadBalancer: {
        servers: [{ url: `http://orchestrator:${config.HTTP_PORT}` }],
        passHostHeader: true,
      },
    },
  };
  await writeAtomicYaml(outputPath, renderTraefikYaml(routers, services));
}

if (import.meta.main) {
  await bootstrap();
}
