import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dashboardEmbedPath, type InstanceListItem } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { Sparkline } from '../components/Sparkline';
import { NewInstanceModal } from '../components/NewInstanceModal';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';

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
              <th className="text-left px-4 py-2">Trend (24h)</th>
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
                <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
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
  const sparkValues = detail.data?.samples.map((s) => s.rssKb) ?? [];
  const rssMb = instance.latestSample ? (instance.latestSample.rssKb / 1024).toFixed(1) : '—';

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
      <td className="px-4 py-3">
        <Sparkline values={sparkValues} />
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
