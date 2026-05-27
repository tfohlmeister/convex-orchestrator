import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, dashboardEmbedPath, getToken, type StorageSample } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { ConnectionPanel } from '../components/ConnectionPanel';
import { EndpointsPanel } from '../components/EndpointsPanel';
import { BackupsSection, BackupSettings } from '../components/BackupsSection';

// Fixed colour + order for the storage breakdown so the legend is stable.
const STORAGE_SERIES: { suffix: string; colour: string }[] = [
  { suffix: 'files', colour: '#34d399' },
  { suffix: 'modules', colour: '#60a5fa' },
  { suffix: 'exports', colour: '#fbbf24' },
  { suffix: 'snapshot-imports', colour: '#a78bfa' },
  { suffix: 'search', colour: '#f472b6' },
];

interface StoragePoint {
  t: string;
  takenAt: number;
  files: number;
  modules: number;
  exports: number;
  'snapshot-imports': number;
  search: number;
}

function bucketStoragePoints(samples: StorageSample[]): StoragePoint[] {
  // Storage samples come one row per bucket per tick. Group by takenAt so
  // each chart point has all five suffixes for proper stacking.
  const byTakenAt = new Map<number, StoragePoint>();
  for (const s of samples) {
    let point = byTakenAt.get(s.takenAt);
    if (!point) {
      point = {
        t: new Date(s.takenAt).toLocaleTimeString(),
        takenAt: s.takenAt,
        files: 0,
        modules: 0,
        exports: 0,
        'snapshot-imports': 0,
        search: 0,
      };
      byTakenAt.set(s.takenAt, point);
    }
    if (s.bucketSuffix in point) {
      (point as unknown as Record<string, number>)[s.bucketSuffix] = s.sizeBytes / 1024 / 1024;
    }
  }
  return Array.from(byTakenAt.values()).sort((a, b) => a.takenAt - b.takenAt);
}

export function InstanceDetailPage() {
  const { name = '' } = useParams();
  const query = useQuery({
    queryKey: ['instance', name],
    queryFn: () => api.getInstance(name),
    enabled: !!name,
  });

  // Hooks must run unconditionally — derive everything before any early
  // return, then branch on render output.
  const rawStorageSamples = query.data?.storageSamples;
  const storagePoints = useMemo(
    () => bucketStoragePoints(rawStorageSamples ?? []),
    [rawStorageSamples],
  );

  if (query.isLoading) return <p className="text-slate-400">Loading…</p>;
  if (query.error) return <p className="text-red-400">{(query.error as Error).message}</p>;
  if (!query.data) return null;

  const { instance, samples, storageSamples, audit } = query.data;
  const chartData = samples.map((s) => ({
    t: new Date(s.takenAt).toLocaleTimeString(),
    rssMb: s.rssKb / 1024,
    cpuCores: s.cpuCores,
  }));
  const cpuPointCount = chartData.filter((d) => d.cpuCores != null).length;
  const latestStorageMb =
    instance.latestStorageBytes != null ? instance.latestStorageBytes / 1024 / 1024 : null;
  const hasPartialStorage = storageSamples.some((s) => s.partial);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/instances" className="text-sm text-slate-500 hover:text-slate-300">
          ← All instances
        </Link>
        <h1 className="text-2xl font-semibold mt-1 flex items-center gap-3">
          <span className="font-mono">{instance.name}</span>
          <StatusBadge status={instance.status} />
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          <Link
            to={dashboardEmbedPath(instance.name)}
            className="text-emerald-400 hover:text-emerald-300 underline"
          >
            Open in Convex Dashboard ↗
          </Link>
        </p>
        {instance.lastError && (
          <p className="text-sm text-red-400 mt-2">Last error: {instance.lastError}</p>
        )}
      </div>

      <EndpointsPanel cloudUrl={instance.cloudUrl} siteUrl={instance.siteUrl} />

      <ConnectionPanel cloudUrl={instance.cloudUrl} adminKey={instance.adminKey} />

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">RSS (MB) · last 24h</h2>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-64">
          {chartData.length > 1 ? (
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <XAxis dataKey="t" stroke="#475569" fontSize={10} />
                <YAxis
                  stroke="#475569"
                  fontSize={10}
                  domain={['dataMin - 5', 'dataMax + 5']}
                  allowDecimals={false}
                />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                <Line
                  type="monotone"
                  dataKey="rssMb"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-500 text-sm">Not enough samples yet (need 2+).</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">
          CPU (cores) · last 24h
        </h2>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-64">
          {cpuPointCount >= 2 ? (
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <XAxis dataKey="t" stroke="#475569" fontSize={10} />
                <YAxis
                  stroke="#475569"
                  fontSize={10}
                  domain={['dataMin - 0.05', 'dataMax + 0.05']}
                  allowDecimals={true}
                  tickFormatter={(v: number) => v.toFixed(2)}
                />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
                  formatter={(value: number) => value.toFixed(3)}
                />
                <Line
                  type="monotone"
                  dataKey="cpuCores"
                  stroke="#60a5fa"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-500 text-sm">Not enough samples yet (need 2+).</p>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm uppercase tracking-wide text-slate-400 flex items-center gap-2">
            Storage · per bucket (last 24h)
            {hasPartialStorage && (
              <span
                className="text-amber-400"
                title="ListObjectsV2 page cap hit on at least one bucket; numbers are a lower bound"
              >
                ⚠
              </span>
            )}
          </h2>
          {latestStorageMb != null && (
            <span className="text-xs text-slate-500 font-mono">
              Total: {latestStorageMb.toFixed(1)} MB
            </span>
          )}
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-64">
          {storagePoints.length >= 1 ? (
            <ResponsiveContainer>
              <AreaChart data={storagePoints}>
                <XAxis dataKey="t" stroke="#475569" fontSize={10} />
                <YAxis
                  stroke="#475569"
                  fontSize={10}
                  domain={['dataMin - 5', 'dataMax + 5']}
                  tickFormatter={(v: number) => v.toFixed(0)}
                />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
                  formatter={(value: number) => `${value.toFixed(2)} MB`}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {STORAGE_SERIES.map((s) => (
                  <Area
                    key={s.suffix}
                    type="monotone"
                    dataKey={s.suffix}
                    stackId="storage"
                    stroke={s.colour}
                    fill={s.colour}
                    fillOpacity={0.4}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-500 text-sm">No storage samples yet (first tick in ≤5 min).</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">Logs (stdout, live)</h2>
        <LogTail name={instance.name} />
      </section>

      <BackupsSection instanceName={instance.name} hasStuckBackup={instance.hasStuckBackup} />

      <BackupSettings
        instanceName={instance.name}
        initial={{
          backupCron: instance.backupCron,
          backupRetentionDays: instance.backupRetentionDays,
          backupEnabled: instance.backupEnabled,
          backupSuspended: instance.backupSuspended,
        }}
      />

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">Audit</h2>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <ul className="space-y-1 text-xs font-mono">
            {audit.map((a, idx) => (
              <li key={idx} className="flex gap-3">
                <span className="text-slate-500">{new Date(a.at).toISOString()}</span>
                <span className="text-amber-300">{a.action}</span>
                <span className="text-slate-300">{a.actor}</span>
                {a.details && <span className="text-slate-500">{a.details}</span>}
              </li>
            ))}
            {audit.length === 0 && <li className="text-slate-500">No audit entries.</li>}
          </ul>
        </div>
      </section>
    </div>
  );
}

function LogTail({ name }: { name: string }) {
  const [lines, setLines] = useState<string>('');
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const token = getToken();
    let aborted = false;
    void (async () => {
      const res = await fetch(`/api/instances/${name}/logs?stream=stdout&follow=1`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (!aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          setLines((prev) => (prev + decoder.decode(value)).slice(-50_000));
          requestAnimationFrame(() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          });
        }
      }
    })();
    return () => {
      aborted = true;
      controller.abort();
    };
  }, [name]);

  return (
    <pre
      ref={ref}
      className="bg-slate-950 border border-slate-800 rounded-lg p-3 h-72 overflow-auto text-xs font-mono text-slate-300 whitespace-pre-wrap"
    >
      {lines || 'Waiting for log lines…'}
    </pre>
  );
}
