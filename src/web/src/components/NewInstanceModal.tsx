import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

const STEPS = ['Validating', 'Schema', 'Buckets', 'AdminKey', 'Spawn', 'Routes', 'Ready'] as const;

export function NewInstanceModal({ open, onClose }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (n: string) => api.createInstance(n),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['instances'] });
      onClose();
      setName('');
    },
    onError: (err: Error) => {
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  if (!open) return null;
  const nameValid = NAME_RE.test(name);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-[28rem]">
        <h2 className="text-lg font-semibold mb-4">New instance</h2>
        <label className="block text-sm text-slate-300 mb-1">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="masterev-dev"
          className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm font-mono"
        />
        <p className="text-xs text-slate-500 mt-1">
          lowercase-kebab-case, 3-32 chars, starts with a letter
        </p>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        {mutation.isPending && (
          <ol className="mt-4 space-y-1">
            {STEPS.map((step, idx) => (
              <li key={step} className="flex items-center gap-2 text-sm text-slate-400">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                Step {idx + 1}: {step}
              </li>
            ))}
            <li className="text-xs text-slate-500 mt-2">
              The create flow runs server-side; the page will refresh when ready.
            </li>
          </ol>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white"
            disabled={mutation.isPending}
          >
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate(name)}
            disabled={!nameValid || mutation.isPending}
            className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md"
          >
            {mutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
