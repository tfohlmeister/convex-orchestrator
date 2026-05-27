import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface Props {
  open: boolean;
  name: string;
  onClose: () => void;
  onDeleted?: () => void;
}

export function DeleteConfirmDialog({ open, name, onClose, onDeleted }: Props) {
  const [typed, setTyped] = useState('');
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.deleteInstance(name),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['instances'] });
      onClose();
      onDeleted?.();
    },
  });

  if (!open) return null;
  const match = typed === name;

  return (
    <div className="fixed inset-0 bg-[rgba(28,25,23,0.45)] backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-paper)] border border-[var(--color-rule-strong)] border-t-4 border-t-[var(--color-danger)] rounded-xl p-6 w-[32rem] max-w-full shadow-2xl">
        <div className="eyebrow mb-2 text-[var(--color-danger)]">Destructive · irreversible</div>
        <h2 className="font-serif text-[24px] leading-tight text-[var(--color-ink)] mb-4">
          Delete {name}
        </h2>
        <p className="text-[13px] text-[var(--color-muted)] mb-4 leading-relaxed">
          This drops the Postgres schema, deletes all MinIO buckets for this instance, removes
          Traefik routes, and kills the backend process.{' '}
          <strong className="text-[var(--color-danger)]">Irreversible.</strong>
        </p>
        <div className="text-[12px] text-[var(--color-warn)] mb-5 bg-[var(--color-warn-tint)] border border-[color:rgba(180,83,9,0.25)] rounded-lg px-3 py-2.5 leading-relaxed">
          Backups in MinIO will be deleted along with everything else. Download anything you want to
          keep <em className="font-serif">before</em> confirming.
        </div>
        <label className="block text-[12px] text-[var(--color-muted)] mb-1.5">
          Type <code className="font-mono text-[var(--color-ink)]">{name}</code> to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="input"
        />
        {mutation.isError && (
          <p className="text-[12px] text-[var(--color-danger)] mt-2">
            {(mutation.error as Error).message}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            disabled={!match || mutation.isPending}
            onClick={() => mutation.mutate()}
            className="btn"
            style={{
              background: match ? 'var(--color-danger)' : undefined,
              color: match ? '#fff' : undefined,
              borderColor: 'rgba(185, 28, 28, 0.4)',
              borderWidth: '1px',
            }}
          >
            {mutation.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
