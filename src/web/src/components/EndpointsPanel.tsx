import { useState } from 'react';

interface Props {
  cloudUrl: string;
  siteUrl: string;
}

// Surfaces both Convex origins for this instance. The cloud URL is the API
// origin (`api.*`, queries/mutations, websockets) and matches CONVEX_URL.
// The site URL is the HTTP Actions origin (`httpAction` routes mounted on
// `/`); Convex split them to keep CORS surfaces separate.
export function EndpointsPanel({ cloudUrl, siteUrl }: Props) {
  return (
    <section>
      <SectionHeading>Endpoints</SectionHeading>
      <div className="card divide-y divide-[var(--color-rule)]">
        <Row label="API" sublabel="CONVEX_URL" url={cloudUrl} />
        <Row label="HTTP Actions" sublabel="httpAction routes" url={siteUrl} />
      </div>
    </section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="eyebrow mb-3">{children}</h2>;
}

function Row({ label, sublabel, url }: { label: string; sublabel: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="w-40 shrink-0">
        <div className="text-[13px] text-[var(--color-ink)] font-medium leading-tight">{label}</div>
        <div className="text-[10px] font-mono text-[var(--color-soft)] tracking-wide uppercase mt-0.5">
          {sublabel}
        </div>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-[13px] font-mono text-[var(--color-ink)] hover:text-[var(--color-accent)] truncate flex-1 transition-colors"
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
        className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-soft)] hover:text-[var(--color-ink)] transition-colors"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
