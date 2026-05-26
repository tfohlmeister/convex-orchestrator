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
        className="text-sm uppercase tracking-wide text-slate-400 hover:text-slate-200 flex items-center gap-2"
      >
        <span className="inline-block w-3 text-xs">{open ? '▾' : '▸'}</span>
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
    <div className="mt-2 bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-2">
      <pre className="bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-slate-300 whitespace-pre overflow-x-auto">
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
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-xs text-slate-500">
          Drop into your Convex project&apos;s <code className="text-slate-300">.env.local</code>,
          then <code className="text-slate-300">npx convex dev</code>. Treat the admin key like a
          password.
        </span>
      </div>
    </div>
  );
}
