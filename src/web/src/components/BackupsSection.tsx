import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken, type Backup, type RestoreJob } from '../api';

const SOURCE_PILL: Record<Backup['source'], string> = {
  auto: 'pill-muted',
  manual: 'pill-info',
  'manual-upload': 'pill-accent',
  'pre-restore': 'pill-warn',
};

const STATUS_PILL: Record<Backup['status'], string> = {
  complete: 'pill-ok',
  running: 'pill-info',
  failed: 'pill-danger',
  stuck: 'pill-warn',
  corrupt: 'pill-danger',
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
      <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h2 className="eyebrow">Backups</h2>
          <p className="text-[11px] text-[var(--color-soft)] mt-1 max-w-md leading-relaxed">
            Captures table data and file storage only. Env vars, schema, functions, crons stay with
            your project (
            <a
              href="https://docs.convex.dev/database/backup-restore"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] hover:text-[var(--color-accent-soft)] transition-colors"
            >
              Convex docs ↗
            </a>
            ).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => triggerBackup.mutate()}
            disabled={triggerBackup.isPending}
            className="btn btn-accent"
          >
            {triggerBackup.isPending ? 'Queuing…' : 'Backup now'}
          </button>
          <button onClick={() => setUploadOpen(true)} className="btn btn-ghost">
            Restore from upload…
          </button>
        </div>
      </div>

      {hasStuckBackup && (
        <div className="mb-4 card-soft p-4 flex items-center justify-between gap-4 border-[color:rgba(180,83,9,0.3)]">
          <div className="text-[13px] text-[var(--color-ink)] leading-relaxed">
            <strong className="text-[var(--color-warn)]">Stuck export detected.</strong> A previous
            backup never finished. The export lock in Convex only clears by restarting the backend
            process.
          </div>
          <button
            onClick={() => forceRestart.mutate()}
            disabled={forceRestart.isPending}
            className="btn btn-ghost shrink-0"
          >
            {forceRestart.isPending ? 'Restarting…' : 'Force restart backend'}
          </button>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[var(--color-rule)]">
              <Th>When</Th>
              <Th>Source</Th>
              <Th>Status</Th>
              <Th>Size</Th>
              <Th>SHA-256</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-rule)]">
            {query.data?.map((b) => (
              <tr key={b.id} className="hover:bg-[var(--color-paper-2)]/60 transition-colors">
                <td className="px-4 py-3 font-mono text-[12px] text-[var(--color-ink)]">
                  {new Date(b.startedAt).toISOString()}
                </td>
                <td className="px-4 py-3">
                  <span className={`pill ${SOURCE_PILL[b.source]}`}>{b.source}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={`pill ${STATUS_PILL[b.status]}`}>{b.status}</span>
                  {b.errorMessage && (
                    <span className="ml-1 text-[var(--color-soft)]" title={b.errorMessage}>
                      ⓘ
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-[var(--color-muted)]">
                  {b.sizeBytes != null ? formatBytes(b.sizeBytes) : '—'}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-[var(--color-soft)]">
                  {b.sha256 ? b.sha256.slice(0, 12) : '—'}
                </td>
                <td className="px-4 py-3 text-right space-x-4 whitespace-nowrap">
                  {b.status === 'complete' && b.targetKey && (
                    <button
                      onClick={() => void downloadBackup(instanceName, b)}
                      className="text-[12px] font-mono uppercase tracking-wider text-[var(--color-ink)] hover:text-[var(--color-accent)] transition-colors"
                    >
                      Download
                    </button>
                  )}
                  {b.status === 'complete' && (
                    <button
                      onClick={() => setRestoreTarget(b)}
                      className="text-[12px] font-mono uppercase tracking-wider text-[var(--color-accent)] hover:text-[var(--color-accent-soft)] transition-colors"
                    >
                      Restore
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete backup ${b.id}?`)) deleteBackup.mutate(b.id);
                    }}
                    className="text-[12px] font-mono uppercase tracking-wider text-[var(--color-danger)] hover:opacity-70 transition-opacity"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {query.data && query.data.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-[var(--color-soft)] text-[13px]"
                >
                  <div className="font-serif italic text-[18px] mb-1 text-[var(--color-muted)]">
                    Nothing here yet.
                  </div>
                  Trigger a backup with <em>Backup now</em>.
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

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-4 py-2.5 ${
        align === 'right' ? 'text-right' : 'text-left'
      } text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-soft)] font-medium`}
    >
      {children}
    </th>
  );
}

async function downloadBackup(instanceName: string, b: Backup): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) (headers as Record<string, string>).authorization = `Bearer ${token}`;
  const res = await fetch(api.downloadBackupUrl(instanceName, b.id), { headers });
  if (!res.ok) {
    // Surface the server's structured error message instead of just the HTTP
    // status — matters most for the 404 "backup not downloadable" and the
    // pre-restore-backup-not-yet-complete case where the user needs to know
    // *why*, not just "failed".
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) detail = body.error;
    } catch {
      // body wasn't JSON; fall back to statusText
    }
    window.alert(`Download failed (HTTP ${res.status}): ${detail}`);
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

// Convex `export`/`import` only covers table data + file storage by design
// (https://docs.convex.dev/database/backup-restore). Env vars, schema, code,
// crons and auth config are NOT in the zip. Surface this on every restore
// confirm so the user can't be surprised that their env vars survived.
function RestoreScopeNotice() {
  return (
    <div className="card-soft p-3 mb-4 text-[12px] leading-relaxed">
      <div className="eyebrow mb-2">What&apos;s restored · what&apos;s not</div>
      <ul className="space-y-1">
        <li className="flex gap-2">
          <span className="text-[var(--color-ok)] font-mono">✓</span>
          <span className="text-[var(--color-ink)]">Table data</span>
        </li>
        <li className="flex gap-2">
          <span className="text-[var(--color-ok)] font-mono">✓</span>
          <span className="text-[var(--color-ink)]">File storage</span>
        </li>
        <li className="flex gap-2">
          <span className="text-[var(--color-danger)] font-mono">✗</span>
          <span className="text-[var(--color-muted)]">
            Environment variables — re-set with{' '}
            <code className="font-mono text-[var(--color-ink)]">npx convex env set</code>
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-[var(--color-danger)] font-mono">✗</span>
          <span className="text-[var(--color-muted)]">
            Schema, functions, crons, auth config — redeploy with{' '}
            <code className="font-mono text-[var(--color-ink)]">npx convex deploy</code>
          </span>
        </li>
      </ul>
      <a
        href="https://docs.convex.dev/database/backup-restore"
        target="_blank"
        rel="noreferrer"
        className="inline-block mt-2 text-[11px] font-mono uppercase tracking-wider text-[var(--color-accent)] hover:text-[var(--color-accent-soft)] transition-colors"
      >
        Convex docs ↗
      </a>
    </div>
  );
}

function DialogShell({
  accentBorder,
  title,
  eyebrow,
  children,
}: {
  accentBorder?: 'warn' | 'accent' | 'danger' | 'default';
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  const borderClass =
    accentBorder === 'warn'
      ? 'border-t-4 border-t-[var(--color-warn)]'
      : accentBorder === 'accent'
        ? 'border-t-4 border-t-[var(--color-accent)]'
        : accentBorder === 'danger'
          ? 'border-t-4 border-t-[var(--color-danger)]'
          : '';
  return (
    <div className="fixed inset-0 bg-[rgba(28,25,23,0.45)] backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        className={`bg-[var(--color-paper)] border border-[var(--color-rule-strong)] rounded-xl p-6 w-[32rem] max-w-full shadow-2xl ${borderClass}`}
      >
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h2 className="font-serif text-[24px] leading-tight text-[var(--color-ink)] mb-4">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
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
    <DialogShell
      accentBorder="warn"
      eyebrow="Destructive · confirm"
      title={`Restore ${instanceName}`}
    >
      <p className="text-[13px] text-[var(--color-muted)] mb-4 leading-relaxed">
        This will <strong className="text-[var(--color-warn)]">replace all current data</strong> for{' '}
        <code className="font-mono text-[var(--color-ink)]">{instanceName}</code> with the contents
        of backup <code className="font-mono text-[var(--color-ink)]">{backup.id.slice(0, 8)}</code>{' '}
        from {new Date(backup.startedAt).toLocaleString()}. A pre-restore backup is taken first as a
        rollback point.
      </p>
      <RestoreScopeNotice />
      <label className="block text-[12px] text-[var(--color-muted)] mb-1.5">
        Type <code className="font-mono text-[var(--color-ink)]">{instanceName}</code> to confirm
      </label>
      <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="input" />
      {restore.isError && (
        <p className="text-[12px] text-[var(--color-danger)] mt-2">
          {(restore.error as Error).message}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="btn btn-ghost">
          Cancel
        </button>
        <button
          disabled={!match || restore.isPending}
          onClick={() => restore.mutate()}
          className="btn btn-accent"
        >
          {restore.isPending ? 'Starting…' : 'Restore'}
        </button>
      </div>
    </DialogShell>
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
      const r = await api.restoreFromUpload(instanceName, file);
      setProgress(100);
      return r;
    },
    onSuccess: (r) => onStarted(r.jobId),
  });
  const match = typed === instanceName;
  const ready = match && file != null && !restore.isPending;

  return (
    <DialogShell
      accentBorder="accent"
      eyebrow="Restore · upload snapshot"
      title="Restore from upload"
    >
      <p className="text-[13px] text-[var(--color-muted)] mb-4 leading-relaxed">
        Upload a Convex snapshot <code className="font-mono text-[var(--color-ink)]">.zip</code>.
        The upload is streamed straight to MinIO; a pre-restore backup is taken before the import.{' '}
        <strong className="text-[var(--color-warn)]">All current data is replaced.</strong>
      </p>
      <RestoreScopeNotice />
      <label className="block text-[12px] text-[var(--color-muted)] mb-1.5">Snapshot zip</label>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-[12px] text-[var(--color-muted)] mb-4 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-[var(--color-rule-strong)] file:bg-[var(--color-paper-2)] file:text-[var(--color-ink)] file:font-mono file:text-[11px] file:uppercase file:tracking-wider hover:file:bg-[var(--color-paper-3)] file:cursor-pointer"
      />
      <label className="block text-[12px] text-[var(--color-muted)] mb-1.5">
        Type <code className="font-mono text-[var(--color-ink)]">{instanceName}</code> to confirm
      </label>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} className="input" />
      {progress != null && progress < 100 && (
        <p className="text-[12px] text-[var(--color-muted)] mt-2">Uploading…</p>
      )}
      {restore.isError && (
        <p className="text-[12px] text-[var(--color-danger)] mt-2">
          {(restore.error as Error).message}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="btn btn-ghost">
          Cancel
        </button>
        <button disabled={!ready} onClick={() => restore.mutate()} className="btn btn-accent">
          {restore.isPending ? 'Uploading…' : 'Upload and restore'}
        </button>
      </div>
    </DialogShell>
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
  const tone =
    job.status === 'failed' ? 'pill-danger' : job.status === 'complete' ? 'pill-ok' : 'pill-info';
  return (
    <DialogShell eyebrow="Restore · in progress" title="Restore job">
      <p className="text-[11px] text-[var(--color-soft)] mb-3 font-mono">{jobId}</p>
      <span className={`pill ${tone}`}>{job.status}</span>
      {job.preRestoreBackupId && (
        <p className="text-[12px] text-[var(--color-muted)] mt-4">
          Pre-restore backup:{' '}
          <code className="font-mono text-[var(--color-ink)]">
            {job.preRestoreBackupId.slice(0, 8)}
          </code>
        </p>
      )}
      {job.error && <p className="text-[12px] text-[var(--color-danger)] mt-2">{job.error}</p>}
      <div className="flex justify-end mt-6">
        <button onClick={onDismiss} className="btn btn-ghost">
          {done ? 'Close' : 'Dismiss'}
        </button>
      </div>
    </DialogShell>
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
      <h2 className="eyebrow mb-3">Backup settings</h2>
      <div className="card p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
        <label className="block">
          <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-soft)] mb-1.5">
            Cron schedule
          </div>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 3 * * *"
            className="input"
          />
          <div className="text-[11px] text-[var(--color-soft)] mt-1.5 leading-relaxed">
            Empty falls back to the orchestrator default.
          </div>
        </label>
        <label className="block">
          <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-soft)] mb-1.5">
            Retention (days)
          </div>
          <input
            type="number"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            placeholder="30"
            className="input"
          />
          <div className="text-[11px] text-[var(--color-soft)] mt-1.5 leading-relaxed">
            Empty falls back to the orchestrator default.
          </div>
        </label>
        <label className="md:col-span-2 flex items-center gap-2.5 text-[13px] text-[var(--color-ink)] cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-accent)]"
          />
          Automatic backups enabled
          {initial.backupSuspended && (
            <span className="ml-2 text-[12px] text-[var(--color-warn)]">
              (currently suspended after consecutive failures — toggle to re-enable)
            </span>
          )}
        </label>
        <div className="md:col-span-2 flex items-center justify-between flex-wrap gap-3">
          {save.isError && (
            <p className="text-[12px] text-[var(--color-danger)]">
              {(save.error as Error).message}
            </p>
          )}
          {save.isSuccess && <p className="text-[12px] text-[var(--color-ok)]">Saved.</p>}
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="btn btn-primary ml-auto"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}
