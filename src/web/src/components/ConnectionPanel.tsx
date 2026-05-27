import { useState } from 'react';

interface Props {
  cloudUrl: string;
  adminKey: string;
}

// De-emphasised: for almost all interaction the user opens the Convex
// dashboard. This panel only surfaces what's needed for `npx convex` CLI
// access from the user's own project. Admin key stays hidden until clicked.
export function ConnectionPanel({ cloudUrl, adminKey }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="eyebrow hover:text-[var(--color-ink)] flex items-center gap-2 transition-colors"
      >
        <span className="inline-block w-3 text-[10px]">{open ? '▾' : '▸'}</span>
        CLI Access (.env.local snippet)
      </button>
      {open && <Body cloudUrl={cloudUrl} adminKey={adminKey} />}
    </section>
  );
}

function Body({ cloudUrl, adminKey }: { cloudUrl: string; adminKey: string }) {
  const [copied, setCopied] = useState(false);
  const snippet = `CONVEX_SELF_HOSTED_URL='${cloudUrl}'\nCONVEX_SELF_HOSTED_ADMIN_KEY='${adminKey}'`;

  return (
    <div className="mt-3 card p-4 space-y-3">
      <pre className="bg-[var(--color-paper-3)] border border-[var(--color-rule)] rounded-lg px-3 py-2.5 text-[12px] font-mono text-[var(--color-ink)] whitespace-pre overflow-x-auto">
        {snippet}
      </pre>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(snippet).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="btn btn-ghost"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-[12px] text-[var(--color-muted)] leading-relaxed">
          Drop into your Convex project&apos;s{' '}
          <code className="font-mono text-[var(--color-ink)]">.env.local</code>, then{' '}
          <code className="font-mono text-[var(--color-ink)]">npx convex dev</code>. Treat the admin
          key like a password.
        </span>
      </div>
    </div>
  );
}
