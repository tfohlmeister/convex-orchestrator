import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
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
// Editorial palette: muted earth tones, accent rust as the focal series.
const STORAGE_SERIES: { suffix: string; colour: string }[] = [
  { suffix: 'files', colour: '#b5523a' },
  { suffix: 'modules', colour: '#1d4ed8' },
  { suffix: 'exports', colour: '#b45309' },
  { suffix: 'snapshot-imports', colour: '#15803d' },
  { suffix: 'search', colour: '#7c3aed' },
];

const CHART_GRID = 'rgba(28, 25, 23, 0.08)';
const CHART_AXIS = '#78716c';
const CHART_INK = '#1c1917';
const CHART_PAPER = '#faf7f2';

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

type Tab = 'performance' | 'logs' | 'backups';

const TABS: { id: Tab; label: string }[] = [
  { id: 'performance', label: 'Performance' },
  { id: 'logs', label: 'Logs · Audit' },
  { id: 'backups', label: 'Backups · Settings' },
];

export function InstanceDetailPage() {
  const { name = '' } = useParams();
  const [tab, setTab] = useState<Tab>('performance');
  const query = useQuery({
    queryKey: ['instance', name],
    queryFn: () => api.getInstance(name),
    enabled: !!name,
  });

  const rawStorageSamples = query.data?.storageSamples;
  const storagePoints = useMemo(
    () => bucketStoragePoints(rawStorageSamples ?? []),
    [rawStorageSamples],
  );

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[var(--color-soft)] text-sm">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
        Loading instance…
      </div>
    );
  }
  if (query.error) {
    return (
      <div className="card-soft p-4 text-[13px] text-[var(--color-danger)]">
        {(query.error as Error).message}
      </div>
    );
  }
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
  const latestRssMb = samples.at(-1)?.rssKb != null ? samples.at(-1)!.rssKb / 1024 : null;
  const latestCpu = instance.latestCpuCores;
  const latestFd = samples.at(-1)?.fdCount ?? null;

  return (
    <div className="space-y-8">
      {/* ------------ Header ------------ */}
      <header className="space-y-5">
        <Link
          to="/instances"
          className="text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-soft)] hover:text-[var(--color-ink)] transition-colors inline-flex items-center gap-1.5"
        >
          <span>←</span>
          <span>All instances</span>
        </Link>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-2">Instance</div>
            <h1 className="font-serif text-[42px] leading-[1.05] text-[var(--color-ink)] tracking-tight flex items-baseline gap-4 flex-wrap">
              <span className="font-mono text-[34px] font-medium">{instance.name}</span>
              <StatusBadge status={instance.status} />
            </h1>
          </div>
          <Link to={dashboardEmbedPath(instance.name)} className="btn btn-primary">
            Open Convex Dashboard
            <span className="text-[var(--color-paper-3)] ml-0.5">↗</span>
          </Link>
        </div>

        {instance.lastError && (
          <div className="card-soft p-3 text-[13px] text-[var(--color-danger)] border-[color:rgba(185,28,28,0.25)]">
            <span className="eyebrow text-[var(--color-danger)] mr-2">Last error</span>
            {instance.lastError}
          </div>
        )}

        {/* At-a-glance metrics — visible above the fold regardless of tab */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            label="RSS"
            value={latestRssMb != null ? `${latestRssMb.toFixed(0)}` : '—'}
            unit="MB"
          />
          <StatTile
            label="CPU"
            value={latestCpu != null ? latestCpu.toFixed(2) : '—'}
            unit="cores"
          />
          <StatTile label="FDs" value={latestFd != null ? String(latestFd) : '—'} unit="open" />
          <StatTile
            label="Storage"
            value={latestStorageMb != null ? `${latestStorageMb.toFixed(1)}` : '—'}
            unit="MB"
            partial={hasPartialStorage}
          />
        </div>

        <EndpointsPanel cloudUrl={instance.cloudUrl} siteUrl={instance.siteUrl} />
        <ConnectionPanel cloudUrl={instance.cloudUrl} adminKey={instance.adminKey} />
      </header>

      {/* ------------ Tab bar ------------ */}
      <nav className="border-b border-[var(--color-rule)] sticky top-0 bg-[var(--color-paper)]/85 backdrop-blur-md z-10 -mx-6 md:-mx-10 px-6 md:px-10">
        <div className="flex gap-8 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="tab whitespace-nowrap"
              data-active={tab === t.id ? 'true' : 'false'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* ------------ Tab content ------------ */}
      {tab === 'performance' && (
        <PerformancePanel
          chartData={chartData}
          cpuPointCount={cpuPointCount}
          storagePoints={storagePoints}
          hasPartialStorage={hasPartialStorage}
          latestStorageMb={latestStorageMb}
        />
      )}
      {tab === 'logs' && <LogsAuditPanel name={instance.name} audit={audit} />}
      {tab === 'backups' && (
        <div className="space-y-8">
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
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  unit,
  partial,
}: {
  label: string;
  value: string;
  unit: string;
  partial?: boolean;
}) {
  return (
    <div className="card-soft p-4">
      <div className="eyebrow flex items-center gap-1.5">
        {label}
        {partial && (
          <span
            className="text-[var(--color-warn)] normal-case tracking-normal"
            title="ListObjectsV2 page cap hit on at least one bucket; numbers are a lower bound"
          >
            ⚠
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-serif text-[30px] leading-none text-[var(--color-ink)]">{value}</span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-soft)]">
          {unit}
        </span>
      </div>
    </div>
  );
}

function PerformancePanel({
  chartData,
  cpuPointCount,
  storagePoints,
  hasPartialStorage,
  latestStorageMb,
}: {
  chartData: { t: string; rssMb: number; cpuCores: number | null }[];
  cpuPointCount: number;
  storagePoints: StoragePoint[];
  hasPartialStorage: boolean;
  latestStorageMb: number | null;
}) {
  return (
    <div className="space-y-6">
      <ChartCard title="RSS · last 24h" subtitle="megabytes">
        {chartData.length > 1 ? (
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="t" stroke={CHART_AXIS} fontSize={10} tickMargin={6} />
              <YAxis
                stroke={CHART_AXIS}
                fontSize={10}
                domain={['dataMin - 5', 'dataMax + 5']}
                allowDecimals={false}
                width={42}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: CHART_INK, fontSize: 11 }}
                itemStyle={{ color: CHART_INK }}
                formatter={(v: number) => `${v.toFixed(1)} MB`}
              />
              <Line
                type="monotone"
                dataKey="rssMb"
                stroke="#b5523a"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 4, fill: '#b5523a' }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label="Not enough samples yet (need 2+)." />
        )}
      </ChartCard>

      <ChartCard title="CPU · last 24h" subtitle="cores">
        {cpuPointCount >= 2 ? (
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="t" stroke={CHART_AXIS} fontSize={10} tickMargin={6} />
              <YAxis
                stroke={CHART_AXIS}
                fontSize={10}
                domain={['dataMin - 0.05', 'dataMax + 0.05']}
                allowDecimals
                tickFormatter={(v: number) => v.toFixed(2)}
                width={42}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: CHART_INK, fontSize: 11 }}
                itemStyle={{ color: CHART_INK }}
                formatter={(value: number) => value.toFixed(3)}
              />
              <Line
                type="monotone"
                dataKey="cpuCores"
                stroke="#1d4ed8"
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                activeDot={{ r: 4, fill: '#1d4ed8' }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label="Not enough samples yet (need 2+)." />
        )}
      </ChartCard>

      <ChartCard
        title="Storage · per bucket"
        subtitle="last 24h, megabytes"
        right={
          <div className="flex items-center gap-3">
            {hasPartialStorage && (
              <span
                className="pill pill-warn"
                title="ListObjectsV2 page cap hit on at least one bucket; numbers are a lower bound"
              >
                partial
              </span>
            )}
            {latestStorageMb != null && (
              <span className="text-[12px] font-mono text-[var(--color-muted)]">
                Total: {latestStorageMb.toFixed(1)} MB
              </span>
            )}
          </div>
        }
      >
        {storagePoints.length >= 1 ? (
          <ResponsiveContainer>
            <AreaChart data={storagePoints} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="t" stroke={CHART_AXIS} fontSize={10} tickMargin={6} />
              <YAxis
                stroke={CHART_AXIS}
                fontSize={10}
                domain={['dataMin - 5', 'dataMax + 5']}
                tickFormatter={(v: number) => v.toFixed(0)}
                width={42}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: CHART_INK, fontSize: 11 }}
                itemStyle={{ color: CHART_INK }}
                formatter={(value: number) => `${value.toFixed(2)} MB`}
              />
              <Legend wrapperStyle={{ fontSize: 10, color: CHART_INK }} iconType="square" />
              {STORAGE_SERIES.map((s) => (
                <Area
                  key={s.suffix}
                  type="monotone"
                  dataKey={s.suffix}
                  stackId="storage"
                  stroke={s.colour}
                  fill={s.colour}
                  fillOpacity={0.18}
                  strokeWidth={1.2}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label="No storage samples yet (first tick in ≤5 min)." />
        )}
      </ChartCard>
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: CHART_PAPER,
  border: '1px solid rgba(28, 25, 23, 0.18)',
  borderRadius: 8,
  fontSize: 12,
  fontFamily: 'Geist Mono, ui-monospace, monospace',
  boxShadow: '0 6px 24px rgba(28, 25, 23, 0.08)',
};

function ChartCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div>
          <div className="eyebrow">{title}</div>
          {subtitle && (
            <div className="text-[11px] font-mono text-[var(--color-soft)] mt-0.5">{subtitle}</div>
          )}
        </div>
        {right}
      </div>
      <div className="card p-4 h-64">{children}</div>
    </section>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-center">
      <p className="text-[var(--color-soft)] text-[13px] font-serif italic">{label}</p>
    </div>
  );
}

type LogStreamState =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'disconnected'; error: string };

function LogsAuditPanel({
  name,
  audit,
}: {
  name: string;
  audit: { at: number; action: string; actor: string; details?: string | null }[];
}) {
  const [streamState, setStreamState] = useState<LogStreamState>({ kind: 'connecting' });
  const badge = (() => {
    if (streamState.kind === 'live') return <span className="pill pill-ok pulse-dot">live</span>;
    if (streamState.kind === 'connecting')
      return <span className="pill pill-warn pulse-dot">connecting</span>;
    return (
      <span className="pill pill-danger" title={streamState.error}>
        disconnected
      </span>
    );
  })();
  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="eyebrow">Logs · stdout · live</div>
            <div className="text-[11px] font-mono text-[var(--color-soft)] mt-0.5">
              tailed from the backend process
            </div>
          </div>
          {badge}
        </div>
        <LogTail name={name} onStateChange={setStreamState} />
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="eyebrow">Audit</div>
            <div className="text-[11px] font-mono text-[var(--color-soft)] mt-0.5">
              every state-changing action on this instance
            </div>
          </div>
          <span className="text-[12px] font-mono text-[var(--color-soft)]">
            {audit.length} {audit.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <div className="card overflow-hidden">
          {audit.length === 0 ? (
            <p className="px-4 py-10 text-center text-[var(--color-soft)] text-[13px] font-serif italic">
              No audit entries yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-rule)]">
              {audit.map((a, idx) => (
                <li
                  key={idx}
                  className="px-4 py-2.5 flex gap-4 text-[12px] font-mono hover:bg-[var(--color-paper-2)]/50 transition-colors"
                >
                  <span className="text-[var(--color-soft)] shrink-0 w-52">
                    {new Date(a.at).toISOString()}
                  </span>
                  <span className="text-[var(--color-accent)] shrink-0 w-40 truncate">
                    {a.action}
                  </span>
                  <span className="text-[var(--color-ink)] shrink-0 w-32 truncate">{a.actor}</span>
                  {a.details && (
                    <span className="text-[var(--color-muted)] truncate flex-1">{a.details}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function LogTail({
  name,
  onStateChange,
}: {
  name: string;
  onStateChange?: (state: LogStreamState) => void;
}) {
  const [lines, setLines] = useState<string>('');
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const token = getToken();
    let aborted = false;
    onStateChange?.({ kind: 'connecting' });
    void (async () => {
      try {
        const res = await fetch(`/api/instances/${name}/logs?stream=stdout&follow=1`, {
          signal: controller.signal,
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          onStateChange?.({ kind: 'disconnected', error: `HTTP ${res.status}` });
          return;
        }
        if (!res.body) {
          onStateChange?.({ kind: 'disconnected', error: 'no response body' });
          return;
        }
        onStateChange?.({ kind: 'live' });
        const reader = res.body.getReader();
        // stream:true is load-bearing: a 4-byte codepoint split across two
        // network chunks would otherwise decode as U+FFFD on the first half.
        const decoder = new TextDecoder('utf-8', { fatal: false });
        while (!aborted) {
          const { value, done } = await reader.read();
          if (done) {
            // Server closed the stream cleanly (rotation, backend restart).
            if (!aborted) onStateChange?.({ kind: 'disconnected', error: 'stream closed' });
            break;
          }
          if (value) {
            setLines((prev) => (prev + decoder.decode(value, { stream: true })).slice(-50_000));
            requestAnimationFrame(() => {
              if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            });
          }
        }
      } catch (err) {
        // Cleanup-induced AbortError is expected on unmount and tab switch;
        // anything else is a real disconnect the user should see.
        if (aborted || (err instanceof Error && err.name === 'AbortError')) return;
        const msg = err instanceof Error ? err.message : String(err);
        onStateChange?.({ kind: 'disconnected', error: msg });
      }
    })();
    return () => {
      aborted = true;
      controller.abort();
    };
  }, [name, onStateChange]);

  return (
    <pre
      ref={ref}
      className="bg-[#1c1917] text-[#e7e5e4] border border-[var(--color-rule-strong)] rounded-xl p-4 h-80 overflow-auto text-[12px] font-mono leading-relaxed whitespace-pre-wrap"
    >
      {lines || <span className="text-[#a8a29e] italic font-serif">Waiting for log lines…</span>}
    </pre>
  );
}
