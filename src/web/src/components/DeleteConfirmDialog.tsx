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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-red-700/60 rounded-lg p-6 w-[28rem]">
        <h2 className="text-lg font-semibold mb-2 text-red-300">Delete {name}</h2>
        <p className="text-sm text-slate-400 mb-4">
          This drops the Postgres schema, deletes all MinIO buckets for this instance, removes
          Traefik routes, and kills the backend process.{' '}
          <strong className="text-red-300">Irreversible.</strong>
        </p>
        <p className="text-xs text-amber-300 mb-4 bg-amber-900/30 border border-amber-700/50 rounded-md px-3 py-2">
          Backups in MinIO will be deleted along with everything else. Download anything you want to
          keep <em>before</em> confirming.
        </p>
        <label className="block text-sm text-slate-300 mb-1">
          Type <code className="font-mono">{name}</code> to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm font-mono"
        />
        {mutation.isError && (
          <p className="text-xs text-red-400 mt-2">{(mutation.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-300">
            Cancel
          </button>
          <button
            disabled={!match || mutation.isPending}
            onClick={() => mutation.mutate()}
            className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md"
          >
            {mutation.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
