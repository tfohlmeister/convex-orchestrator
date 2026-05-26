import { useState } from 'react';

interface Props {
  cloudUrl: string;
  siteUrl: string;
}

// Surfaces both Convex origins for this instance. The cloud URL is the API
// origin (`api.*`, queries/mutations, websockets) and matches CONVEX_URL.
// The site URL is the HTTP Actions origin (`httpAction` routes mounted on
// `/`); Convex split them to keep CORS surfaces separate. Without this
// panel the site URL was reachable but invisible to the user — see the
// instance row's `siteHost` field used to be the only hint.
export function EndpointsPanel({ cloudUrl, siteUrl }: Props) {
  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">Endpoints</h2>
      <div className="bg-slate-900 border border-slate-800 rounded-lg divide-y divide-slate-800">
        <Row label="API (CONVEX_URL)" url={cloudUrl} />
        <Row label="HTTP Actions" url={siteUrl} />
      </div>
    </section>
  );
}

function Row({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="text-xs text-slate-500 w-40 shrink-0">{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-mono text-slate-200 hover:text-emerald-300 truncate flex-1"
      >
        {url}
      </a>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
