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
};
