import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

const STEPS = ['Validating', 'Schema', 'Buckets', 'AdminKey', 'Spawn', 'Routes', 'Ready'] as const;

// Convex-SaaS-style instance name generator: <adjective>-<animal>-<3-digit>.
// Combined space is ~30 * 30 * 900 = ~810k names, which is plenty for the
// "click again until you like it" UX. Pure client-side, no API call.
const ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'breezy',
  'bright',
  'calm',
  'cosy',
  'eager',
  'fancy',
  'frosty',
  'gentle',
  'happy',
  'jolly',
  'kind',
  'lucky',
  'merry',
  'mighty',
  'neat',
  'noble',
  'quiet',
  'rapid',
  'royal',
  'silent',
  'sunny',
  'swift',
  'tiny',
  'warm',
  'wise',
  'witty',
  'zesty',
];

const ANIMALS = [
  'badger',
  'beaver',
  'bison',
  'crane',
  'falcon',
  'ferret',
  'fox',
  'gecko',
  'hawk',
  'heron',
  'koala',
  'lemur',
  'lynx',
  'moose',
  'newt',
  'otter',
  'owl',
  'panda',
  'puma',
  'quokka',
  'rabbit',
  'raven',
  'seal',
  'sloth',
  'swan',
  'tiger',
  'wallaby',
  'walrus',
  'wolf',
  'wombat',
];

function generateName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]!;
  const num = Math.floor(Math.random() * 900) + 100; // 100-999
  return `${a}-${n}-${num}`;
}

export function NewInstanceModal({ open, onClose }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  // Pre-generate a slug suggestion when the dialog opens. The user can
  // accept it, regenerate via the refresh button, or overwrite with
  // their own (e.g. by copying the display name as a kebab-case slug).
  useEffect(() => {
    if (open && !slug) setSlug(generateName());
  }, [open, slug]);

  const mutation = useMutation({
    mutationFn: ({ slug, displayName }: { slug: string; displayName: string }) =>
      api.createInstance(slug, displayName.trim() || undefined),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['instances'] });
      onClose();
      setDisplayName('');
      setSlug('');
    },
    onError: (err: Error) => {
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  if (!open) return null;
  const slugValid = NAME_RE.test(slug);
  const canSubmit = slugValid && !mutation.isPending;

  return (
    <div className="fixed inset-0 bg-[rgba(28,25,23,0.45)] backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) mutation.mutate({ slug, displayName });
        }}
        className="bg-[var(--color-paper)] border border-[var(--color-rule-strong)] border-t-4 border-t-[var(--color-accent)] rounded-xl p-6 w-[30rem] max-w-full shadow-2xl"
      >
        <div className="eyebrow mb-2">Create</div>
        <h2 className="font-serif text-[24px] leading-tight text-[var(--color-ink)] mb-5">
          New instance
        </h2>
        <label className="block text-[12px] text-[var(--color-muted)] mb-1.5">Name</label>
        <input
          autoFocus
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setError(null);
          }}
          placeholder="My App"
          maxLength={64}
          className="input w-full"
        />
        <p className="text-[11px] text-[var(--color-soft)] mt-1.5">
          Human label shown in the UI. Editable later. Optional.
        </p>
        <label className="block text-[12px] text-[var(--color-muted)] mb-1.5 mt-4">URL slug</label>
        <div className="flex gap-2">
          <input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setError(null);
            }}
            placeholder="lucky-otter-123"
            className="input flex-1 font-mono"
          />
          <button
            type="button"
            onClick={() => {
              setSlug(generateName());
              setError(null);
            }}
            disabled={mutation.isPending}
            title="Generate a random slug"
            aria-label="Generate a random slug"
            className="btn btn-ghost px-3"
          >
            <span aria-hidden>↻</span>
          </button>
        </div>
        <p className="text-[11px] text-[var(--color-soft)] mt-1.5">
          Lands in &lt;slug&gt;.&lt;base-domain&gt;. Lowercase-kebab-case, 3-32 chars, starts with a
          letter. Fixed after create.
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
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
            disabled={mutation.isPending}
          >
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} className="btn btn-accent">
            {mutation.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
