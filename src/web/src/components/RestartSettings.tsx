import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

// Scheduled backend restart. Self-hosted Convex does not release the Node
// executor's V8/heap memory at runtime, so a long-lived backend grows
// unbounded; restarting it on a cron reclaims that memory. Opt-in per
// instance. Mirrors BackupSettings.
export function RestartSettings({
  instanceName,
  initial,
}: {
  instanceName: string;
  initial: {
    restartCron: string | null;
    restartEnabled: boolean | null;
  };
}) {
  const qc = useQueryClient();
  const [cron, setCron] = useState(initial.restartCron ?? '');
  const [enabled, setEnabled] = useState<boolean>(initial.restartEnabled ?? false);
  const save = useMutation({
    mutationFn: () =>
      api.updateRestartConfig(instanceName, {
        restartCron: cron.trim() === '' ? null : cron.trim(),
        restartEnabled: enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instance', instanceName] }),
  });
  return (
    <section>
      <h2 className="eyebrow mb-3">Scheduled restart</h2>
      <p className="text-[11px] text-[var(--color-soft)] mb-3 max-w-xl leading-relaxed">
        Self-hosted Convex does not free the executor&apos;s memory at runtime, so a long-lived
        backend grows until it&apos;s restarted. A daily restart reclaims it. The restart also reaps
        the orphaned executor process, briefly interrupting the backend (a few seconds).
      </p>
      <div className="card p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
        <label className="block">
          <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-soft)] mb-1.5">
            Cron schedule
          </div>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 4 * * *"
            className="input"
          />
          <div className="text-[11px] text-[var(--color-soft)] mt-1.5 leading-relaxed">
            Local time. Empty falls back to the orchestrator default (04:00 daily).
          </div>
        </label>
        <label className="md:col-span-2 flex items-center gap-2.5 text-[13px] text-[var(--color-ink)] cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-accent)]"
          />
          Scheduled restart enabled
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
