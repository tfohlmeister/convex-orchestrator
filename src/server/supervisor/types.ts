export type InstanceStatus = 'creating' | 'running' | 'stopped' | 'error';

export interface Instance {
  name: string;
  status: InstanceStatus;
  baseDomain: string;
  cloudPort: number;
  sitePort: number;
  adminKey: string;
  instanceSecret: string;
  postgresSchema: string;
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
