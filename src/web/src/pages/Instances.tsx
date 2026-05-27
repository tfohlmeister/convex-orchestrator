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
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-orange-200 bg-orange-700/40 border border-orange-700/60">
        stuck
      </span>
    );
  }
  if (instance.latestBackupStatus === 'failed' && !instance.latestBackupAt) {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-red-200 bg-red-700/40 border border-red-700/60">
        failed
      </span>
    );
  }
  if (instance.latestBackupAt == null) {
    return <span className="text-slate-500">—</span>;
  }
  const ageMs = Date.now() - instance.latestBackupAt;
  let tone = 'text-emerald-300';
  if (ageMs > 5 * DAY_MS) tone = 'text-red-300';
  else if (ageMs > 2 * DAY_MS) tone = 'text-amber-300';
  return (
    <span className={`font-mono ${tone}`} title={new Date(instance.latestBackupAt).toISOString()}>
      {humanAge(ageMs)}
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
    <div>
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Instances</h1>
          <p className="text-sm text-slate-400">
            All Convex backends supervised by this orchestrator.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-md"
        >
          New instance
        </button>
      </header>

      {query.isLoading && <p className="text-slate-400">Loading…</p>}
      {query.error && <p className="text-red-400">{(query.error as Error).message}</p>}

      {query.data && (
        <table className="w-full border border-slate-800 rounded-lg overflow-hidden">
          <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">RSS</th>
              <th className="text-left px-4 py-2">CPU</th>
              <th className="text-left px-4 py-2">FD</th>
              <th className="text-left px-4 py-2">Trend (24h)</th>
              <th className="text-left px-4 py-2">Last backup</th>
              <th className="text-left px-4 py-2">Host</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {query.data.map((i) => (
              <Row key={i.name} instance={i} onDelete={() => setDeleteTarget(i.name)} />
            ))}
            {query.data.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-slate-500">
                  No instances yet. Click <em>New instance</em> to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <NewInstanceModal open={createOpen} onClose={() => setCreateOpen(false)} />
      {deleteTarget && (
        <DeleteConfirmDialog open name={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
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
  const detail = useQuery({
    queryKey: ['instance-samples', instance.name],
    queryFn: () => api.getInstance(instance.name),
    refetchInterval: 10_000,
  });
  const rssSparkValues = detail.data?.samples.map((s) => s.rssKb) ?? [];
  const fdSparkValues = (detail.data?.samples ?? []).slice(-48).map((s) => s.fdCount);
  const latestFd = detail.data?.samples.at(-1)?.fdCount ?? null;
  const rssMb = instance.latestSample ? (instance.latestSample.rssKb / 1024).toFixed(1) : '—';
  const cpu = instance.latestCpuCores != null ? instance.latestCpuCores.toFixed(2) : '—';

  return (
    <tr className="hover:bg-slate-900/60">
      <td className="px-4 py-3 font-mono text-sm">
        <Link to={`/instances/${instance.name}`} className="hover:underline">
          {instance.name}
        </Link>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={instance.status} />
      </td>
      <td className="px-4 py-3 text-sm">{rssMb} MB</td>
      <td className="px-4 py-3 text-sm font-mono">{cpu}</td>
      <td className="px-4 py-3" title={latestFd != null ? `${latestFd} open fds` : ''}>
        <Sparkline values={fdSparkValues} />
      </td>
      <td className="px-4 py-3">
        <Sparkline values={rssSparkValues} />
      </td>
      <td className="px-4 py-3 text-xs">
        <BackupHealthBadge instance={instance} />
      </td>
      <td className="px-4 py-3 text-xs text-slate-400">{instance.cloudHost}</td>
      <td className="px-4 py-3 text-right text-sm">
        <Link
          to={dashboardEmbedPath(instance.name)}
          className="text-emerald-400 hover:text-emerald-300 mr-3"
        >
          Dashboard ↗
        </Link>
        <button
          onClick={() => startStop.mutate()}
          disabled={startStop.isPending || instance.status === 'creating'}
          className="text-slate-300 hover:text-white mr-3"
        >
          {instance.status === 'running' ? 'Stop' : 'Start'}
        </button>
        <button onClick={onDelete} className="text-red-400 hover:text-red-300">
          Delete
        </button>
      </td>
    </tr>
  );
}
