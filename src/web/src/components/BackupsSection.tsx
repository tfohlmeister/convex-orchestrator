import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken, type Backup, type RestoreJob } from '../api';

const SOURCE_TONE: Record<Backup['source'], string> = {
  auto: 'bg-slate-700/40 text-slate-300',
  manual: 'bg-blue-700/40 text-blue-200',
  'manual-upload': 'bg-violet-700/40 text-violet-200',
  'pre-restore': 'bg-amber-700/40 text-amber-200',
};

const STATUS_TONE: Record<Backup['status'], string> = {
  complete: 'text-emerald-300',
  running: 'text-blue-300',
  failed: 'text-red-300',
  stuck: 'text-orange-300',
  corrupt: 'text-red-300',
};

export function BackupsSection({
  instanceName,
  hasStuckBackup,
}: {
  instanceName: string;
  hasStuckBackup: boolean;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['backups', instanceName],
    queryFn: () => api.listBackups(instanceName),
    refetchInterval: 5_000,
  });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [restoreJobId, setRestoreJobId] = useState<string | null>(null);

  const triggerBackup = useMutation({
    mutationFn: () => api.triggerBackup(instanceName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', instanceName] }),
  });
  const forceRestart = useMutation({
    mutationFn: () => api.forceRestartBackend(instanceName),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['instance', instanceName] });
      void qc.invalidateQueries({ queryKey: ['backups', instanceName] });
    },
  });
  const deleteBackup = useMutation({
    mutationFn: (id: string) => api.deleteBackup(instanceName, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', instanceName] }),
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm uppercase tracking-wide text-slate-400">Backups</h2>
        <div className="flex gap-2">
          <button
            onClick={() => triggerBackup.mutate()}
            disabled={triggerBackup.isPending}
            className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md"
          >
            {triggerBackup.isPending ? 'Queuing…' : 'Backup now'}
          </button>
          <button
            onClick={() => setUploadOpen(true)}
            className="text-xs px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-md"
          >
            Restore from upload…
          </button>
        </div>
      </div>

      {hasStuckBackup && (
        <div className="mb-3 bg-orange-900/40 border border-orange-700/60 rounded-md p-3 flex items-center justify-between">
          <div className="text-sm text-orange-200">
            <strong>Stuck export detected.</strong> A previous backup never finished. The export
            lock in Convex only clears by restarting the backend process.
          </div>
          <button
            onClick={() => forceRestart.mutate()}
            disabled={forceRestart.isPending}
            className="ml-3 text-xs px-3 py-1.5 bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 rounded-md"
          >
            {forceRestart.isPending ? 'Restarting…' : 'Force restart backend'}
          </button>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-900 text-slate-400 uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Size</th>
              <th className="text-left px-3 py-2">SHA-256</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {query.data?.map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2 font-mono text-slate-300">
                  {new Date(b.startedAt).toISOString()}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded ${SOURCE_TONE[b.source]}`}>
                    {b.source}
                  </span>
                </td>
                <td className={`px-3 py-2 font-mono ${STATUS_TONE[b.status]}`}>
                  {b.status}
                  {b.errorMessage && (
                    <span className="ml-1 text-slate-500" title={b.errorMessage}>
                      ⓘ
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-slate-300">
                  {b.sizeBytes != null ? formatBytes(b.sizeBytes) : '—'}
                </td>
                <td className="px-3 py-2 font-mono text-slate-500">
                  {b.sha256 ? b.sha256.slice(0, 12) : '—'}
                </td>
                <td className="px-3 py-2 text-right space-x-3">
                  {b.status === 'complete' && b.targetKey && (
                    <button
                      onClick={() => void downloadBackup(instanceName, b)}
                      className="text-emerald-400 hover:text-emerald-300"
                    >
                      Download
                    </button>
                  )}
                  {b.status === 'complete' && (
                    <button
                      onClick={() => setRestoreTarget(b)}
                      className="text-amber-300 hover:text-amber-200"
                    >
                      Restore
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete backup ${b.id}?`)) deleteBackup.mutate(b.id);
                    }}
                    className="text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {query.data && query.data.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No backups yet. Trigger one with <em>Backup now</em>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {restoreTarget && (
        <RestoreFromBackupDialog
          instanceName={instanceName}
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onStarted={(id) => {
            setRestoreTarget(null);
            setRestoreJobId(id);
          }}
        />
      )}
      {uploadOpen && (
        <UploadRestoreDialog
          instanceName={instanceName}
          onClose={() => setUploadOpen(false)}
          onStarted={(id) => {
            setUploadOpen(false);
            setRestoreJobId(id);
          }}
        />
      )}
      {restoreJobId && (
        <RestoreJobStatus
          instanceName={instanceName}
          jobId={restoreJobId}
          onDismiss={() => setRestoreJobId(null)}
        />
      )}
    </section>
  );
}

async function downloadBackup(instanceName: string, b: Backup): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) (headers as Record<string, string>).authorization = `Bearer ${token}`;
  const res = await fetch(api.downloadBackupUrl(instanceName, b.id), { headers });
  if (!res.ok) {
    window.alert(`download failed (${res.status})`);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const isoStamp = new Date(b.startedAt).toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `${instanceName}_${isoStamp}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function RestoreFromBackupDialog({
  instanceName,
  backup,
  onClose,
  onStarted,
}: {
  instanceName: string;
  backup: Backup;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const restore = useMutation({
    mutationFn: () => api.restoreFromBackup(instanceName, backup.id),
    onSuccess: (r) => onStarted(r.jobId),
  });
  const match = typed === instanceName;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-amber-700/60 rounded-lg p-6 w-[32rem]">
        <h2 className="text-lg font-semibold mb-2 text-amber-300">
          Restore {instanceName} from backup
        </h2>
        <p className="text-sm text-slate-400 mb-3">
          This will <strong className="text-amber-300">replace all current data</strong> for{' '}
          <code className="font-mono">{instanceName}</code> with the contents of backup{' '}
          <code className="font-mono">{backup.id.slice(0, 8)}</code> from{' '}
          {new Date(backup.startedAt).toLocaleString()}. A pre-restore backup is taken first as a
          rollback point.
        </p>
        <label className="block text-sm text-slate-300 mb-1">
          Type <code className="font-mono">{instanceName}</code> to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm font-mono"
        />
        {restore.isError && (
          <p className="text-xs text-red-400 mt-2">{(restore.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-300">
            Cancel
          </button>
          <button
            disabled={!match || restore.isPending}
            onClick={() => restore.mutate()}
            className="px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md"
          >
            {restore.isPending ? 'Starting…' : 'Restore'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UploadRestoreDialog({
  instanceName,
  onClose,
  onStarted,
}: {
  instanceName: string;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const restore = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('pick a file');
      setProgress(0);
      // Native fetch can't report upload progress; show indeterminate.
      const r = await api.restoreFromUpload(instanceName, file);
      setProgress(100);
      return r;
    },
    onSuccess: (r) => onStarted(r.jobId),
  });
  const match = typed === instanceName;
  const ready = match && file != null && !restore.isPending;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-violet-700/60 rounded-lg p-6 w-[32rem]">
        <h2 className="text-lg font-semibold mb-2 text-violet-300">Restore from upload</h2>
        <p className="text-sm text-slate-400 mb-3">
          Upload a Convex snapshot <code className="font-mono">.zip</code>. The upload is streamed
          straight to MinIO; a pre-restore backup is taken before the import.{' '}
          <strong className="text-amber-300">All current data is replaced.</strong>
        </p>
        <label className="block text-sm text-slate-300 mb-1">Snapshot zip</label>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-xs text-slate-300 mb-3"
        />
        <label className="block text-sm text-slate-300 mb-1">
          Type <code className="font-mono">{instanceName}</code> to confirm
        </label>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm font-mono"
        />
        {progress != null && progress < 100 && (
          <p className="text-xs text-slate-400 mt-2">Uploading…</p>
        )}
        {restore.isError && (
          <p className="text-xs text-red-400 mt-2">{(restore.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-300">
            Cancel
          </button>
          <button
            disabled={!ready}
            onClick={() => restore.mutate()}
            className="px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md"
          >
            {restore.isPending ? 'Uploading…' : 'Upload and restore'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RestoreJobStatus({
  instanceName,
  jobId,
  onDismiss,
}: {
  instanceName: string;
  jobId: string;
  onDismiss: () => void;
}) {
  const [job, setJob] = useState<RestoreJob | null>(null);
  useEffect(() => {
    let mounted = true;
    const tick = async (): Promise<void> => {
      try {
        const j = await api.getRestoreJob(instanceName, jobId);
        if (!mounted) return;
        setJob(j);
        if (j.status !== 'complete' && j.status !== 'failed') {
          setTimeout(() => void tick(), 2_000);
        }
      } catch {
        if (mounted) setTimeout(() => void tick(), 5_000);
      }
    };
    void tick();
    return () => {
      mounted = false;
    };
  }, [instanceName, jobId]);

  if (!job) return null;
  const done = job.status === 'complete' || job.status === 'failed';
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-[28rem]">
        <h2 className="text-lg font-semibold mb-2">Restore job</h2>
        <p className="text-xs text-slate-500 mb-1 font-mono">{jobId}</p>
        <p
          className={`text-sm font-mono ${
            job.status === 'failed'
              ? 'text-red-300'
              : job.status === 'complete'
                ? 'text-emerald-300'
                : 'text-blue-300'
          }`}
        >
          {job.status}
        </p>
        {job.preRestoreBackupId && (
          <p className="text-xs text-slate-400 mt-2">
            Pre-restore backup:{' '}
            <code className="font-mono">{job.preRestoreBackupId.slice(0, 8)}</code>
          </p>
        )}
        {job.error && <p className="text-xs text-red-400 mt-2">{job.error}</p>}
        <div className="flex justify-end mt-6">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
          >
            {done ? 'Close' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BackupSettings({
  instanceName,
  initial,
}: {
  instanceName: string;
  initial: {
    backupCron: string | null;
    backupRetentionDays: number | null;
    backupEnabled: boolean | null;
    backupSuspended: boolean;
  };
}) {
  const qc = useQueryClient();
  const [cron, setCron] = useState(initial.backupCron ?? '');
  const [retention, setRetention] = useState<string>(
    initial.backupRetentionDays != null ? String(initial.backupRetentionDays) : '',
  );
  const [enabled, setEnabled] = useState<boolean>(initial.backupEnabled ?? true);
  const save = useMutation({
    mutationFn: () =>
      api.updateBackupConfig(instanceName, {
        backupCron: cron.trim() === '' ? null : cron.trim(),
        backupRetentionDays: retention.trim() === '' ? null : Number(retention),
        backupEnabled: enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instance', instanceName] }),
  });
  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">Backup settings</h2>
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 grid grid-cols-2 gap-4">
        <label className="text-xs text-slate-300 flex flex-col gap-1">
          Cron (leave empty to use orchestrator default)
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 3 * * *"
            className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="text-xs text-slate-300 flex flex-col gap-1">
          Retention (days, empty = default)
          <input
            type="number"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            placeholder="30"
            className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="text-xs text-slate-300 flex items-center gap-2 col-span-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Automatic backups enabled
          {initial.backupSuspended && (
            <span className="ml-2 text-orange-300">
              (currently suspended after consecutive failures — toggle to re-enable)
            </span>
          )}
        </label>
        <div className="col-span-2 flex items-center justify-between">
          {save.isError && <p className="text-xs text-red-400">{(save.error as Error).message}</p>}
          {save.isSuccess && <p className="text-xs text-emerald-400">Saved.</p>}
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="ml-auto text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-md"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}
