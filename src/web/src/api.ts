export interface InstanceListItem {
  name: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  baseDomain: string;
  cloudHost: string;
  siteHost: string;
  cloudUrl: string;
  siteUrl: string;
  cloudPort: number;
  sitePort: number;
  adminKey: string;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  latestSample: ResourceSample | null;
  latestCpuCores: number | null;
  latestStorageBytes: number | null;
  // Backup metadata for the overview "Last backup" column.
  latestBackupAt: number | null;
  latestBackupStatus: BackupStatus | null;
  hasStuckBackup: boolean;
}

export type BackupSource = 'auto' | 'manual' | 'manual-upload' | 'pre-restore';
export type BackupStatus = 'running' | 'complete' | 'failed' | 'stuck' | 'corrupt';

export interface Backup {
  id: string;
  instanceName: string;
  source: BackupSource;
  startedAt: number;
  completedAt: number | null;
  status: BackupStatus;
  targetKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  convexVersion: string | null;
  errorMessage: string | null;
}

export interface BackupConfig {
  backupCron: string | null;
  backupRetentionDays: number | null;
  backupEnabled: boolean | null;
  backupSuspended: boolean;
}

export interface RestoreJob {
  id: string;
  instanceName: string;
  sourceBackupId: string;
  preRestoreBackupId: string | null;
  status: 'queued' | 'pre-backup' | 'stopping' | 'starting' | 'importing' | 'complete' | 'failed';
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

export function dashboardEmbedPath(instanceName: string): string {
  return `/instances/${encodeURIComponent(instanceName)}/dashboard`;
}

export interface ResourceSample {
  instanceName: string;
  takenAt: number;
  rssKb: number;
  cpuTicks: number;
  fdCount: number;
}

export interface SampleWithCpu {
  takenAt: number;
  rssKb: number;
  fdCount: number;
  cpuCores: number | null;
}

export interface StorageSample {
  instanceName: string;
  takenAt: number;
  bucketSuffix: string;
  sizeBytes: number;
  objectCount: number;
  partial: boolean;
}

export interface InstanceDetail {
  instance: Omit<InstanceListItem, 'latestSample'> & {
    adminKey: string;
    cloudUrl: string;
    latestCpuCores: number | null;
    latestStorageBytes: number | null;
    backupCron: string | null;
    backupRetentionDays: number | null;
    backupEnabled: boolean | null;
    backupSuspended: boolean;
  };
  samples: SampleWithCpu[];
  storageSamples: StorageSample[];
  audit: AuditEntry[];
}

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  instanceName: string | null;
  details: string | null;
}

const TOKEN_KEY = 'orchestrator.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: { error?: string; code?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AuthMode = 'bearer' | 'none';

export const api = {
  getAuthMode: () => request<{ mode: AuthMode }>('/api/auth/mode').then((r) => r.mode),
  listInstances: () =>
    request<{ instances: InstanceListItem[] }>('/api/instances').then((r) => r.instances),
  getInstance: (name: string) => request<InstanceDetail>(`/api/instances/${name}`),
  // Lightweight 6h sparkline series for the list-view rows. ~50 KB vs the
  // full detail-endpoint payload (24h samples + storage + audit + 10 most
  // recent backups). Replaces the N+1 detail fetches the list page used
  // to do per row every 10s.
  getSparkline: (name: string, hours = 6) =>
    request<{ points: { takenAt: number; rssKb: number; fdCount: number }[] }>(
      `/api/instances/${name}/sparkline?hours=${hours}`,
    ).then((r) => r.points),
  createInstance: (name: string) =>
    request<{ instance: { name: string; status: string } }>('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  startInstance: (name: string) =>
    request<{ ok: boolean }>(`/api/instances/${name}/start`, { method: 'POST' }),
  stopInstance: (name: string) =>
    request<{ ok: boolean }>(`/api/instances/${name}/stop`, { method: 'POST' }),
  deleteInstance: (name: string) =>
    request<{ ok: boolean }>(`/api/instances/${name}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName: name }),
    }),
  logsUrl: (name: string, stream: 'stdout' | 'stderr', follow: boolean): string => {
    const t = encodeURIComponent(getToken());
    return `/api/instances/${name}/logs?stream=${stream}&follow=${follow ? '1' : '0'}&t=${t}`;
  },
  listBackups: (name: string) =>
    request<{ backups: Backup[] }>(`/api/instances/${name}/backups`).then((r) => r.backups),
  triggerBackup: (name: string) =>
    request<{ ok: boolean; backupId: string }>(`/api/instances/${name}/backup`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  deleteBackup: (name: string, id: string) =>
    request<{ ok: boolean }>(`/api/instances/${name}/backups/${id}`, { method: 'DELETE' }),
  downloadBackupUrl: (name: string, id: string): string =>
    `/api/instances/${name}/backups/${id}/download`,
  restoreFromBackup: (name: string, backupId: string) =>
    request<{ jobId: string }>(`/api/instances/${name}/restore`, {
      method: 'POST',
      body: JSON.stringify({ backupId, confirmName: name }),
    }),
  restoreFromUpload: async (name: string, file: File): Promise<{ jobId: string }> => {
    const token = getToken();
    const headers: HeadersInit = {
      'x-confirm-name': name,
      'content-type': 'application/zip',
    };
    if (token) (headers as Record<string, string>).authorization = `Bearer ${token}`;
    const res = await fetch(`/api/instances/${name}/restore-from-upload`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!res.ok) {
      let body: { error?: string; code?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.error ?? res.statusText);
    }
    return (await res.json()) as { jobId: string };
  },
  getRestoreJob: (name: string, id: string) =>
    request<{ job: RestoreJob }>(`/api/instances/${name}/restore-jobs/${id}`).then((r) => r.job),
  updateBackupConfig: (name: string, cfg: Partial<BackupConfig>) =>
    request<BackupConfig>(`/api/instances/${name}/backup-config`, {
      method: 'PUT',
      body: JSON.stringify({
        cron: cfg.backupCron,
        retentionDays: cfg.backupRetentionDays,
        enabled: cfg.backupEnabled,
      }),
    }),
  forceRestartBackend: (name: string) =>
    request<{ ok: boolean }>(`/api/instances/${name}/force-restart-backend`, { method: 'POST' }),
};
