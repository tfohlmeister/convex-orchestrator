import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

interface Props {
  instanceName: string;
  // Persisted displayName from the server. null means "fall back to the
  // slug" — we show slug as the title text in that case but keep the
  // edit affordance available.
  displayName: string | null;
}

// Click-to-edit title. Renders displayName (or the instance slug as a
// fallback) in serif and provides a small ✎ button to enter edit mode.
// Enter saves, Escape cancels. Submitting an empty string clears the
// label back to null.
export function EditableTitle({ instanceName, displayName }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (next: string) => api.setDisplayName(instanceName, next),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['instance', instanceName] });
      await qc.invalidateQueries({ queryKey: ['instances'] });
      setEditing(false);
    },
  });

  useEffect(() => {
    setValue(displayName ?? '');
  }, [displayName]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const titleText = displayName?.trim() || instanceName;

  if (editing) {
    return (
      <form
        className="inline-flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(value);
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setValue(displayName ?? '');
              setEditing(false);
            }
          }}
          placeholder={instanceName}
          maxLength={64}
          className="input font-serif text-[32px] py-1 px-2"
          disabled={mutation.isPending}
        />
        <button type="submit" className="btn btn-accent btn-sm" disabled={mutation.isPending}>
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setValue(displayName ?? '');
            setEditing(false);
          }}
          disabled={mutation.isPending}
        >
          Cancel
        </button>
        {mutation.error && (
          <span className="text-[12px] text-[var(--color-danger)]">
            {mutation.error instanceof ApiError ? mutation.error.message : String(mutation.error)}
          </span>
        )}
      </form>
    );
  }

  return (
    <span className="inline-flex items-baseline gap-3">
      <span>{titleText}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit name"
        aria-label="Edit name"
        className="text-[14px] text-[var(--color-soft)] hover:text-[var(--color-ink)] transition-colors"
      >
        ✎
      </button>
    </span>
  );
}
