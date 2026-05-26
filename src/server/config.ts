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
  ORCHESTRATOR_ADMIN_TOKEN: z.string().min(16),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATA_DIR: z.string().default('/var/lib/orchestrator'),
  LOG_DIR: z.string().default('/var/log/convex'),
  CONVEX_BINARY: z.string().default('/convex/convex-local-backend'),
  GENERATE_KEY_BINARY: z.string().default('/convex/generate_key'),
  DEPLOYMENTS_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  TRAEFIK_DYNAMIC_PATH: z.string().default('/etc/traefik/dynamic/orchestrator.yml'),
  // Cert resolver name. Empty/unset → write `tls: {}` so Traefik serves the
  // default certificate from its cert store (useful for self-signed setups).
  TRAEFIK_CERT_RESOLVER: z.string().default(''),
  // Traefik entrypoint name to attach per-instance routers to. Default
  // `websecure` (HTTPS). Use `web` for plain-HTTP spikes; the writer also
  // drops the `tls` block in that case.
  TRAEFIK_ENTRYPOINT: z.string().default('websecure'),
  TRAEFIK_SERVICE_LOOPBACK: z.string().default('host.docker.internal'),
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
  };
}
