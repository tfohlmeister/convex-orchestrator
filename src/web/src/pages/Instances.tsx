import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dashboardEmbedPath, type InstanceListItem } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { Sparkline } from '../components/Sparkline';
import { NewInstanceModal } from '../components/NewInstanceModal';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';

// Daily-default schedule; threshold is "you've missed ~N expected backups"
// based on a 24h cadence. Real cron is per-instance, but the overview can't
// inspect it per-row without paying a query each. 24h × 2 / 5 mirrors the
// `2 × interval` (yellow) / `5 × interval` (red) thresholds in the spec.
const DAY_MS = 24 * 60 * 60_000;

function BackupHealthBadge({ instance }: { instance: InstanceListItem }) {
  if (instance.hasStuckBackup) {
    return <span className="pill pill-warn">stuck</span>;
  }
  if (instance.latestBackupStatus === 'failed' && !instance.latestBackupAt) {
    return <span className="pill pill-danger">failed</span>;
  }
  if (instance.latestBackupAt == null) {
    return <span className="text-[var(--color-soft)]">—</span>;
  }
  const ageMs = Date.now() - instance.latestBackupAt;
  let tone = 'text-[var(--color-ok)]';
  if (ageMs > 5 * DAY_MS) tone = 'text-[var(--color-danger)]';
  else if (ageMs > 2 * DAY_MS) tone = 'text-[var(--color-warn)]';
  return (
    <span
      className={`font-mono text-[12px] ${tone}`}
      title={new Date(instance.latestBackupAt).toISOString()}
    >
      {humanAge(ageMs)} ago
    </span>
  );
}

function humanAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function InstancesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['instances'], queryFn: api.listInstances });

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="eyebrow mb-2">Fleet</div>
          <h1 className="font-serif text-[42px] leading-[1.05] text-[var(--color-ink)] tracking-tight">
            Instances
          </h1>
          <p className="text-[13px] text-[var(--color-muted)] mt-2 max-w-md leading-relaxed">
            All Convex backends supervised by this orchestrator. Click any row to inspect, manage
            backups, or open the Convex dashboard.
          </p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn btn-accent">
          + New instance
        </button>
      </header>

      {query.isLoading && <p className="text-[var(--color-soft)] text-sm">Loading…</p>}
      {query.error && (
        <p className="text-[var(--color-danger)] text-sm">{(query.error as Error).message}</p>
      )}

      {query.data && (
        <div className="card overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-rule)]">
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>RSS</Th>
                <Th>CPU</Th>
                <Th>FD</Th>
                <Th>Trend (24h)</Th>
                <Th>Last backup</Th>
                <Th>Host</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-rule)]">
              {query.data.map((i) => (
                <Row key={i.name} instance={i} onDelete={() => setDeleteTarget(i.name)} />
              ))}
              {query.data.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center">
                    <div className="font-serif italic text-[22px] text-[var(--color-muted)] mb-1">
                      No instances yet.
                    </div>
                    <div className="text-[13px] text-[var(--color-soft)]">
                      Click <em className="font-serif">New instance</em> to create one.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <NewInstanceModal open={createOpen} onClose={() => setCreateOpen(false)} />
      {deleteTarget && (
        <DeleteConfirmDialog open name={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-4 py-3 ${
        align === 'right' ? 'text-right' : 'text-left'
      } text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-soft)] font-medium`}
    >
      {children}
    </th>
  );
}

function Row({ instance, onDelete }: { instance: InstanceListItem; onDelete: () => void }) {
  const qc = useQueryClient();
  const startStop = useMutation({
    mutationFn: () =>
      instance.status === 'running'
        ? api.stopInstance(instance.name)
        : api.startInstance(instance.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instances'] }),
  });
  const sparkline = useQuery({
    queryKey: ['instance-sparkline', instance.name],
    queryFn: () => api.getSparkline(instance.name, 6),
    refetchInterval: 10_000,
  });
  const points = sparkline.data ?? [];
  const rssSparkValues = points.map((s) => s.rssKb);
  const fdSparkValues = points.slice(-48).map((s) => s.fdCount);
  const latestFd = points.at(-1)?.fdCount ?? null;
  const rssMb = instance.latestSample ? (instance.latestSample.rssKb / 1024).toFixed(1) : '—';
  const cpu = instance.latestCpuCores != null ? instance.latestCpuCores.toFixed(2) : '—';

  return (
    <tr className="hover:bg-[var(--color-paper-2)]/60 transition-colors">
      <td className="px-4 py-3 font-mono text-[13px]">
        <Link
          to={`/instances/${instance.name}`}
          className="text-[var(--color-ink)] hover:text-[var(--color-accent)] transition-colors"
        >
          {instance.name}
        </Link>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={instance.status} />
      </td>
      <td className="px-4 py-3 text-[13px] font-mono text-[var(--color-ink)]">
        {rssMb} <span className="text-[var(--color-soft)] text-[11px]">MB</span>
      </td>
      <td className="px-4 py-3 text-[13px] font-mono text-[var(--color-ink)]">{cpu}</td>
      <td className="px-4 py-3" title={latestFd != null ? `${latestFd} open fds` : ''}>
        <Sparkline values={fdSparkValues} />
      </td>
      <td className="px-4 py-3">
        <Sparkline values={rssSparkValues} />
      </td>
      <td className="px-4 py-3">
        <BackupHealthBadge instance={instance} />
      </td>
      <td className="px-4 py-3 text-[12px] font-mono text-[var(--color-muted)]">
        {instance.cloudHost}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap space-x-4">
        <Link
          to={dashboardEmbedPath(instance.name)}
          className="text-[12px] font-mono uppercase tracking-wider text-[var(--color-accent)] hover:text-[var(--color-accent-soft)] transition-colors"
        >
          Dashboard ↗
        </Link>
        <button
          onClick={() => startStop.mutate()}
          disabled={startStop.isPending || instance.status === 'creating'}
          className="text-[12px] font-mono uppercase tracking-wider text-[var(--color-ink)] hover:text-[var(--color-accent)] transition-colors disabled:opacity-40"
        >
          {instance.status === 'running' ? 'Stop' : 'Start'}
        </button>
        <button
          onClick={onDelete}
          className="text-[12px] font-mono uppercase tracking-wider text-[var(--color-danger)] hover:opacity-70 transition-opacity"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}
