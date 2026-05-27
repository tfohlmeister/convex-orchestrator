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
    <div className="fixed inset-0 bg-[rgba(28,25,23,0.45)] backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-paper)] border border-[var(--color-rule-strong)] border-t-4 border-t-[var(--color-accent)] rounded-xl p-6 w-[30rem] max-w-full shadow-2xl">
        <div className="eyebrow mb-2">Create</div>
        <h2 className="font-serif text-[24px] leading-tight text-[var(--color-ink)] mb-5">
          New instance
        </h2>
        <label className="block text-[12px] text-[var(--color-muted)] mb-1.5">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="masterev-dev"
          className="input"
        />
        <p className="text-[11px] text-[var(--color-soft)] mt-1.5">
          lowercase-kebab-case, 3-32 chars, starts with a letter
        </p>
        {error && <p className="text-[12px] text-[var(--color-danger)] mt-2">{error}</p>}
        {mutation.isPending && (
          <ol className="mt-5 space-y-1.5">
            {STEPS.map((step, idx) => (
              <li
                key={step}
                className="flex items-center gap-2.5 text-[12px] text-[var(--color-muted)] font-mono"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                <span className="text-[var(--color-soft)] uppercase tracking-wider text-[10px]">
                  Step {idx + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
            <li className="text-[11px] text-[var(--color-soft)] mt-2 italic font-serif">
              The create flow runs server-side; the page will refresh when ready.
            </li>
          </ol>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="btn btn-ghost" disabled={mutation.isPending}>
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate(name)}
            disabled={!nameValid || mutation.isPending}
            className="btn btn-accent"
          >
            {mutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
