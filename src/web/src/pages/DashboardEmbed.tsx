import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

// Embed the official Convex dashboard in an iframe and reply to its
// `dashboard-credentials-request` postMessage with this instance's credentials.
// This is the documented embedding API (see Convex docs § Embedding the
// dashboard); it skips the login form entirely.
export function DashboardEmbedPage() {
  const { name = '' } = useParams();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);

  const query = useQuery({
    queryKey: ['instance', name],
    queryFn: () => api.getInstance(name),
    enabled: !!name,
  });

  useEffect(() => {
    if (!query.data) return;
    const inst = query.data.instance;
    const handler = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type !== 'dashboard-credentials-request') {
        return;
      }
      ref.current?.contentWindow?.postMessage(
        {
          type: 'dashboard-credentials',
          adminKey: inst.adminKey,
          deploymentUrl: inst.cloudUrl,
          deploymentName: inst.name,
        },
        '*',
      );
      setReady(true);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [query.data]);

  if (query.isLoading) {
    return <p className="text-[var(--color-soft)] text-sm p-6">Loading…</p>;
  }
  if (query.error) {
    return (
      <p className="text-[var(--color-danger)] text-sm p-6">{(query.error as Error).message}</p>
    );
  }
  if (!query.data) return null;

  // Reuse the scheme + port the user came in on, so the iframe lands on the
  // same reverse proxy (HTTPS in production, http://...:18000 in HTTP spikes).
  const port = window.location.port ? `:${window.location.port}` : '';
  const dashboardOrigin = `${window.location.protocol}//dashboard.${query.data.instance.baseDomain}${port}`;

  return (
    <div className="fixed inset-0 flex flex-col bg-[var(--color-paper)]">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-rule)] bg-[var(--color-paper)]/85 backdrop-blur-md">
        <Link
          to="/instances"
          className="text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-soft)] hover:text-[var(--color-ink)] transition-colors"
        >
          Instances
        </Link>
        <span className="text-[var(--color-soft)]/50">/</span>
        <Link
          to={`/instances/${name}`}
          className="text-[13px] font-mono text-[var(--color-soft)] hover:text-[var(--color-ink)] transition-colors"
        >
          {name}
        </Link>
        <span className="text-[var(--color-soft)]/50">/</span>
        <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--color-ink)] relative">
          Dashboard
          <span
            aria-hidden
            className="absolute left-0 right-0 -bottom-[9px] h-[2px] bg-[var(--color-accent)] rounded"
          />
        </span>
        <span className="ml-auto text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-soft)] flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              ready ? 'bg-[var(--color-ok)]' : 'bg-[var(--color-warn)] animate-pulse'
            }`}
          />
          {ready ? 'credentials handed off' : 'waiting for iframe handshake…'}
        </span>
      </div>
      <iframe
        ref={ref}
        title={`Convex Dashboard: ${name}`}
        src={dashboardOrigin}
        className="flex-1 w-full border-0"
        allow="clipboard-write"
      />
    </div>
  );
}
