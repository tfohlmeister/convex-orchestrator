export type InstanceStatus = 'creating' | 'running' | 'stopped' | 'error';

export interface Instance {
  // Slug. Primary key, immutable after create. Appears in URLs as
  // <name>.<baseDomain>, in MinIO bucket prefixes, and as the Convex
  // backend's --instance-name arg (which keys multi-tenant Postgres
  // rows). Cannot be changed without a full export+restore migration.
  name: string;
  // Human label, free-form, NULL when not set. UI falls back to `name`.
  // Editable any time without touching the slug.
  displayName: string | null;
  status: InstanceStatus;
  baseDomain: string;
  cloudPort: number;
  sitePort: number;
  adminKey: string;
  instanceSecret: string;
  postgresDatabase: string;
  bucketPrefix: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string | null;
  // Per-instance backup config. null → fall back to orchestrator defaults.
  backupCron: string | null;
  backupRetentionDays: number | null;
  backupEnabled: boolean | null;
  // True after consecutive backup failures suspended automatic scheduling.
  // Cleared by manual re-enable.
  backupSuspended: boolean;
  // Per-instance scheduled-restart config. Restarting the backend on a cron
  // reclaims the executor's V8/heap memory that self-hosted Convex does not
  // release at runtime. Opt-in: restartEnabled null/false → no schedule.
  // restartCron null with restartEnabled true → use RESTART_DEFAULT_CRON.
  restartCron: string | null;
  restartEnabled: boolean | null;
}

export interface ProcessState {
  name: string;
  pid: number | null;
  startedAt: number | null;
  restartAttempts: number;
  restartWindowStart: number;
}

export interface ResourceSample {
  instanceName: string;
  takenAt: number;
  rssKb: number;
  cpuTicks: number;
  fdCount: number;
}

export interface RouteSpec {
  instanceName: string;
  cloudHost: string;
  siteHost: string;
  cloudPort: number;
  sitePort: number;
}

export interface SpawnConfig {
  instance: Instance;
  binaryPath: string;
  logDir: string;
  databaseUrl: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Region: string;
  bindAddress: string;
  externalScheme: 'http' | 'https';
  externalPortSuffix: string;
  // Notified when stdout/stderr piping into the RotatingLog fails. Used
  // by the supervisor to log "logs went dark" so the operator sees the
  // failure instead of the orchestrator just losing the stream silently.
  onPipeError?: (stream: 'stdout' | 'stderr', err: Error) => void;
}
