import { z } from 'zod';

const envSchema = z.object({
  BASE_DOMAIN: z.string().min(3),
  // Public URL scheme + optional port-suffix for the user-facing URLs of each
  // instance + the dashboard. Default https with empty port (production behind
  // a TLS terminator on :443). Spike override e.g. EXTERNAL_SCHEME=http +
  // EXTERNAL_PORT_SUFFIX=:18000 for plain-HTTP demos.
  EXTERNAL_SCHEME: z.enum(['http', 'https']).default('https'),
  EXTERNAL_PORT_SUFFIX: z.string().default(''),
  ORCHESTRATOR_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  // Optional. When set (>=16 chars) the orchestrator enforces
  // `Authorization: Bearer <token>` on every /api/* route. When unset or
  // empty the API + UI are open — meant for setups where an external
  // auth layer (Traefik basicauth, Authelia, oauth2-proxy, Cloudflare
  // Access, etc.) sits in front of the orchestrator.
  ORCHESTRATOR_ADMIN_TOKEN: z
    .string()
    .refine((v) => v === '' || v.length >= 16, {
      message: 'must be empty or at least 16 chars',
    })
    .default(''),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATA_DIR: z.string().default('/var/lib/orchestrator'),
  LOG_DIR: z.string().default('/var/log/convex'),
  CONVEX_BINARY: z.string().default('/convex/convex-local-backend'),
  GENERATE_KEY_BINARY: z.string().default('/convex/generate_key'),
  TRAEFIK_DYNAMIC_PATH: z.string().default('/etc/traefik/dynamic/orchestrator.yml'),
  // Cert resolver name. Empty/unset → write `tls: {}` so Traefik serves the
  // default certificate from its cert store (useful for self-signed setups).
  TRAEFIK_CERT_RESOLVER: z.string().default(''),
  // Traefik entrypoint name to attach per-instance routers to. Default
  // `websecure` (HTTPS). Use `web` for plain-HTTP spikes; the writer also
  // drops the `tls` block in that case.
  TRAEFIK_ENTRYPOINT: z.string().default('websecure'),
  TRAEFIK_SERVICE_LOOPBACK: z.string().default('host.docker.internal'),
  // Address each supervised convex-backend listens on. Default 127.0.0.1
  // keeps every backend bound to loopback (right for a bare-metal single
  // process). Set to 0.0.0.0 in the docker-compose layout so Traefik in
  // its own container can reach the backends via the bridge network.
  CONVEX_BIND_ADDRESS: z.string().default('127.0.0.1'),
  TRAEFIK_AUTH_MIDDLEWARES: z.string().optional(),
  // Cluster URL WITHOUT a db name path: e.g. postgres://convex:pw@postgres:5432
  // The orchestrator appends the shared multitenant db name when spawning each
  // backend. See docs/spike-notes.md §5.
  POSTGRES_CLUSTER_URL: z.string().url(),
  // Admin URL used to create the shared database if absent. Should target the
  // postgres maintenance db: e.g. postgres://convex:pw@postgres:5432/postgres
  POSTGRES_ADMIN_URL: z.string().url(),
  // Shared multitenant database name; created on boot if missing.
  POSTGRES_SHARED_DB: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .default('convex'),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // How often the storage sampler walks each instance's MinIO buckets to
  // record their total size + object count. 5 min default — disk grows in
  // MB scale per upload, not per second.
  STORAGE_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  // Per-bucket pagination cap to prevent a single misconfigured instance with
  // millions of objects from locking up the sampler. 100 pages × 1000 keys =
  // 100k objects per bucket per tick.
  STORAGE_SCAN_PAGE_LIMIT: z.coerce.number().int().min(1).default(100),
  // ---------------- Backup / restore ----------------
  // Master switch. When false the scheduler thread doesn't start; manual
  // /backup + /restore endpoints still work.
  BACKUP_SCHEDULER_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0')
    .default('true'),
  // Default cron expression when an instance has no `backup_cron` override.
  // Local time. 03:00 daily.
  BACKUP_DEFAULT_CRON: z.string().default('0 3 * * *'),
  // Default retention in days for source=auto backups.
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  // Cap on concurrent backup jobs across all instances. Convex export is
  // backend-CPU-heavy; 2 is safe on a homelab box.
  BACKUP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(20).default(2),
  // Above this duration in the `running` state, a backup is marked `stuck`
  // and the UI offers Force-restart-backend. 30 min default.
  BACKUP_EXPORT_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(30),
  // After this many consecutive auto-failures the instance's auto-schedule
  // is suspended (`backup_suspended=1`). Manual re-enable clears it.
  BACKUP_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).default(3),
  // Local-time hour at which the retention sweeper runs (0-23). 04:00 puts
  // it after the 03:00 default cron so the day's new backup is in before
  // anything gets pruned.
  BACKUP_RETENTION_HOUR: z.coerce.number().int().min(0).max(23).default(4),
  // Tick interval for the export-blob orphan cleanup. Hourly default; tasks
  // are cheap (`readdir` + a stat per file).
  EXPORT_BLOB_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  // Minimum mtime age before an exports/*.blob is considered orphaned.
  // Anything younger may belong to an in-flight export. 15 min default.
  EXPORT_BLOB_CLEANUP_MIN_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(15 * 60_000),
  // Working directory for backup zips during export/upload. Sized for the
  // largest expected backup zip. Defaults under DATA_DIR so it shares the
  // orchestrator's volume.
  BACKUP_WORK_DIR: z.string().default(''),
  // The Convex CLI binary name or absolute path. The runtime image symlinks
  // /usr/bin/convex to the globally-installed npm package.
  CONVEX_CLI: z.string().default('convex'),
  // Each instance's storage directory (where convex-backend writes
  // exports/*.blob). Templated with the instance name. Default matches the
  // backend's compiled-in `local_storage` path.
  CONVEX_STORAGE_DIR_TEMPLATE: z.string().default('/var/lib/orchestrator/storage/{instance}'),
  // Hard cap on the body size of POST /api/instances/:name/restore-from-upload.
  // Default 16 GiB. Without a cap a single request can fill the orchestrator
  // data volume and take down all hosted instances.
  MAX_RESTORE_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(16 * 1024 * 1024 * 1024),
});

export type Config = z.infer<typeof envSchema> & {
  middlewares: string[];
  sqlitePath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    middlewares: parsed.TRAEFIK_AUTH_MIDDLEWARES
      ? parsed.TRAEFIK_AUTH_MIDDLEWARES.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    sqlitePath: `${parsed.DATA_DIR}/orchestrator.sqlite`,
    BACKUP_WORK_DIR: parsed.BACKUP_WORK_DIR || `${parsed.DATA_DIR}/backup-work`,
  };
}
